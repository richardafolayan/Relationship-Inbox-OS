// Dashboard-side copy of the iMessage "kept an audio message" system-event
// matcher. Mirrors `@inbox-os/core`'s `isNonContentIMessageSystemEvent` so
// the dashboard can run the same filter at render time (defence in depth
// against any historical rows that bypassed the runner-side filter).
//
// Kept in lockstep with the core file: when the canonical sentence shapes
// change there, change here too. A regression test in
// `tests/dashboard-imessage-system-events.test.mjs` pins the two
// implementations together.
//
// Why duplicate? Webpack's browser bundle can't follow `node:crypto`
// imports that the rest of `@inbox-os/core` transitively pulls in via
// `hash.js`. Importing the helper from core would drag the whole module
// graph into the client bundle. Splitting via a sub-path would work too
// but adds package.json exports + tsconfig paths churn for a 20-line
// helper. Duplication is cheaper.

// A contact display name as it appears in these system rows: 1-3
// whitespace-separated tokens of letters / dots / apostrophes / hyphens
// ("Seyi", "Marianne Acheampong", "Mary-Jane O'Brien"). Deliberately NOT
// a `[^\n]{1,80}?` wildcard — that absorbed arbitrary prefix prose, so a
// real message merely ENDING in the canonical phrase ("…she kept an audio
// message from you") matched and was silently dropped.
const NAME = "[\\p{L}][\\p{L}.'\\-]{0,39}(?: [\\p{L}.'\\-]{1,39}){0,2}";
// The "from <name>" slot may instead hold a phone number or email handle
// (e.g. "+447951711949"), so widen just that trailing slot.
const FROM_NAME = `(?:${NAME}|[+\\d][\\d ()\\-]{3,30}|[^\\s@]+@[^\\s@]+)`;

// Name-leading forms CAPTURE the <name> slot so a proper-noun guard can
// reject a short conversational clause that merely ENDS on the canonical
// phrase ("No way she ...", "lol yeah he ...", "Aw glad you ..."). Kept in
// lockstep with packages/core/src/imessage-system-events.ts.
const NAME_LEADING_FROM_YOU = new RegExp(
  `^(${NAME}) kept an audio message from you\\.?$`,
  "iu"
);
const NAME_LEADING_BARE = new RegExp(
  `^(${NAME}) kept an audio message\\.?$`,
  "iu"
);
const YOU_LEADING_FROM = new RegExp(
  `^you kept an audio message from ${FROM_NAME}\\.?$`,
  "iu"
);
const YOU_LEADING_BARE = /^you kept an audio message\.?$/i;

// A captured <name> prefix only looks like a real contact display name when
// it is a single token (any case), a run of capitalised proper-noun tokens,
// or an all-caps shouting row. A multi-token prefix with a lowercase-initial
// token is sentence filler, not a name, so we reject it.
function matchesNamePrefix(prefix: string): boolean {
  const tokens = prefix.split(" ").filter(Boolean);
  // Empty prefix is never a name — fail safe by treating the row as real content.
  if (tokens.length === 0) return false;
  if (tokens.length === 1) return true;
  if (prefix === prefix.toUpperCase() && /[A-Z]/.test(prefix)) return true;
  return tokens.every((token) => /^\p{Lu}/u.test(token));
}

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
