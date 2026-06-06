import test from "node:test";
import assert from "node:assert/strict";
import { linkedInVoiceResponseMatchesRequest } from "../apps/runner/dist/services/linkedin-voice-store.js";

// Regression for BUG PM5: captureLinkedInVoiceMessage armed an UNSCOPED
// `waitForResponse(r => /messaging-audio-analyzed/.test(r.url()))`. The
// backfill loop captures voice notes one at a time; when an earlier note's
// fetch is slow and its 8s wait times out (the play-click already fired, the
// fetch is still in flight), the loop arms a fresh unscoped wait for the next
// note. The earlier note's LATE response — same URL pattern, different
// message — then resolves the next note's wait first, so one message's audio
// bytes get written under another message's urn and the wrong audio is
// transcribed.
//
// The fix correlates on the exact request the play-click triggered:
// `linkedInVoiceResponseMatchesRequest` only accepts a response whose request
// IS the one this capture is waiting on. These sentinels stand in for
// Playwright `Request` objects (the matcher compares them by identity).

const audioUrl = "https://www.linkedin.com/dms/prv/vid/v2/X/messaging-audio-analyzed/0/Y?m=Z";
const otherAudioUrl = "https://www.linkedin.com/dms/prv/vid/v2/A/messaging-audio-analyzed/0/B?m=C";

test("accepts the response whose request is the one this capture awaits", () => {
  const awaited = { id: "B" };
  const response = { request: awaited };
  assert.equal(
    linkedInVoiceResponseMatchesRequest(audioUrl, response.request, awaited),
    true
  );
});

test("rejects an earlier note's late response even though the URL pattern matches", () => {
  // Note A's request fired, its wait timed out, the loop moved on to note B
  // and is now awaiting note B's request. Note A's audio response finally
  // arrives: URL still matches `messaging-audio-analyzed`, but it belongs to
  // A's request, not B's. The OLD url-only predicate would have accepted this
  // and written A's bytes under B's urn. The scoped matcher must reject it.
  const requestA = { id: "A" };
  const requestB = { id: "B" };
  const lateResponseForA = { request: requestA, url: otherAudioUrl };
  assert.equal(
    linkedInVoiceResponseMatchesRequest(
      lateResponseForA.url,
      lateResponseForA.request,
      requestB
    ),
    false,
    "a different message's audio response must not satisfy this capture's wait"
  );
});

test("rejects a non-audio response regardless of request identity", () => {
  const awaited = { id: "B" };
  assert.equal(
    linkedInVoiceResponseMatchesRequest(
      "https://www.linkedin.com/voyager/api/messaging/conversations",
      awaited,
      awaited
    ),
    false
  );
});

test("two concurrent captures never cross bytes: each accepts only its own request", () => {
  // Simulates the overlap window: requests A and B are both in flight, both
  // produce `messaging-audio-analyzed` responses. Capture A waits on requestA,
  // capture B waits on requestB. Each must claim exactly its own response.
  const requestA = { id: "A" };
  const requestB = { id: "B" };
  const responseForA = { request: requestA, url: audioUrl };
  const responseForB = { request: requestB, url: otherAudioUrl };

  // Capture A's matcher: takes A's response, refuses B's.
  assert.equal(
    linkedInVoiceResponseMatchesRequest(responseForA.url, responseForA.request, requestA),
    true
  );
  assert.equal(
    linkedInVoiceResponseMatchesRequest(responseForB.url, responseForB.request, requestA),
    false
  );

  // Capture B's matcher: takes B's response, refuses A's.
  assert.equal(
    linkedInVoiceResponseMatchesRequest(responseForB.url, responseForB.request, requestB),
    true
  );
  assert.equal(
    linkedInVoiceResponseMatchesRequest(responseForA.url, responseForA.request, requestB),
    false
  );
});
