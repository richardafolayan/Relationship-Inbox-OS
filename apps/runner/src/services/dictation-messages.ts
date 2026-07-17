/**
 * #880: voice-preserving "Turn into messages" formatting after dictation.
 *
 * Takes a raw speech transcript and lightly formats it into natural chat
 * message bubbles. This is message formatting, not rewriting: preserve
 * slang, filler, rhythm, and formality; only fix clear transcription
 * mistakes; split by thought.
 *
 * Pure helpers (prompt, sanitiser) are exported for unit tests. The AI
 * call itself lives on AiService.formatDictationMessages.
 */

import { z } from "zod";

export interface DictationMessage {
  id: string;
  text: string;
}

export interface DictationMessagesWarning {
  originalText: string;
  reason: string;
}

export interface DictationMessagesResult {
  cleanedTranscript: string;
  messages: DictationMessage[];
  warnings: DictationMessagesWarning[];
}

export interface FormatDictationMessagesInput {
  transcript: string;
  /** Contact display name, for light name correction only. */
  personName?: string | null;
  /** Extra known names (operator, mutuals) the model may use for ASR fixes. */
  knownNames?: string[];
}

/** Max transcript length accepted by the endpoint (chars). */
export const DICTATION_MESSAGES_MAX_TRANSCRIPT = 8000;

/**
 * System prompt for the formatter. Lives only on the server so the browser
 * never holds the rules or examples. Prefer under-correction over polish.
 */
export const DICTATION_MESSAGES_SYSTEM_PROMPT = `You format a raw speech transcript into natural chat messages. This is formatting, not rewriting.

Voice-preservation rules:
- Preserve the speaker's meaning, tone, slang, abbreviations, vocabulary, and sentence rhythm
- Keep intentional filler such as basically, obviously, I mean, you know, I think, I guess, yeah, btw, icl, tbf, Yhh, but, and, because, so
- Allow messages to begin with And, But, Because, or So
- Use normal capitalisation
- Remove trailing full stops from each message (no period at the very end of a message)
- Keep question marks and exclamation marks where they are genuinely needed
- Preserve names, numbers, links, technical terms, and personal abbreviations
- Correct obvious transcription mistakes only when the intended wording is reasonably clear
- Remove accidental repetition, false starts, or abandoned fragments only when they clearly add no meaning
- Never invent information
- Never rewrite informal language into formal English
- Never make the speaker sound more polished, concise, confident, or professional than they sounded
- Prefer under-correction over polish

Message splitting rules:
- Split by natural thought, not mechanically at every full stop
- Each item should feel like one message the person would realistically send
- Keep closely related phrases together
- Avoid lots of tiny messages unless that matches the speaker's style
- A message can contain more than one sentence when the thoughts belong together
- Do not add a full stop at the end of a message

When a phrase is unclear and you cannot confirm the intended wording, leave it as-is in the messages and add an entry to warnings.

Return JSON only with exactly this shape:
{
  "cleanedTranscript": "A lightly corrected version of the original transcript",
  "messages": [
    { "id": "message-1", "text": "First natural message" }
  ],
  "warnings": [
    { "originalText": "Unclear section", "reason": "The intended wording could not be confirmed" }
  ]
}

ids must be message-1, message-2, ... in order. warnings may be an empty array.`;

/**
 * Build the user prompt. Exposed for tests so the contract (transcript
 * always present, optional names) can be pinned without an LLM.
 */
