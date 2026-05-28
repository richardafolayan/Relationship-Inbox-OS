// Helpers that fold iMessage tapback / reaction state into the rest of
// the system. Reactions are stored on the parent message's rawJson
// (set by the iMessage adapter, see imessage-adapter.ts) — they are
// not standalone Message rows. That means a "the operator reacted ❤️"
// signal is invisible to:
//   - the aggregateOutbound timestamp query in scan-queue (which only
//     looks at direction=OUT real message rows), so needsReply stays
//     true even though the operator effectively replied.
//   - the AI prompts (which see MessageForPrompt[] with direction +
//     text + timestamp only).
//
// These helpers extract reactions from rawJson and:
//   1. Bump the effective lastOutboundAt timestamp when the operator
//      reacted to the most recent inbound message (#393 — pilot R-0033).
//   2. Inject a tiny synthetic "[operator reacted X]" annotation into
//      the message text the AI sees, so it knows the reaction
//      happened (#393 — second half of pilot R-0033).
//
// Kept here as a small standalone module so the scan-queue and the AI
// prompt builders import the same source of truth.

export interface ParsedReaction {
  /** Direction of the reaction — IN means the contact reacted, OUT means the operator did. */
  direction: "IN" | "OUT";
  /** Apple's tapback emoji equivalent (❤, 👍, 👎, 😂, ‼, ❓). */
  emoji: string;
  /** Apple's tapback kind. */
  kind: "love" | "like" | "dislike" | "laugh" | "emphasis" | "question";
  /** ISO timestamp the reaction was applied. Optional — earlier captures didn't store it. */
  timestamp?: string;
}

/**
 * Tolerant parser for the reactions array on a Message's rawJson string.
 * Returns [] for any malformed shape — the wider system must never crash
 * on a corrupt rawJson value (third-party data, future schema drift).
 */
export function parseReactionsFromRawJson(rawJson: string | null | undefined): ParsedReaction[] {
  if (!rawJson) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object") return [];
  const raw = (obj as Record<string, unknown>).reactions;
  if (!Array.isArray(raw)) return [];
  const out: ParsedReaction[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const direction = r.direction === "OUT" ? "OUT" : r.direction === "IN" ? "IN" : null;
    if (!direction) continue;
    const emoji = typeof r.emoji === "string" ? r.emoji : "";
    const kind =
      r.kind === "love" ||
      r.kind === "like" ||
      r.kind === "dislike" ||
      r.kind === "laugh" ||
      r.kind === "emphasis" ||
      r.kind === "question"
        ? r.kind
        : null;
    if (!kind) continue;
    // Drop reactions that have been removed — `removed: true` means the
    // reaction was applied then taken back. The iMessage adapter
    // currently filters these out, but defending against future drift.
    if (r.removed === true) continue;
    const timestamp = typeof r.timestamp === "string" ? r.timestamp : undefined;
    out.push({ direction, emoji, kind, timestamp });
  }
  return out;
}

/**
 * Pick the max effective lastOutboundAt across:
 *   - the explicit OUT-message aggregate timestamp (from Prisma)
 *   - any OUT reactions on messages in the recent window
 *
 * Returns the latest of the inputs, or null if nothing qualifies.
 *
 * Operator OUT reactions are equivalent to a small reply for needsReply
 * purposes: the operator has acknowledged the inbound. Without this
 * bump, threads where the operator reacted instead of typing a reply
 * stay flagged as needing a reply forever (#393 — pilot R-0033).
 */
export function effectiveLastOutboundAt(
  aggregateOutboundAt: Date | null,
  messagesWithRawJson: Array<{ rawJson: string | null }>
): Date | null {
  let best = aggregateOutboundAt ? aggregateOutboundAt.getTime() : 0;
  for (const m of messagesWithRawJson) {
    const reactions = parseReactionsFromRawJson(m.rawJson);
    for (const r of reactions) {
      if (r.direction !== "OUT" || !r.timestamp) continue;
      const ms = Date.parse(r.timestamp);
      if (Number.isFinite(ms) && ms > best) best = ms;
    }
  }
  if (best <= 0) return null;
  return new Date(best);
}

/**
 * Human-readable summary of reactions on a message, used to annotate
 * the message text for AI context. Returns empty string when there
 * are no qualifying reactions, so the wider format helper can append
 * unconditionally without producing trailing whitespace on plain
 * messages.
 *
 * Example output: " [operator reacted ❤️]" or " [operator reacted ❤️, contact reacted 👍]"
 */
export function describeReactionsForPrompt(reactions: ParsedReaction[]): string {
  if (reactions.length === 0) return "";
  const parts: string[] = [];
  for (const r of reactions) {
    const who = r.direction === "OUT" ? "operator" : "contact";
    parts.push(`${who} reacted ${r.emoji}`);
  }
  return ` [${parts.join(", ")}]`;
}
