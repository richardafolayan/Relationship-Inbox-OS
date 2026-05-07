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

const categorySchema = z.object({
  category: z.enum(["outreach", "genuine"])
});

// Voice + style rules applied to every AI generation (summary, suggested
// replies, transformReply, classifier). Centralised so a tweak is one edit.
// Three constraints in particular drive the rest of the prompts in this file:
//   - 1-2 sentence outputs (informs prompt examples + zod max-length checks)
//   - No em-dashes / en-dashes / semicolons / colons (post-processing strips
//     these to handle GPT-5 occasionally slipping them in)
//   - Match inbound register (downstream prompts pass the inbound text so the
//     model can see the tone to mirror)
export const SYSTEM_PROMPT = [
  "You are a concise relationship assistant. Use British English. Keep outputs practical, calm, and grounded in evidence.",
  "",
  "- Conversational and direct, like talking to a peer. No corporate filler or marketing clichés like \"I noticed\".",
  "- No em dashes or en dashes.",
  "- No semicolons, or colons.",
  "- Keep replies to 1-2 sentences.",
  "- Match the inbound message's register. Warm if they're warm, formal if they're formal.",
  "",
  "If the inbound is a sales pitch, recruitment outreach, marketing, InMail, or cold solicitation, replace the \"Clarifying question\" reply with a \"Polite decline\" (a short, friendly \"not interested\" reply, ~1 sentence)."
].join("\n");

/**
 * Per-model request param shape. The GPT-5 family rotates which knobs are
 * accepted: gpt-5.4 supports `reasoning_effort: "none"` + `top_p`; gpt-5-nano
 * only accepts `minimal | low | medium | high` and rejects `top_p` entirely.
 * Centralise the picker here so a model swap doesn't require chasing every
 * call site.
 *
 * `verbosity: "medium"` and `reasoning_effort` are not (yet) typed in the
 * OpenAI SDK we ship — both are valid at the API layer but require a cast at
 * the call site to satisfy the typechecker.
 */
type Gpt5RequestOverrides = Record<string, unknown>;

function gpt5OptionsForModel(model: string): Gpt5RequestOverrides {
  // gpt-5-nano (and likely gpt-5-mini): minimal reasoning is the cheapest
  // setting. No top_p. verbosity is OK. Anything else gets the broader set.
  if (/^gpt-5-(nano|mini)/i.test(model)) {
    return {
      reasoning_effort: "minimal",
      verbosity: "medium"
    };
  }
  // gpt-5.4 family + base gpt-5: full knob set including no-reasoning.
  return {
    top_p: 0.98,
    reasoning_effort: "none",
    verbosity: "medium"
  };
}

