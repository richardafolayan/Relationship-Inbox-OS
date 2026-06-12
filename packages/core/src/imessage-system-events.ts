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

// Name-leading forms ("<name> kept an audio message ..."). We CAPTURE the
// <name> slot so a proper-noun guard can reject a short conversational
// clause that merely ENDS on the canonical phrase. The name class alone is
// still too loose: it accepts up to three letter tokens, so filler like
// "No way she", "lol yeah he" or "Aw glad you" fits the slot and a real
// inbound turn ending in the phrase was silently dropped.
const NAME_LEADING_FROM_YOU = new RegExp(
  `^(${NAME}) kept an audio message from you\\.?$`,
  "iu"
);
// "<name> kept an audio message[.]" (no "from" suffix; some macOS versions
// emit the shorter form).
const NAME_LEADING_BARE = new RegExp(
  `^(${NAME}) kept an audio message\\.?$`,
  "iu"
);
// Operator-side forms ("You kept an audio message ...") have a fixed "You"
// subject, so they need no name guard.
const YOU_LEADING_FROM = new RegExp(
  `^you kept an audio message from ${FROM_NAME}\\.?$`,
  "iu"
);
const YOU_LEADING_BARE = /^you kept an audio message\.?$/i;

// A captured <name> prefix only looks like a real contact display name when
// it is a single token (any case: "seyi", "SEYI", "Praise") or a run of
// proper-noun tokens (each capitalised: "Marianne Acheampong"), or an
// all-caps shouting row ("NANA ATHLETICS"). A multi-token prefix with a
// lowercase-initial token is sentence filler, not a name, so we reject it.
function matchesNamePrefix(prefix: string): boolean {
  const tokens = prefix.split(" ").filter(Boolean);
  // Empty prefix is never a name — fail safe by treating the row as real content.
  if (tokens.length === 0) return false;
  if (tokens.length === 1) return true;
  if (prefix === prefix.toUpperCase() && /[A-Z]/.test(prefix)) return true;
  return tokens.every((token) => /^\p{Lu}/u.test(token));
}

/**
 * Whether a message body is an iMessage "kept an audio message" system
 * event rather than something either party actually said. Returns false
 * for empty / nullish input so callers can drop the null-check.
 *
 * The matcher is intentionally narrow: it requires the canonical
 * sentence shape end-to-end AND, for the name-leading forms, a name-shaped
 * prefix. Real messages that merely contain the phrase mid-sentence, or
 * that end on it after a short clause, are not hidden.
 */
export function isNonContentIMessageSystemEvent(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const fromYou = NAME_LEADING_FROM_YOU.exec(trimmed);
  if (fromYou) return matchesNamePrefix(fromYou[1] ?? "");
  const bare = NAME_LEADING_BARE.exec(trimmed);
  if (bare) return matchesNamePrefix(bare[1] ?? "");
  return YOU_LEADING_FROM.test(trimmed) || YOU_LEADING_BARE.test(trimmed);
}
