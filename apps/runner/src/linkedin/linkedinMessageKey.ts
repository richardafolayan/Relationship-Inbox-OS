// Stable dedup keys for LinkedIn message bubbles.
//
// LinkedIn renders many message bubbles with NO stable DOM id (no
// `data-event-urn`, `data-id`, or `id`). Both message-collection paths fall
// back to a positional `li-msg-<index>` key when that happens. That index is
// not stable across scans: as older messages prepend (deep-fetch backfill) or
// the rendered window shifts (streaming delta scans), the SAME bubble gets a
// different index and therefore a different key. Inbound messages have no
// content-level dedup downstream, so a re-keyed bubble is persisted again and
// the message duplicates.
//
// `stableMessageKey` converts that positional fallback into a content
// fingerprint (`li-msg-fp:...`) that is deterministic for a given bubble
// regardless of its position, while leaving any real DOM-id key untouched.

/** Matches the positional fallback key `li-msg-<index>` produced when a bubble
 * has no stable DOM id. A real `data-event-urn` / `data-id` / element id never
 * has this exact shape, so this safely distinguishes the fallback. */
const POSITIONAL_MESSAGE_KEY_PATTERN = /^li-msg-\d+$/;

export function isPositionalMessageKey(key: string): boolean {
  return POSITIONAL_MESSAGE_KEY_PATTERN.test(key);
}

export interface StableMessageKeyInput {
  /** The key read off the bubble: `data-event-urn` / `data-id` / element id,
   * or the positional `li-msg-<index>` fallback. */
  existingKey: string;
  direction: "IN" | "OUT";
  senderName: string;
  /** The date heading in effect for this bubble (inherited from the most-recent
   * heading in the date run, matching how both collection paths resolve it). */
  dateHeading: string;
  timeText: string;
  /** The first text part of the bubble (only the first 48 chars are used). */
  firstTextPart: string;
}

/**
 * Return a dedup key that is stable across scans for a given bubble.
 *
 * When `existingKey` is a real DOM-id key it is returned unchanged. When it is
 * the positional `li-msg-<index>` fallback it is replaced with a content
 * fingerprint so the same bubble keeps the same key even as its index shifts.
 */
export function stableMessageKey(input: StableMessageKeyInput): string {
  if (!isPositionalMessageKey(input.existingKey)) {
    return input.existingKey;
  }
  const first48 = (input.firstTextPart ?? "").slice(0, 48);
  return `li-msg-fp:${input.direction}|${input.senderName}|${input.dateHeading}|${input.timeText}|${first48}`;
}