export function buildDictationMessagesUserPrompt(input: FormatDictationMessagesInput): string {
  const lines: string[] = [];
  lines.push("Raw transcript:");
  lines.push(input.transcript.trim());
  lines.push("");
  const person = input.personName?.trim();
  if (person) {
    lines.push(`Contact name (for light name correction only): ${person}`);
  }
  const known = (input.knownNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (known.length > 0) {
    lines.push(`Known names (for light name correction only): ${known.join(", ")}`);
  }
  if (!person && known.length === 0) {
    lines.push("No extra name context.");
  }
  lines.push("");
  lines.push("Format into messages. Return JSON only.");
  return lines.join("\n");
}

const rawResponseSchema = z.object({
  cleanedTranscript: z.string().optional(),
  messages: z
    .array(
      z.union([
        z.string(),
        z.object({
          id: z.string().optional(),
          text: z.string().optional()
        })
      ])
    )
    .optional(),
  warnings: z
    .array(
      z.object({
        originalText: z.string().optional(),
        reason: z.string().optional()
      })
    )
    .optional()
});

/**
 * Strip a single trailing full stop (ASCII or common unicode) while
 * leaving ? ! ... and internal periods alone.
 */
export function stripTrailingFullStop(text: string): string {
  return text.replace(/\u2026$/, "...").replace(/[.。]\s*$/u, "").trimEnd();
}

/**
 * Validate and normalise a model response. Returns null when the payload
 * is unusable (no messages), so the caller can keep the original
 * transcript and offer retry.
 */
export function sanitiseDictationMessagesResponse(
  raw: unknown,
  originalTranscript: string
): DictationMessagesResult | null {
  let parsed: z.infer<typeof rawResponseSchema>;
  try {
    parsed = rawResponseSchema.parse(raw);
  } catch {
    return null;
  }

  const messages: DictationMessage[] = [];
  for (const item of parsed.messages ?? []) {
    const text =
      typeof item === "string"
        ? item.trim()
        : typeof item?.text === "string"
          ? item.text.trim()
          : "";
    if (!text) continue;
    messages.push({
      id: `message-${messages.length + 1}`,
      text: stripTrailingFullStop(text)
    });
  }

  if (messages.length === 0) {
    return null;
  }

  const cleaned =
    typeof parsed.cleanedTranscript === "string" && parsed.cleanedTranscript.trim()
      ? parsed.cleanedTranscript.trim()
      : originalTranscript.trim();

  const warnings: DictationMessagesWarning[] = [];
  for (const w of parsed.warnings ?? []) {
    const originalText = typeof w.originalText === "string" ? w.originalText.trim() : "";
    const reason = typeof w.reason === "string" ? w.reason.trim() : "";
    if (!originalText && !reason) continue;
    warnings.push({
      originalText: originalText || "(unclear)",
      reason: reason || "The intended wording could not be confirmed"
    });
  }

  return { cleanedTranscript: cleaned, messages, warnings };
}

/**
 * Deterministic production fallback when AI is unavailable or returns an
 * unusable payload (wired from AiService.formatDictationMessages). Splits
 * on sentence boundaries and light conjunctions so the operator still gets
 * editable bubbles. Never invents wording.
 */
export function fallbackSplitTranscript(transcript: string): DictationMessagesResult {
  const trimmed = transcript.trim();
  if (!trimmed) {
    return { cleanedTranscript: "", messages: [], warnings: [] };
  }

  // Split on . ? ! while keeping ? ! on the preceding chunk. Then soft-split
  // long chunks on ", and " / ", but " / ", so " when they look like thought
  // boundaries. Keep it conservative.
  const rough = trimmed
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const parts: string[] = [];
  for (const chunk of rough) {
    if (chunk.length < 160) {
      parts.push(chunk);
      continue;
    }
    const soft = chunk.split(/(?:,\s+(?=(?:and|but|so|because|then)\b)|(?<=\S)\s+(?=(?:And|But|So|Because)\b))/i);
    if (soft.length === 1) {
      parts.push(chunk);
    } else {
      for (const s of soft) {
        const t = s.trim();
        if (t) parts.push(t);
      }
    }
  }

  const messages: DictationMessage[] = parts
    .map((text, i) => ({
      id: `message-${i + 1}`,
      text: stripTrailingFullStop(text)
    }))
    .filter((m) => m.text.length > 0);

  if (messages.length === 0) {
    messages.push({ id: "message-1", text: stripTrailingFullStop(trimmed) });
  }

  return {
    cleanedTranscript: trimmed,
    messages,
    warnings: []
  };
}

/** Issue #880 example fixtures (raw → expected message texts). */
export const DICTATION_MESSAGES_EXAMPLES = [
  {
    id: "thank-you-project",
    raw: "Btw I just wanted to say thank you for helping me with the project because icl I was honestly quite stuck and I didn't really know what I was doing but your feedback helped a lot and yeah I'll probably send the updated version tomorrow",
    expectedMessages: [
      "Btw I just wanted to say thank you for helping me with the project",
      "Because icl I was honestly quite stuck and I didn't really know what I was doing",
      "But your feedback helped a lot",
      "And Yhh I'll probably send the updated version tmr"
    ]
  },
  {
    id: "tovi-app",
    raw: "Okay, cool. So, basically what I was doing yesterday was I was working on the Toyvi app because, obviously, what do you call it, we're trying to make it so that instead of just being able to access it on Mac, you can also access it on iPhone. So obviously that's a really important feature to us to actually make it accessible to most people. I think once we can get it to that point, that's when we can, you know, that's when we'll be cooking. I think that'll also make it like a minimum viable product as well. So I think that's like the progress leaky from what we've been able to do so far. And I guess I'm just excited to see, you know, where it goes. But yeah, I think that's basically it.",
    expectedMessages: [
      "Okay cool, so basically what I was doing yesterday was working on the Tovi app",
      "Because obviously we're trying to make it so that instead of only being able to access it on Mac, you can also access it on iPhone",
      "So obviously that's a really important feature for us, just to actually make it accessible to most people",
      "I think once we can get it to that point, that's when we'll be cooking",
      "I think that'll also make it like a minimum viable product as well",
      "So I think that's basically the progress we've made so far",
      "And I guess I'm just excited to see, you know, where it goes",
      "But yeah, I think that's basically it"
    ]
  },
  {
    id: "on-to-the-next",
    raw: "Yeah, I mean, I feel alright. It's okay, man. I'd like to have done a little bit better. I was on the edge, but listen, what can we do, man? That's how life goes. Life is on to the next thing, I'll be real. On to the next thing.",
    expectedMessages: [
      "Yeah I mean, I feel alright",
      "It's okay man, I would've liked to have done a little bit better",
      "I was on the edge, but listen, what can we do man?",
      "That's how life goes",
      "I'll be real, it's on to the next thing now"
    ]
  }
] as const;

/**
 * Contract checks for a sanitised result against the voice rules (no
 * trailing full stops; messages non-empty; optional start-with-conjunction
 * allowed). Used by unit tests; not a substitute for LLM quality eval.
 */
export function assertVoiceFormattingRules(result: DictationMessagesResult): string[] {
  const violations: string[] = [];
  if (result.messages.length === 0) {
    violations.push("messages must not be empty");
  }
  for (const m of result.messages) {
    if (!m.text.trim()) {
      violations.push(`${m.id}: empty text`);
    }
    if (/[.。]\s*$/u.test(m.text)) {
      violations.push(`${m.id}: trailing full stop`);
    }
  }
  return violations;
}
