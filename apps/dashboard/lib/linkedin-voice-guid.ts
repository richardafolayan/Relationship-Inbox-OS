// Dashboard-side copy of the runner's `isLinkedInVoiceGuid` predicate.
// Mirrors `apps/runner/src/services/linkedin-voice-store.ts` so the
// thread-view media component can decide — at render time, with no server
// round-trip — whether an attachment guid belongs to the LinkedIn voice
// store (served from `/runner/data/linkedin-voice-message/...`) or to
// iMessage (`/runner/data/imessage-attachment/...`).
//
// Why duplicate instead of import? The runner module pulls `node:fs` /
// `node:crypto` (it reads voice bytes off disk and hashes the urn into a
// filename), so it can't be bundled into the browser. This mirrors the
// existing `imessage-system-events.ts` pattern in this directory. Kept in
// lockstep with the runner predicate; a regression test in
// `tests/dashboard-linkedin-voice-guid.test.mjs` pins the two together.
//
// The guid is the message key the LinkedIn adapter persisted the voice
// file under, which is one of three shapes:
//   - a real LinkedIn event URN: `urn:li:msg_message:...`
//   - a content fingerprint for an id-less bubble: `li-msg-fp:...`
//     (the common case — most bubbles have no stable DOM id)
//   - the raw positional fallback (legacy rows): `li-msg-<index>`
// A UUID-shaped iMessage attachment guid (e.g. `3C3CA15E-7C18-...`) matches
// none of these and routes to the iMessage endpoint instead.
export function isLinkedInVoiceGuid(guid: string): boolean {
  return guid.startsWith("urn:li:") || guid.startsWith("li-msg-");
}