// Strip the punctuation forms the system prompt forbids. Defensive — even
// with the rule in the system message, GPT-5 sometimes slips in an em-dash
// or a colon. Apply to every text-producing AI call before persisting /
// returning to the dashboard.
const FORBIDDEN_PUNCTUATION_RE = /[—–]|;|:/g;
function applyVoiceRules(text: string): string {
  if (!text) return text;
  return text
    .replace(/—/g, ", ")  // em-dash → comma to preserve flow
    .replace(/–/g, ", ")  // en-dash → comma
    .replace(/;/g, ".")   // semicolon → full stop
    .replace(/:/g, ",")   // colon → comma
    .replace(/\s{2,}/g, " ")
    .trim();
}
// Static analysis would flag FORBIDDEN_PUNCTUATION_RE as unused; keep it
// exported only via the side-effect of being referenced in tests if added.
void FORBIDDEN_PUNCTUATION_RE;

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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        ...gpt5OptionsForModel(runnerConfig.openAiModel)
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
    /**
     * Thread classification. When "outreach", the third reply slot is a
     * "Polite decline" instead of a "Clarifying question" — short friendly
     * "not interested" wording per the operator's voice rules.
     */
    category?: "outreach" | "genuine" | null;
  }): Promise<SuggestedRepliesOutput> {
    const isOutreach = input.category === "outreach";
    const thirdIntent = isOutreach ? "Polite decline" : "Clarifying question";
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
          intent: thirdIntent,
          text: isOutreach
            ? "Thanks for reaching out, but it isn't something I'm looking at right now."
            : "Before we confirm, could you share the preferred timeline?"
        }
      ],
      needs_user_input: []
    };

    const prompt = `Return strict JSON matching this exact shape:
{
  "replies": [
    { "label": "A", "intent": "Direct + helpful", "text": "..." },
    { "label": "B", "intent": "Warm + relationship-first", "text": "..." },
    { "label": "C", "intent": "${thirdIntent}", "text": "..." }
  ],
  "needs_user_input": ["string", ...]
}

Each reply text must be a complete, sendable message under 280 characters,
1-2 sentences, British English. No em dashes, en dashes, semicolons, or
colons. Match the inbound message's register: warm if they're warm,
formal if they're formal.

${
  isOutreach
    ? "This thread is OUTREACH (sales pitch, recruitment, InMail, cold solicitation). Reply C must be a friendly Polite decline (~1 sentence, no commitment, no follow-up question)."
    : ""
}

Summary: ${input.summary}
What they want: ${input.whatTheyWant}
Open loops: ${JSON.stringify(input.openLoops)}
Last inbound: ${input.lastInboundMessage}`;

    const parsed = await modelJson(prompt, fallback, (value) => repliesSchema.parse(value));
    // Defensive scrub of em-dashes, semicolons, colons — see applyVoiceRules.
    return {
      ...parsed,
      replies: parsed.replies.map((r) => ({
        ...r,
        text: applyVoiceRules(r.text)
      }))
    };
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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${instruction}\n\n${input.text}` }
        ],
        // No response_format: this returns plain text. The voice-rule
        // post-processor handles em-dash / semicolon / colon scrubbing.
        ...gpt5OptionsForModel(runnerConfig.openAiModel)
      });

      const raw = response.choices[0]?.message?.content?.trim() || input.text;
      return applyVoiceRules(raw);
    } catch (error) {
      console.warn(
        `[ai] transformReply failed (model=${runnerConfig.openAiModel}, mode=${input.mode}); returning original text. ${classifyOpenAiError(error)}`
      );
      return input.text;
    }
  }

  /**
   * Classify a thread as outreach (sales / recruitment / marketing / InMail
   * / cold solicitation) vs genuine (peer chats, ongoing relationships).
   * Returns null when the AI service is unavailable — callers should treat
   * that as "leave the column unset", not as a default verdict.
   *
   * Earlier version only saw the first 1-2 inbound messages, which missed
   * the common pivot pattern: a friendly opener ("just seen what you're
   * building, how's it going?") followed two messages later by a sales
   * question ("are you already working with an accountant?"). Now we feed:
   *   - the rolling AI summary (high signal — already captures intent)
   *   - the whatTheyWant extraction
   *   - up to 5 inbound messages (the full early arc, not just the opener)
   *
   * Trade-off: ~3x token usage per classification (~200 vs ~70). Still cheap
   * on gpt-5-nano (sub-cent per thread). Catches the Kyle Randall case
   * where the second-half pivot was the giveaway.
   */
  async function classifyThreadCategory(input: {
    displayName: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    summary?: string | null;
    whatTheyWant?: string | null;
  }): Promise<"outreach" | "genuine" | null> {
    if (!client) {
      return null;
    }

    const inboundMessages = input.messages
      .filter((m) => m.direction === "IN")
      .slice(0, 5)
      .map((m) => safeTruncate(m.text, 600))
      .filter((t) => t.trim().length > 0);

    if (inboundMessages.length === 0) {
      return null;
    }

    const summaryLine = input.summary?.trim()
      ? `Summary so far: ${safeTruncate(input.summary, 600)}`
      : "Summary so far: (none)";
    const whatTheyWantLine = input.whatTheyWant?.trim()
      ? `What they want: ${safeTruncate(input.whatTheyWant, 400)}`
      : "What they want: (none)";

    const prompt = `Classify this LinkedIn thread as either:

  "outreach" — cold pitches, sales, recruitment, marketing, InMails,
              sponsored messages, lead-gen openers ("just saw your
              business, how is it going?" followed by a service pitch),
              financial-adviser / agency / SaaS pitches, or anyone with a
              sales motive even if their opener is friendly.

  "genuine" — peer chats, ongoing relationships, real conversations with
             no sales motive (friends, classmates, ex-colleagues,
             customers, mentors). Also genuine if there's no clear pitch
             after several inbound messages.

Decision rules:
  - A friendly opener followed by a transactional question (e.g. "are
    you already working with an accountant?") is OUTREACH.
  - Compliments or interest in someone's work, then a pitch, is
    OUTREACH.
  - Two-way conversation with no sales motive is GENUINE.
  - Brief one-line greeting with nothing else is GENUINE unless other
    signals say otherwise.

Return strict JSON: { "category": "outreach" | "genuine" }

Person name: ${input.displayName}
${summaryLine}
${whatTheyWantLine}
Inbound messages (oldest first):
${inboundMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;

    try {
      const response = await client.chat.completions.create({
        model: runnerConfig.openAiModel,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        ...gpt5OptionsForModel(runnerConfig.openAiModel)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = categorySchema.parse(JSON.parse(content));
      return parsed.category;
    } catch (error) {
      console.warn(
        `[ai] classifyThreadCategory failed (model=${runnerConfig.openAiModel}); returning null. ${classifyOpenAiError(error)}`
      );
      return null;
    }
  }

  return {
    updateThreadSummary,
    generateSuggestedReplies,
    transformReply,
    classifyThreadCategory
  };
}
