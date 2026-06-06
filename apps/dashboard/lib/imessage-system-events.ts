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

const KEPT_AUDIO_PATTERNS: RegExp[] = [
  new RegExp(`^${NAME} kept an audio message from you\\.?$`, "iu"),
  new RegExp(`^you kept an audio message from ${FROM_NAME}\\.?$`, "iu"),
  new RegExp(`^${NAME} kept an audio message\\.?$`, "iu"),
  /^you kept an audio message\.?$/i
];

export function isNonContentIMessageSystemEvent(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KEPT_AUDIO_PATTERNS.some((re) => re.test(trimmed));
}
