import test from "node:test";
import assert from "node:assert/strict";
import {
  decideOutboundDedup,
  normalizeOutboundTextForDedup
} from "../apps/runner/dist/services/scan-queue.js";

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

// --- Lanre iMessage case: whitespace-divergent twin ----------------------
// send.ts persists the operator's raw text (a dictation artifact left a
// leading space on a wrapped line); the scan parser re-reads the same message
// from chat.db and stores cleanMessageText output, which trims each line. The
// two rows then differ by exactly one space, which an exact-equality twin
// check misses — the user saw two identical 17:15 bubbles, one tagged "sent
// via automation". These pin the whitespace-insensitive dedup.

const rawSendTimeText =
  "Okay, so I was just thinking of this idea, right? It could feel like they're not being heard.\n So that if I put a time block, they get a nudge.";
const cleanedScanText =
  "Okay, so I was just thinking of this idea, right? It could feel like they're not being heard.\nSo that if I put a time block, they get a nudge.";

test("Lanre case: raw send-time twin still matches the cleaned scan text (migrate)", () => {
  // Sanity: the two texts really do differ (so this isn't a trivial pass).
  assert.notEqual(rawSendTimeText, cleanedScanText);
  const decision = decideOutboundDedup({
    newKey: "imessage-guid-canonical",
    newTimestamp: new Date("2026-06-05T16:15:20Z"),
    newText: cleanedScanText,
    existingTwins: [
      {
        id: "msg-send-time-automation",
        platformMessageKey: "stable-hash-send-time",
        text: rawSendTimeText,
        timestamp: new Date("2026-06-05T16:15:20Z")
      }
    ],
    existingCanonical: null
  });
  assert.deepEqual(decision, {
    kind: "migrate_twin_key",
    twinId: "msg-send-time-automation"
  });
});

test("Lanre case: with the guid canonical already present, drop the whitespace-divergent twin", () => {
  const decision = decideOutboundDedup({
    newKey: "imessage-guid-canonical",
    newTimestamp: new Date("2026-06-05T16:15:20Z"),
    newText: cleanedScanText,
    existingTwins: [
      {
        id: "msg-send-time-automation",
        platformMessageKey: "stable-hash-send-time",
        text: rawSendTimeText,
        timestamp: new Date("2026-06-05T16:15:20Z")
      }
    ],
    existingCanonical: {
      id: "msg-guid-canonical",
      platformMessageKey: "imessage-guid-canonical",
      text: cleanedScanText,
      timestamp: new Date("2026-06-05T16:15:20Z")
    }
  });
  assert.deepEqual(decision, { kind: "delete_twin", twinId: "msg-send-time-automation" });
});

test("genuinely different text is still NOT collapsed by whitespace normalization", () => {
  // Guard against over-eager dedup: collapsing whitespace must not make two
  // distinct messages look identical.
  const decision = decideOutboundDedup({
    ...baseInput,
    existingTwins: [{ ...sendTimeRow, text: "A completely different reply" }]
  });
  assert.equal(decision.kind, "no_op");
});

test("normalizeOutboundTextForDedup collapses whitespace runs and trims", () => {
  assert.equal(normalizeOutboundTextForDedup("heard.\n So that"), "heard. So that");
  assert.equal(normalizeOutboundTextForDedup("heard.\nSo that"), "heard. So that");
  assert.equal(normalizeOutboundTextForDedup("  hi   there \t\n"), "hi there");
  assert.equal(normalizeOutboundTextForDedup("same"), "same");
  // The two real Lanre payloads normalize to the same string.
  assert.equal(
    normalizeOutboundTextForDedup(rawSendTimeText),
    normalizeOutboundTextForDedup(cleanedScanText)
  );
});
