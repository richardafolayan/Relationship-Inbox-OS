import type { ReplyBrief, ReplyBriefPoint, ReplyBriefPointStatus } from "@inbox-os/core";
import { safeTruncate, stripUnpairedSurrogates } from "../platforms/utils";

// Caps mirror the legacy open_loops cap (0-6) for required, and stay tight
// for the other lists so the right rail stays scannable in under 10 seconds.
export const MAX_REQUIRED_POINTS = 6;
export const MAX_OPTIONAL_POINTS = 4;
export const MAX_HANDLED_POINTS = 6;

// Phrases the brief must never use in default-visible sections. These are
// the abstract coaching strings the rail used to drift towards — "deepen
// the connection", "grounded question", and friends — that turn a calm
// reply panel into a self-help workbook. Stripped post-parse so a misbehaved
// model output still produces clean text rather than failing the call.
const BANNED_PHRASES: ReadonlyArray<RegExp> = [
  /\bdeepen(?:ing)? the (?:connection|relationship|bond)\b[^.?!]*/gi,
  /\bgrounded question\b/gi,
  /\bhelpful nudge\b/gi,
  /\bagile career planning\b/gi,
  /\bbuild rapport\b/gi,
  /\bdeepen rapport\b/gi
];

export function stripBannedPhrases(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const re of BANNED_PHRASES) {
    out = out.replace(re, "");
  }
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}

function shortSlug(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug ? `${slug}-${index}` : `p-${index}`;
}

function coerceStatus(raw: unknown): ReplyBriefPointStatus | null {
  if (raw === "required" || raw === "optional" || raw === "handled") return raw;
  return null;
}

function coercePoint(
  raw: unknown,
  fallbackStatus: ReplyBriefPointStatus,
  index: number
): ReplyBriefPoint | null {
  if (typeof raw === "string") {
    const text = stripUnpairedSurrogates(stripBannedPhrases(raw)).trim();
    if (!text) return null;
    return { id: shortSlug(text, index), text, status: fallbackStatus };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const text = typeof obj.text === "string"
      ? stripUnpairedSurrogates(stripBannedPhrases(obj.text)).trim()
      : "";
    if (!text) return null;
    const status = coerceStatus(obj.status) ?? fallbackStatus;
    const id =
      typeof obj.id === "string" && obj.id.trim() ? obj.id.trim().slice(0, 48) : shortSlug(text, index);
    const reason =
      typeof obj.reason === "string" && obj.reason.trim()
        ? safeTruncate(stripUnpairedSurrogates(stripBannedPhrases(obj.reason)).trim(), 160)
        : undefined;
    return { id, text, status, reason };
  }
  return null;
}

