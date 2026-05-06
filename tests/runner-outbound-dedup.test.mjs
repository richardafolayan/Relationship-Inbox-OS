import test from "node:test";
import assert from "node:assert/strict";
import { decideOutboundDedup } from "../apps/runner/dist/services/scan-queue.js";

// `decideOutboundDedup` reconciles the two paths that persist outbound
// messages — send.ts at send time (keyed by stableHash(sentAt|text)) and
// scan-queue.ts at scan parse time (keyed by LinkedIn's data-event-urn or a
// stableHash with the parsed list timestamp). Different keys for the same
// physical message produce duplicate rows; the user reported this for
// Joshua Martin's thread — two identical 18:56 bubbles. These cases pin
// the dedup rule so the regression can't come back silently.

const sendTimeRow = {
  id: "msg-send-time",
  platformMessageKey: "stable-hash-send-time",
  text: "Appreciate you reaching out, but i'm not interested at this time, thank you.",
  timestamp: new Date("2026-05-06T17:56:07Z")
};

const baseInput = {
  newKey: "linkedin-event-urn-canonical",
  newTimestamp: new Date("2026-05-06T17:56:00Z"),
  newText: sendTimeRow.text,
  existingTwins: [],
  existingCanonical: null
};

test("Joshua-thread case: scan finds the send-time twin and migrates its key to the urn", () => {
  // Two persistence paths recorded the same outbound 7s apart with different
  // keys — exactly the bug that produced two identical 18:56 bubbles.
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [sendTimeRow],
    existingCanonical: null
  });
  assert.deepEqual(decision, { kind: "migrate_twin_key", twinId: "msg-send-time" });
});

test("twin AND canonical exist: drop the send-time twin (urn row wins)", () => {
  // A previous scan already persisted the urn-keyed row; this scan sees the
  // send-time twin still hanging around. Delete the duplicate, leave the
  // canonical row alone.
  const canonical = {
    id: "msg-urn-canonical",
    platformMessageKey: "linkedin-event-urn-canonical",
    text: sendTimeRow.text,
    timestamp: new Date("2026-05-06T17:56:00Z")
  };
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [sendTimeRow],
    existingCanonical: canonical
  });
  assert.deepEqual(decision, { kind: "delete_twin", twinId: "msg-send-time" });
});

test("no existing twins: no_op (clean upsert path)", () => {
  const decision = decideOutboundDedup({ ...baseInput });
  assert.equal(decision.kind, "no_op");
});

test("twin with same key as new message is not a duplicate", () => {
  // The findMany filter uses platformMessageKey: { not: key } so this should
  // never reach the function in production, but the function is defensive.
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [{ ...sendTimeRow, platformMessageKey: baseInput.newKey }]
  });
  assert.equal(decision.kind, "no_op");
});

test("twin with different text is not a duplicate", () => {
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [
      {
        ...sendTimeRow,
        text: "Different message text"
      }
    ]
  });
  assert.equal(decision.kind, "no_op");
});

test("twin outside 5-minute window is not a duplicate", () => {
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [
      {
        ...sendTimeRow,
        // 6 minutes after the new timestamp — outside default window
        timestamp: new Date(baseInput.newTimestamp.getTime() + 6 * 60 * 1000)
      }
    ]
  });
  assert.equal(decision.kind, "no_op");
});

test("twin exactly at window boundary IS still a duplicate", () => {
  // 5 minutes is inclusive — the boundary is a real twin.
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [
      {
        ...sendTimeRow,
        timestamp: new Date(baseInput.newTimestamp.getTime() + 5 * 60 * 1000)
      }
    ]
  });
  assert.equal(decision.kind, "migrate_twin_key");
});

test("twin slightly before AND slightly after both detected", () => {
  // Send.ts records exact send time; scan timestamp could be earlier or
  // later than the recorded send. Window is two-sided.
  const before = decideOutboundDedup({
    ...baseInput,
    existingTwins: [
      {
        ...sendTimeRow,
        timestamp: new Date(baseInput.newTimestamp.getTime() - 30 * 1000)
      }
    ]
  });
  const after = decideOutboundDedup({
    ...baseInput,
    existingTwins: [
      {
        ...sendTimeRow,
        timestamp: new Date(baseInput.newTimestamp.getTime() + 30 * 1000)
      }
    ]
  });
  assert.equal(before.kind, "migrate_twin_key");
  assert.equal(after.kind, "migrate_twin_key");
});

test("custom windowMs override (test scaffold for tighter dedup tolerances)", () => {
  // Allow callers to tune the window. Tighter windows would catch fewer false
  // positives but also miss real twins when clocks drift more.
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [
      {
        ...sendTimeRow,
        timestamp: new Date(baseInput.newTimestamp.getTime() + 30 * 1000)
      }
    ],
    windowMs: 10 * 1000
  });
  assert.equal(decision.kind, "no_op", "30s twin should be excluded with 10s window");
});

test("multiple twins: takes the first match (find semantics)", () => {
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [
      sendTimeRow,
      { ...sendTimeRow, id: "msg-second-duplicate" }
    ]
  });
  assert.equal(decision.kind, "migrate_twin_key");
  // The function takes whichever the array iterator finds first; both are
  // valid actions to take. The persist loop will run again on the next
  // message (or on a follow-up scan) and clean up the second one.
  assert.equal(decision.twinId, "msg-send-time");
});
