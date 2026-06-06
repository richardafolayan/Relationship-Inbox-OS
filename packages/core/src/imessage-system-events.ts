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

// A contact display name as it appears in these system rows: 1-3
// whitespace-separated tokens of letters / dots / apostrophes / hyphens
// ("Seyi", "Marianne Acheampong", "Mary-Jane O'Brien"). Deliberately NOT a
// `[^\n]{1,80}?` wildcard: anchored with `$`, that lazy wildcard absorbed
// up to 80 characters of arbitrary prefix prose, so a real inbound message
// merely ENDING in the canonical phrase ("Can you believe she kept an
// audio message from you") matched and was silently dropped. A bounded
// name-shaped class can't swallow a run of sentence words.
const NAME = "[\\p{L}][\\p{L}.'\\-]{0,39}(?: [\\p{L}.'\\-]{1,39}){0,2}";
// The "from <name>" slot may instead hold a phone number or email handle
// (e.g. "+447951711949"), so widen just that trailing slot.
const FROM_NAME = `(?:${NAME}|[+\\d][\\d ()\\-]{3,30}|[^\\s@]+@[^\\s@]+)`;

const KEPT_AUDIO_PATTERNS: RegExp[] = [
  // "<name> kept an audio message from you[.]"
  new RegExp(`^${NAME} kept an audio message from you\\.?$`, "iu"),
  // "You kept an audio message from <name>[.]"
  new RegExp(`^you kept an audio message from ${FROM_NAME}\\.?$`, "iu"),
  // "<name> kept an audio message[.]" (no "from" suffix; some macOS
  // versions emit the shorter form).
  new RegExp(`^${NAME} kept an audio message\\.?$`, "iu"),
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
