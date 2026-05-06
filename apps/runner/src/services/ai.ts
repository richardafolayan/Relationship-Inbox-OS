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
        ]
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
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ai] OpenAI call failed (model=${runnerConfig.openAiModel}); using fallback. Reason: ${message}. ` +
          `If "model not found" or "does not exist", set OPENAI_MODEL to a model your account has access to (e.g. gpt-4o-mini).`
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

    const prompt = `Return strict JSON.
Previous summary: ${input.previousSummary ?? "None"}
Previous open loops: ${JSON.stringify(input.previousOpenLoops)}
Messages: ${JSON.stringify(input.messages)}
Required keys: summary, what_they_want, open_loops, tone_notes, needs_reply, urgency_hint.`;

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

    const prompt = `Return strict JSON.
Summary: ${input.summary}
What they want: ${input.whatTheyWant}
Open loops: ${JSON.stringify(input.openLoops)}
Last inbound: ${input.lastInboundMessage}
Create 3 short replies A/B/C + needs_user_input list.`;

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
        ]
      });

      return response.choices[0]?.message?.content?.trim() || input.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ai] transformReply failed (model=${runnerConfig.openAiModel}, mode=${input.mode}); returning original text. Reason: ${message}. ` +
          `If "model not found" or "does not exist", set OPENAI_MODEL to a model your account has access to (e.g. gpt-4o-mini).`
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
