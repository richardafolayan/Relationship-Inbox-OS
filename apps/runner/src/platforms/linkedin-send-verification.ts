import type { VerificationMethod } from "@inbox-os/core";

/**
 * A snapshot of the last bubble in a LinkedIn conversation, plus the total
 * bubble count, used to decide whether a send actually landed.
 *
 * `timestampSynthetic` is true when the bubble's <time> had no parseable
 * `datetime` (LinkedIn usually renders bare "4:52 PM"), so the timestamp is a
 * `Date.now()` stand-in rather than a real message time.
 */
export interface LinkedInSendBubble {
  direction: "IN" | "OUT";
  timestamp: number;
  text: string;
  timestampSynthetic: boolean;
  count: number;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Decide whether a LinkedIn send is *confirmed* from the pre/post message-list
 * snapshots. Returns the verification method, or `null` when delivery is not
 * yet confirmed — the caller should keep polling and treat a final `null` as a
 * FAILED send rather than a silent success.
 *
 * Why this is strict: `getLatestMessageSnapshot()` substitutes `Date.now()`
 * when a bubble's <time> has no parseable datetime. Two `Date.now()` reads
 * always "advance", so the old `direction === "OUT" && timestampAdvanced`
 * shortcut rubber-stamped a silently failed *re-reply* — where the last bubble
 * is the operator's own previous outbound message — as sent. We now require
 * real evidence:
 *   - the sent text appears in the last outbound bubble, OR
 *   - a brand-new bubble appeared (count increased) and the last one is OUT, OR
 *   - a genuine, non-synthetic timestamp advance.
 */
export function classifyLinkedInSendVerification(input: {
  pre: LinkedInSendBubble | null;
  last: LinkedInSendBubble | null;
  sentText: string;
}): VerificationMethod | null {
  const { pre, last, sentText } = input;

  // Nothing read yet, or the newest bubble isn't ours — not confirmed.
  if (!last || last.direction !== "OUT") return null;

  const cleanedSent = normalize(sentText);
  const textMatch = cleanedSent.length > 0 && normalize(last.text).includes(cleanedSent);
  const newBubbleAppeared = pre == null || last.count > pre.count;

  // Strongest signals — independent of LinkedIn's frequently-unparseable times.
  if (textMatch || newBubbleAppeared) return "bubble_detected";

  // Only trust a timestamp advance when BOTH snapshots came from a real
  // datetime attribute; a synthesized Date.now() advance proves nothing.
  const timestampsReliable = pre != null && !pre.timestampSynthetic && !last.timestampSynthetic;
  if (timestampsReliable && last.timestamp > pre.timestamp) return "timestamp_advanced";

  return null;
}
