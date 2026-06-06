import test from "node:test";
import assert from "node:assert/strict";

// Regression for the voice-playback gap: id-less LinkedIn bubbles persist a
// voice attachment's guid as a content fingerprint `li-msg-fp:...` (or legacy
// `li-msg-<index>`), not `urn:li:`. The runner's resolver dispatch was already
// widened to all three shapes via `isLinkedInVoiceGuid`, but the two CONSUMER
// sides were not: the dashboard URL builder (imessage-media.tsx) and the voice
// serve-route zod both hard-gated on `startsWith("urn:li:")`, so a fingerprint
// voice guid was routed to the iMessage endpoint / rejected by validation and
// the audio never played.
//
// The dashboard now decides routing through a local copy of the predicate
// (`apps/dashboard/lib/linkedin-voice-guid.ts`) — it can't import the runner
// module, which is fs/crypto-coupled. This test (1) pins that helper to every
// guid shape the producer can emit, and (2) asserts it stays in lockstep with
// the runner's canonical `isLinkedInVoiceGuid`.

const { isLinkedInVoiceGuid: dashboardImpl } = await import(
  "../apps/dashboard/lib/linkedin-voice-guid.ts"
);
const { isLinkedInVoiceGuid: runnerImpl } = await import(
  "../apps/runner/dist/services/linkedin-voice-store.js"
);

const cases = [
  // Real LinkedIn event URN.
  { guid: "urn:li:msg_message:(urn:li:fsd_profile:abc,2-def==)", expected: true },
  { guid: "urn:li:messagingMessage:2-abc==", expected: true },
  // Content fingerprint for an id-less bubble — THE case the bug missed.
  { guid: "li-msg-fp:IN|Uwa Okungbowa|Feb 19|7:16 PM|Hi", expected: true },
  // A realistic full-length fingerprint (verifies it routes regardless of size).
  {
    guid:
      "li-msg-fp:OUT|Christopher Alexander|Thursday, December 25, 2025|11:45 PM|Thanks so much for the detailed write-up",
    expected: true
  },
  // Legacy positional fallback.
  { guid: "li-msg-7", expected: true },
  { guid: "li-msg-128", expected: true },
  // UUID-shaped iMessage attachment guid — must NOT route to LinkedIn.
  { guid: "3C3CA15E-7C18-4A1B-9F2D-0123456789AB", expected: false },
  { guid: "p:1234567890", expected: false },
  { guid: "", expected: false }
];

for (const { guid, expected } of cases) {
  test(`dashboard isLinkedInVoiceGuid(${JSON.stringify(guid)}) === ${expected}`, () => {
    assert.equal(dashboardImpl(guid), expected);
  });

  test(`dashboard matches runner on ${JSON.stringify(guid)}`, () => {
    assert.equal(
      dashboardImpl(guid),
      runnerImpl(guid),
      `dashboard=${dashboardImpl(guid)} vs runner=${runnerImpl(guid)} — predicates drifted`
    );
  });
}

test("a fingerprint voice guid would build the LinkedIn voice URL, not the iMessage one", () => {
  // Mirrors the decision in imessage-media.tsx: the dashboard appends the
  // guid to one of two runner endpoints based solely on this predicate.
  const guid = "li-msg-fp:IN|Uwa Okungbowa|Feb 19|7:16 PM|[voice message]";
  const url = isLinkedInVoiceForUrl(guid)
    ? `/runner/data/linkedin-voice-message/${encodeURIComponent(guid)}`
    : `/runner/data/imessage-attachment/${encodeURIComponent(guid)}`;
  assert.ok(
    url.startsWith("/runner/data/linkedin-voice-message/"),
    "id-less voice bubble must hit the LinkedIn voice endpoint, not the iMessage attachment endpoint"
  );
});

function isLinkedInVoiceForUrl(guid) {
  return dashboardImpl(guid);
}
