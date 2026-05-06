import OpenAI from "openai";
import type { SummaryOutput, SuggestedRepliesOutput } from "@inbox-os/core";
import { z } from "zod";
import { runnerConfig } from "../config";
import { safeTruncate, stripUnpairedSurrogates } from "../platforms/utils";
import type { AiService } from "../types/runtime";

const summarySchema = z.object({
  summary: z.string(),
  what_they_want: z.string(),
  open_loops: z.array(z.string()),
  tone_notes: z.array(z.string()).default([]),
  needs_reply: z.boolean(),
  urgency_hint: z.string().optional()
});

/**
 * Classify an OpenAI SDK error into a human-readable hint. The OpenAI SDK
 * surfaces structured `code`/`status` fields on its error objects; using them
 * lets the operator distinguish the three common dead-ends — out of credits,
 * unknown model, missing key — without having to grep the message verbatim.
 *
 * Returns a single string ready to splice into a `console.warn` line.
 */
export function classifyOpenAiError(error: unknown): string {
  // Defensive duck-typing against `OpenAI.APIError`. We deliberately don't
  // import the type so a future SDK upgrade that renames the class doesn't
  // silently bypass this branch.
  const err = error as { code?: string; status?: number; message?: string } | undefined;
  const message = err?.message ?? String(error);
  const code = err?.code;
  const status = err?.status;
  if (code === "insufficient_quota" || status === 429) {
    return (
      "Reason: OpenAI account is out of credits (insufficient_quota / 429). " +
      "Top up at https://platform.openai.com/settings/organization/billing/overview, then retry."
    );
  }
  if (code === "model_not_found" || /model.*(not found|does not exist)/i.test(message)) {
    return `Reason: model not available to this account (${message}). Set OPENAI_MODEL to one your account has access to (e.g. gpt-4o-mini, gpt-4o, o1, o3-mini).`;
  }
  if (status === 401 || code === "invalid_api_key") {
    return "Reason: OPENAI_API_KEY is missing or invalid. Set it in .env and restart the runner.";
  }
  return `Reason: ${message}.`;
}

const repliesSchema = z.object({
  replies: z.array(
    z.object({
      label: z.enum(["A", "B", "C"]),
      intent: z.string(),
      text: z.string()
    })
  ),
  needs_user_input: z.array(z.string()).default([])
});

/**
 * GPT-5 family parameters that aren't (yet) typed in the OpenAI SDK we ship.
 * `reasoning_effort: "none"` and `verbosity` are valid at the API layer but
 * the npm SDK type catalog hasn't caught up — we cast at the call site rather
 * than hard-pin a newer SDK in the same change. `none` skips reasoning tokens
 * entirely, which is the right pick for our two short-form generations
 * (summary / 3 reply drafts) and one-shot rewrites (shorten / make warmer);
 * none of those benefit from chain-of-thought.
 *
 * Configuration mirrors the values the operator picked in the OpenAI dashboard:
 *   Top P 0.98, Reasoning effort none, Verbosity medium.
 * Override per-call by passing overrides into the spread.
 */
const gpt5DefaultOptions = {
  top_p: 0.98,
  reasoning_effort: "none" as const,
  verbosity: "medium" as const
};

// Cast helper so the SDK type-checker doesn't reject the GPT-5 options it
// doesn't yet know about. Localised here so a future SDK upgrade can drop it.
type Gpt5RequestOverrides = Record<string, unknown>;

