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

const KEPT_AUDIO_PATTERNS: RegExp[] = [
  /^[^\n]{1,80}? kept an audio message from you\.?$/i,
  /^you kept an audio message from [^\n]{1,80}?\.?$/i,
  /^[^\n]{1,80}? kept an audio message\.?$/i,
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
