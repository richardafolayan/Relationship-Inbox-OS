// Reply-style analysis (issue #438 — pilot R-0059).
//
// Opt-in helper that infers the operator's reply-style fields from a sample
// of their OWN recently SENT messages, so they don't have to fill the
// Settings questionnaire by hand. Framework-free and side-effect-free (no
// Prisma, no AI client, no Express) so it unit-tests directly and the AI
// service can import the prompt builder + normaliser without an import cycle.
//
// Scope is deliberately tight: it only ever infers the five reply-style
// fields (about / preferredStyle / commonPhrases / avoidedPhrases /
// interests). It never touches displayName (identity) or aiHelpLevel (a
// preference), never reads incoming messages, and never auto-saves — the
// dashboard prefills the form and the operator reviews + saves explicitly.

import { z } from "zod";
import { safeTruncate } from "../platforms/utils";
import type { InferredReplyStyle, ReplyStyle } from "../types/runtime";

const REPLY_STYLES: ReplyStyle[] = ["warm", "direct", "casual", "thoughtful", "concise"];

/** Largest number of sent messages handed to the model. */
export const STYLE_ANALYSIS_SAMPLE_LIMIT = 160;
/** Below this many usable sent messages we don't even ask — too little signal. */
export const STYLE_ANALYSIS_MIN_SAMPLE = 8;
/** Per-message cap so one long paste can't dominate the prompt. */
const PER_MESSAGE_CHARS = 280;

// Field-length caps — mirror the /control/operator-profile write schema so a
// suggestion always fits what the save endpoint will accept.
const ABOUT_MAX = 4000;
const INTERESTS_MAX = 4000;
const PHRASES_MAX = 2000;

const EMPTY: InferredReplyStyle = {
  about: "",
  preferredStyle: "",
  commonPhrases: "",
  avoidedPhrases: "",
  interests: ""
};

export function emptyInferredStyle(): InferredReplyStyle {
  return { ...EMPTY };
}

export function isInferredStyleEmpty(style: InferredReplyStyle): boolean {
  return (
    !style.about.trim() &&
    !style.preferredStyle &&
    !style.commonPhrases.trim() &&
    !style.avoidedPhrases.trim() &&
    !style.interests.trim()
  );
}

type SampleRow = { text?: string | null; direction?: string | null; sentVia?: string | null };

// A bare attachment / placeholder bubble carries no style signal.
const PLACEHOLDER_ONLY =
  /^\[\s*(voice ?notes?|audios?|photos?|images?|videos?|gifs?|stickers?|attachments?|files?|documents?|links?)\s*\]$/i;

/**
 * Pick the operator's own authentically-composed sent messages from a
 * newest-first row set. Keeps OUT messages that were NOT sent through the
 * runner's automation path (`sentVia === "automation"`): those went out as
 * AI-assisted drafts, and folding them back in would analyse the model's
 * voice rather than the operator's. Drops empty + placeholder-only bubbles,
 * caps each message, and returns oldest-first up to `limit`.
 */
export function selectStyleSampleTexts(
  rows: SampleRow[],
  limit: number = STYLE_ANALYSIS_SAMPLE_LIMIT
): string[] {
  const kept: string[] = [];
  for (const row of rows) {
    if ((row.direction ?? "") !== "OUT") continue;
    if ((row.sentVia ?? "") === "automation") continue;
    const text = (row.text ?? "").trim();
    if (!text) continue;
    if (PLACEHOLDER_ONLY.test(text)) continue;
    kept.push(safeTruncate(text, PER_MESSAGE_CHARS));
    if (kept.length >= limit) break;
  }
  // Rows arrive newest-first; show the model oldest-first so it reads like a
  // natural progression of how the operator writes.
  return kept.reverse();
}

/**
 * Loose schema for the model's JSON. The object itself is required, so a
 * non-object response trips the provider fallback; every field is optional
 * and phrase fields may come back as a string or an array of strings.
 */
export const replyStyleAnalysisSchema = z.object({
  about: z.string().optional(),
  preferred_style: z.string().optional(),
  common_phrases: z.union([z.string(), z.array(z.string())]).optional(),
  avoided_phrases: z.union([z.string(), z.array(z.string())]).optional(),
  interests: z.union([z.string(), z.array(z.string())]).optional()
});

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

/**
 * Coerce a raw (already JSON-parsed) model response into a safe
 * InferredReplyStyle: an invalid `preferred_style` collapses to "", phrase
 * arrays join to a comma list, and every field is trimmed + length-capped to
 * the operator-profile write limits. Never throws — unusable input yields an
 * empty suggestion, which the endpoint reports as low confidence.
 */
export function normaliseInferredStyle(raw: unknown): InferredReplyStyle {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const style = asText(obj.preferred_style).toLowerCase();
  return {
    about: safeTruncate(asText(obj.about), ABOUT_MAX),
    preferredStyle: (REPLY_STYLES as string[]).includes(style) ? (style as ReplyStyle) : "",
    commonPhrases: safeTruncate(asText(obj.common_phrases), PHRASES_MAX),
    avoidedPhrases: safeTruncate(asText(obj.avoided_phrases), PHRASES_MAX),
    interests: safeTruncate(asText(obj.interests), INTERESTS_MAX)
  };
}

/**
 * Build the analysis prompt. The messages are the operator's OWN sent
 * messages; the model infers how THEY write. British English, no
 * fabrication, leave a field empty when the sample doesn't support it.
 */
export function buildReplyStyleAnalysisPrompt(sampleTexts: string[]): string {
  const numbered = sampleTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `Return strict JSON matching this exact shape:
{
  "about": "string",
  "preferred_style": "warm | direct | casual | thoughtful | concise | (empty)",
  "common_phrases": "string",
  "avoided_phrases": "string",
  "interests": "string"
}

Below are real messages the operator SENT to other people, across their inboxes, oldest first. Infer how THIS PERSON writes — their own voice — so a writing assistant can sound like them. Use British English.

HARD RULES (strict):
- Infer ONLY from the messages below. Do not invent traits, phrases, or interests the messages don't support. When the sample doesn't clearly support a field, return "" for it (an empty preferred_style is fine).
- "about": 1-3 plain sentences on how they message people — length, warmth, formality, punctuation and capitalisation habits, emoji use. Write it in the second person ("You tend to...").
- "preferred_style": the single closest tone from the five options, or "" if none clearly fits. warm = friendly and personable; direct = clear and to the point; casual = relaxed and informal; thoughtful = considered and reflective; concise = as short as possible.
- "common_phrases": a short comma-separated list of words or phrases they genuinely use often, taken verbatim from the messages. "" if nothing recurs.
- "avoided_phrases": leave "" unless a clear habit makes an avoidance obvious. Do not guess negatives.
- "interests": a short comma-separated list of topics they actually bring up. "" if unclear.
- These are the operator's OWN words. Do not quote or describe anyone they were talking to.

Messages (oldest first):
${numbered}`;
}