export function createAiService(): AiService {
  const client = runnerConfig.openAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.openAiApiKey })
    : null;

  async function modelJson<T>(prompt: string, fallback: T, parser: (value: unknown) => T): Promise<T> {
    if (!client) {
      return fallback;
    }

    try {
      const response = await client.chat.completions.create({
        model: runnerConfig.openAiModel,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a concise relationship assistant. Use British English. Keep outputs practical, calm, and grounded in evidence."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        // GPT-5 family knobs. JSON-mode response_format above forces strict
        // JSON output; gpt-5.4 honours both response_format and verbosity.
        ...(gpt5DefaultOptions as Gpt5RequestOverrides)
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn(
          `[ai] OpenAI returned empty content (model=${runnerConfig.openAiModel}); using fallback. ` +
            `Set OPENAI_MODEL to a model your account has access to (e.g. gpt-4o-mini).`
        );
        return fallback;
      }

      return parser(JSON.parse(content));
    } catch (error) {
      console.warn(
        `[ai] OpenAI call failed (model=${runnerConfig.openAiModel}); using fallback. ${classifyOpenAiError(error)}`
      );
      return fallback;
    }
  }

  async function updateThreadSummary(input: {
    displayName: string;
    previousSummary?: string;
    previousOpenLoops: string[];
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
  }): Promise<SummaryOutput> {
    const lastInbound = [...input.messages].reverse().find((msg) => msg.direction === "IN");
    const lastMessage = input.messages[input.messages.length - 1];

    const fallback: SummaryOutput = {
      summary: input.previousSummary ?? `Conversation with ${input.displayName}.`,
      // safeTruncate splits on Unicode code points so a 140-char cut won't
      // bisect an emoji's surrogate pair. Without it, a message ending in
      // an emoji at the boundary corrupts every subsequent prisma.thread
      // .update — see Sarah Nwisi sync-fail bug.
      what_they_want: lastInbound ? safeTruncate(lastInbound.text, 140) : "No clear ask yet.",
      open_loops: input.previousOpenLoops,
      tone_notes: [],
      needs_reply: lastMessage?.direction === "IN",
      urgency_hint: undefined
    };

    // Explicit schema in the prompt: gpt-5.4 honours response_format json_object
    // but interprets loose schemas creatively (returning {A,B,C} instead of
    // {replies:[{label,intent,text}]}). Spelling out the exact shape — keys,
    // types, and an example — keeps the zod parser at the call site happy.
    const prompt = `Return strict JSON matching this exact shape:
{
  "summary": "string — 1-2 sentence rolling summary of the relationship",
  "what_they_want": "string — what the other person is asking for, in their words",
  "open_loops": ["string", ...],
  "tone_notes": ["string", ...],
  "needs_reply": true | false,
  "urgency_hint": "string or omit if none"
}

Previous summary: ${input.previousSummary ?? "None"}
Previous open loops: ${JSON.stringify(input.previousOpenLoops)}
Messages: ${JSON.stringify(input.messages)}`;

    return modelJson(prompt, fallback, (value) => summarySchema.parse(value));
  }

  async function generateSuggestedReplies(input: {
    summary: string;
    whatTheyWant: string;
    openLoops: string[];
    lastInboundMessage: string;
  }): Promise<SuggestedRepliesOutput> {
    const fallback: SuggestedRepliesOutput = {
      replies: [
        {
          label: "A",
          intent: "Direct + helpful",
          text: "Thanks for the note. To be honest, that works for us."
        },
        {
          label: "B",
          intent: "Warm + relationship-first",
          text: "Appreciate you reaching out. Happy to keep this moving this week."
        },
        {
          label: "C",
          intent: "Clarifying question",
          text: "Before we confirm, could you share the preferred timeline?"
        }
      ],
      needs_user_input: []
    };

    // Explicit schema — see the matching note in updateThreadSummary above.
    // gpt-5.4 will otherwise return {A,B,C} as top-level keys instead of the
    // {replies:[{label,intent,text}]} shape the zod parser expects.
    const prompt = `Return strict JSON matching this exact shape:
{
  "replies": [
    { "label": "A", "intent": "Direct + helpful", "text": "..." },
    { "label": "B", "intent": "Warm + relationship-first", "text": "..." },
    { "label": "C", "intent": "Clarifying question", "text": "..." }
  ],
  "needs_user_input": ["string", ...]
}

Each reply text must be a complete, sendable message under 280 characters,
written in British English. Vary the three intents as suggested.

Summary: ${input.summary}
What they want: ${input.whatTheyWant}
Open loops: ${JSON.stringify(input.openLoops)}
Last inbound: ${input.lastInboundMessage}`;

    return modelJson(prompt, fallback, (value) => repliesSchema.parse(value));
  }

  async function transformReply(input: { mode: "SHORTEN" | "MAKE_WARMER"; text: string }): Promise<string> {
    if (!client) {
      return input.text;
    }

    try {
      const instruction =
        input.mode === "SHORTEN"
          ? "Shorten this message to <= 160 characters while preserving intent."
          : "Make this message warmer while preserving intent and keeping it concise.";

      const response = await client.chat.completions.create({
        model: runnerConfig.openAiModel,
        messages: [
          {
            role: "system",
            content: "Use British English. Keep it natural and professional."
          },
          {
            role: "user",
            content: `${instruction}\n\n${input.text}`
          }
        ],
        // No response_format: this returns plain text, matching the operator's
        // "Response: text" config in the OpenAI dashboard.
        ...(gpt5DefaultOptions as Gpt5RequestOverrides)
      });

      return response.choices[0]?.message?.content?.trim() || input.text;
    } catch (error) {
      console.warn(
        `[ai] transformReply failed (model=${runnerConfig.openAiModel}, mode=${input.mode}); returning original text. ${classifyOpenAiError(error)}`
      );
      return input.text;
    }
  }

  return {
    updateThreadSummary,
    generateSuggestedReplies,
    transformReply
  };
}