function dedupeByText(points: ReplyBriefPoint[]): ReplyBriefPoint[] {
  const seen = new Set<string>();
  const out: ReplyBriefPoint[] = [];
  for (const p of points) {
    const key = p.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// Sanitise a raw `reply_brief` value (already-parsed JSON, but with no
// internal-consistency guarantees) into a well-formed ReplyBrief.
// Enforces the spec's three classification invariants:
//   1. A point cannot be both required AND optional (required wins).
//   2. A point cannot be both required AND handled (handled wins — if the
//      model judged it handled, it's no longer on the operator).
//   3. Optional points never appear inside required_points.
// Returns null when the input is unusable; callers then synthesise a
// fallback from legacy fields rather than rendering an empty card.
export function sanitizeReplyBrief(raw: unknown): ReplyBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const whereItStands = typeof obj.where_it_stands === "string"
    ? safeTruncate(stripUnpairedSurrogates(stripBannedPhrases(obj.where_it_stands)).trim(), 600)
    : "";
  const onYou = typeof obj.on_you === "string"
    ? safeTruncate(stripUnpairedSurrogates(stripBannedPhrases(obj.on_you)).trim(), 360)
    : "";

  if (!whereItStands && !onYou) {
    // Nothing usable — caller will derive a fallback brief instead.
    return null;
  }

  const rawRequired = Array.isArray(obj.required_points) ? obj.required_points : [];
  const rawOptional = Array.isArray(obj.optional_followups) ? obj.optional_followups : [];
  const rawHandled = Array.isArray(obj.handled_points) ? obj.handled_points : [];

  const required = dedupeByText(
    rawRequired
      .map((p, i) => coercePoint(p, "required", i))
      .filter((p): p is ReplyBriefPoint => p !== null && p.status === "required")
  ).slice(0, MAX_REQUIRED_POINTS);

  const optional = dedupeByText(
    rawOptional
      .map((p, i) => coercePoint(p, "optional", i))
      .filter((p): p is ReplyBriefPoint => p !== null && p.status === "optional")
  );

  const handled = dedupeByText(
    rawHandled
      .map((p, i) => coercePoint(p, "handled", i))
      .filter((p): p is ReplyBriefPoint => p !== null && p.status === "handled")
  );

  // Invariant 2: a point classified as "handled" wins over the same text
  // showing up in required. The model contradicted itself; trust the
  // "handled" verdict because surfacing a handled point as a task is the
  // worse failure mode (creates phantom homework).
  const handledTextSet = new Set(handled.map((p) => p.text.toLowerCase()));
  const requiredAfterHandledDrop = required.filter(
    (p) => !handledTextSet.has(p.text.toLowerCase())
  );

  // Invariant 1: required wins over optional when both lists carry the
  // same text. Strip the duplicate from the optional list.
  const requiredTextSet = new Set(requiredAfterHandledDrop.map((p) => p.text.toLowerCase()));
  const optionalAfterRequiredDrop = optional.filter(
    (p) => !requiredTextSet.has(p.text.toLowerCase()) && !handledTextSet.has(p.text.toLowerCase())
  ).slice(0, MAX_OPTIONAL_POINTS);

  const fullerContext = typeof obj.fuller_context === "string"
    ? safeTruncate(stripUnpairedSurrogates(stripBannedPhrases(obj.fuller_context)).trim(), 800)
    : null;
  const durableContext = typeof obj.durable_context === "string"
    ? safeTruncate(stripUnpairedSurrogates(stripBannedPhrases(obj.durable_context)).trim(), 800)
    : null;
  const toneSteer = typeof obj.tone_steer === "string"
    ? safeTruncate(stripUnpairedSurrogates(stripBannedPhrases(obj.tone_steer)).trim(), 200)
    : null;

  const enoughToReply = typeof obj.enough_to_reply_without_scrolling === "boolean"
    ? obj.enough_to_reply_without_scrolling
    : Boolean(whereItStands) && Boolean(onYou);

  return {
    where_it_stands: whereItStands,
    on_you: onYou,
    required_points: requiredAfterHandledDrop,
    optional_followups: optionalAfterRequiredDrop,
    handled_points: handled.slice(0, MAX_HANDLED_POINTS),
    fuller_context: fullerContext || null,
    durable_context: durableContext || null,
    tone_steer: toneSteer || null,
    enough_to_reply_without_scrolling: enoughToReply
  };
}

// Synthesise a safe brief from the legacy fields when the model omits
// `reply_brief` or returns something unusable. Conservative by design: we
// never invent obligations from thin air — required_points only carry the
// existing open_loops, and on_you stays generic when whatTheyWant is the
// static fallback string ("No clear ask yet.").
export function synthesiseFallbackBrief(args: {
  rollingSummary: string;
  whatTheyWant: string;
  openLoops: string[];
  needsReply: boolean;
  latestInboundText: string | null;
}): ReplyBrief {
  const trimmedSummary = args.rollingSummary?.trim() ?? "";
  const trimmedAsk = args.whatTheyWant?.trim() ?? "";
  const trimmedInbound = args.latestInboundText?.trim() ?? "";

  const whereItStands = trimmedSummary || (trimmedInbound ? safeTruncate(trimmedInbound, 360) : "");

  const hasRealAsk =
    trimmedAsk.length > 0 && trimmedAsk.toLowerCase() !== "no clear ask yet." && args.needsReply;
  const onYou = hasRealAsk
    ? safeTruncate(trimmedAsk, 320)
    : args.needsReply
      ? "They're waiting on a reply, but nothing specific has been asked. A short acknowledgement is enough."
      : "Nothing pending from them right now.";

  const required = (args.openLoops ?? [])
    .map((loop, i) => coercePoint(loop, "required", i))
    .filter((p): p is ReplyBriefPoint => p !== null)
    .slice(0, MAX_REQUIRED_POINTS);

  return {
    where_it_stands: whereItStands,
    on_you: onYou,
    required_points: required,
    optional_followups: [],
    handled_points: [],
    fuller_context: trimmedSummary && trimmedSummary !== whereItStands ? trimmedSummary : null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: Boolean(whereItStands) && Boolean(onYou)
  };
}

// Mirror `required_points` back into the legacy `open_loops` string array
// so existing consumers (the dashboard checklist, the /check-draft loop
// matcher, the inbox preview fallback) keep working without a contract
// change. Only the text is mirrored; ids and status live on the brief.
export function mirrorRequiredToOpenLoops(brief: ReplyBrief | null): string[] | null {
  if (!brief) return null;
  return brief.required_points.map((p) => p.text);
}
