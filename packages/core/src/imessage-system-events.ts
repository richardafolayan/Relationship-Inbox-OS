// iMessage "kept an audio message" system events.
//
// When a recipient opts to keep an expiring audio message in Messages,
// chat.db writes a system row whose body is a human-readable sentence:
//   "<name> kept an audio message from you."
//   "You kept an audio message from <name>."
//   "<name> kept an audio message."
// The row carries no attachment, no real content, and represents a
// platform-level retention notice rather than something either party
// said. Treating it as a normal message leads to:
//   - blank-looking bubbles in the thread UI (the line is short and
//     visually empty next to the surrounding bubbles);
//   - needsReply / lastInbound calculations flipping on a notice the
//     contact did not actually send;
//   - AI summaries spending tokens on a non-content turn and quoting
//     it back at the operator.
//
// Matching is conservative on purpose: we anchor on the full canonical
// shape so a real message that happens to mention the phrase ("Can you
// believe she kept an audio message I sent ages ago?") is left alone.
// A false positive here silently hides a needs-reply turn, which is
// much worse than a false negative.

const KEPT_AUDIO_PATTERNS: RegExp[] = [
  // "<name> kept an audio message from you[.]"
  /^[^\n]{1,80}? kept an audio message from you\.?$/i,
  // "You kept an audio message from <name>[.]"
  /^you kept an audio message from [^\n]{1,80}?\.?$/i,
  // "<name> kept an audio message[.]" (no "from" suffix; some macOS
  // versions emit the shorter form).
  /^[^\n]{1,80}? kept an audio message\.?$/i,
  // "You kept an audio message[.]" — the operator-side shorter variant.
  /^you kept an audio message\.?$/i
];

/**
 * Whether a message body is an iMessage "kept an audio message" system
 * event rather than something either party actually said. Returns false
 * for empty / nullish input so callers can drop the null-check.
 *
 * The matcher is intentionally narrow: it requires the canonical
 * sentence shape end-to-end. Real messages that merely contain the
 * phrase mid-sentence are not hidden.
 */
export function isNonContentIMessageSystemEvent(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KEPT_AUDIO_PATTERNS.some((re) => re.test(trimmed));
}
