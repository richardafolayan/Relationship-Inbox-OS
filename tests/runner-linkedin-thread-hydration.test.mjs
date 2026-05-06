import test from "node:test";
import assert from "node:assert/strict";
import { isLinkedInThreadHydrated } from "../apps/runner/dist/platforms/linkedin-adapter.js";

// `isLinkedInThreadHydrated` decides whether the LinkedIn messaging panel
// is ready to be scraped after clicking a thread row. The Joshua-thread
// regression: a real-world rescan saw activated:true, correctThread:true,
// messageCount:5, spinnerCount:0 but blocked forever on
// fingerprintChanged:false — the user reported that a freshly-arrived
// inbound message ("Is it more timing or you've already got it covered?")
// didn't appear in the dashboard despite a rescan. This test pins the
// fixed behavior so the regression can't come back silently.

const baseSignals = {
  activated: false,
  correctThread: false,
  alreadyActiveCandidate: false,
  fingerprintChanged: false,
  hadBeforeFingerprint: true,
  tokenConflicts: false,
  messageCount: 0,
  spinnerCount: 0,
  emptyStateCount: 0
};

test("Joshua-thread case: structurally ready even when fingerprintChanged is false", () => {
  // The exact signal set captured from the failing rescan trace.
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: true,
    correctThread: true,
    messageCount: 5,
    spinnerCount: 0,
    fingerprintChanged: false,
    hadBeforeFingerprint: true,
    tokenConflicts: false
  });
  assert.equal(result, true, "should accept hydration once activated + correctThread + messages render");
});

test("token conflicts always block — clicking the wrong thread", () => {
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: true,
    correctThread: true,
    messageCount: 5,
    tokenConflicts: true
  });
  assert.equal(result, false, "tokenConflicts must veto every other positive signal");
});

test("spinner with no messages: keep waiting", () => {
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: true,
    correctThread: true,
    messageCount: 0,
    spinnerCount: 1
  });
  assert.equal(result, false, "loading spinner with empty list means panel is mid-hydration");
});

test("empty state without spinner: hydrated (truly empty thread)", () => {
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: true,
    correctThread: true,
    messageCount: 0,
    spinnerCount: 0,
    emptyStateCount: 1,
    fingerprintChanged: false,
    hadBeforeFingerprint: false
  });
  assert.equal(result, true, "empty-state UI rendered with no spinner is a terminal state");
});

test("alreadyActiveCandidate fast path: hydrated as soon as messages are present", () => {
  // We were on this thread before the click — no need to wait for transitions.
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    alreadyActiveCandidate: true,
    correctThread: true,
    messageCount: 3
  });
  assert.equal(result, true);
});

test("classic hydrated path: messages rendered AND fingerprint changed", () => {
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: true,
    correctThread: true,
    messageCount: 4,
    fingerprintChanged: true,
    hadBeforeFingerprint: true
  });
  assert.equal(result, true);
});

test("first-ever open path: no prior fingerprint to compare against", () => {
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: true,
    correctThread: true,
    messageCount: 4,
    fingerprintChanged: false,
    hadBeforeFingerprint: false
  });
  assert.equal(result, true);
});

test("not activated and not correctThread: keep waiting", () => {
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: false,
    correctThread: false,
    messageCount: 5
  });
  assert.equal(result, false, "must have at least one alignment signal before scraping");
});

test("activated alone (without correctThread) is not enough", () => {
  // Defensive: activated can fire from any descriptor change, including
  // navigating to the WRONG thread. correctThread is the safety check.
  const result = isLinkedInThreadHydrated({
    ...baseSignals,
    activated: true,
    correctThread: false,
    messageCount: 5,
    spinnerCount: 0,
    fingerprintChanged: false
  });
  assert.equal(result, false);
});
