// Deleted/retracted inbound placeholder detection (#???).
//
// When the other party unsends or deletes a message, the platform replaces
// the original bubble text with a placeholder string ("This message has
// been deleted.", "This message was deleted", etc.). Those placeholders
// are not real new turns:
//   - they should not flip a thread back into "needs reply" just because
//     a later-timestamped inbound row exists;
//   - they should not be the closing beat the closed-status classifier
//     ingests — the prompt should see the prior real turn instead;
//   - they should not be summarised as a fresh ask.
//
// They also do not by themselves close a thread. A retracted message
// after an unanswered question still leaves that question on the table,
// so the helper is used to *ignore* the placeholder, not to *close* the
// thread. The "is the thread closed?" decision falls through to the
// usual signal: did the last real inbound come after the last outbound?
//
// Matching is conservative on purpose. We list exact placeholder shapes
// seen in the wild (case-insensitive, with optional trailing period).
// A false negative (treating a deletion placeholder as a real message)
// preserves the pre-existing behaviour. A false positive (treating a
// real message as a deletion) would silently hide a needs-reply thread,
// which is much worse.

const DELETED_PLACEHOLDER_PATTERNS: RegExp[] = [
  // LinkedIn web
  /^this message has been deleted\.?$/i,
  // WhatsApp / Instagram / several web messengers
  /^this message was deleted\.?$/i,
  // Variant some clients write without the leading "this"
  /^message was deleted\.?$/i,
  // Apple Messages unsent variant (chat.db surfaces this string when a
  // recipient unsends an iMessage on iOS 16+).
  /^message unsent\.?$/i
];

/**
 * Whether a message body is a retracted/deleted-message placeholder
 * rather than a real inbound turn. Returns false for empty / nullish
 * input so callers do not have to null-check separately.
 */
export function isNonActionableInboundPlaceholder(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return DELETED_PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * The exact placeholder strings used by `isNonActionableInboundPlaceholder`,
 * expressed as a concrete list for callers that need an equality-only
 * filter (e.g. Prisma's `notIn` clause). The list mirrors the regex set
 * above with the trailing-period variants spelled out, so the Prisma
 * filter can do a fast indexed equality check without raw SQL.
 *
 * Keep this in sync with `DELETED_PLACEHOLDER_PATTERNS` above. When a
 * new variant is added there, append the exact spellings here.
 */
export const DELETED_INBOUND_PLACEHOLDER_STRINGS: readonly string[] = [
  "This message has been deleted.",
  "This message has been deleted",
  "This message was deleted.",
  "This message was deleted",
  "Message was deleted.",
  "Message was deleted",
  "Message unsent.",
  "Message unsent"
];
