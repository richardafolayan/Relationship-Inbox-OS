import test from "node:test";
import assert from "node:assert/strict";
import {
  priorReplyDebtExists,
  resolveModeNeedsReply,
  persistedNeedsReplyFromBrief
} from "../apps/runner/dist/services/reply-brief.js";

// #380 follow-up: a single partial reply must not tip the thread out of
// active-reply mode while contact topics remain unanswered. These cover the
// pure decision helpers that gate the summariser's mode signal and the
// persisted thread.needsReply flag.

const brief = (requiredCount) => ({
  where_it_stands: "",
  on_you: "",
  they_said: [],
  required_points: Array.from({ length: requiredCount }, (_, i) => ({
    id: `r${i}`,
    text: `point ${i}`,
    status: "required"
  })),
  optional_followups: [],
  handled_points: [],
  fuller_context: null,
  durable_context: null,
  tone_steer: null,
  enough_to_reply_without_scrolling: true
});

test("priorReplyDebtExists: previous brief with required points => true", () => {
  assert.equal(
    priorReplyDebtExists({ previousReplyBrief: brief(3), previousOpenLoops: [], dismissedOpenLoops: [] }),
    true
  );
});

test("priorReplyDebtExists: previous brief with no required points => false", () => {
  assert.equal(
    priorReplyDebtExists({ previousReplyBrief: brief(0), previousOpenLoops: ["x"], dismissedOpenLoops: [] }),
    false,
    "structured brief wins over legacy open_loops"
  );
});

test("priorReplyDebtExists: no brief, falls back to open loops minus dismissed", () => {
  assert.equal(
    priorReplyDebtExists({ previousReplyBrief: null, previousOpenLoops: ["Reply about the move"], dismissedOpenLoops: [] }),
    true
  );
  assert.equal(
    priorReplyDebtExists({
      previousReplyBrief: null,
      previousOpenLoops: ["Reply about the move"],
      dismissedOpenLoops: ["reply about the move"]
    }),
    false,
    "case-insensitive dismissal clears the only loop"
  );
  assert.equal(
    priorReplyDebtExists({ previousReplyBrief: null, previousOpenLoops: [], dismissedOpenLoops: [] }),
    false
  );
  assert.equal(
    priorReplyDebtExists({ previousReplyBrief: null, previousOpenLoops: ["   "], dismissedOpenLoops: [] }),
    false,
    "whitespace-only loops do not count"
  );
});

test("resolveModeNeedsReply: OR of timestamp and prior debt", () => {
  assert.equal(resolveModeNeedsReply(true, false), true);
  assert.equal(resolveModeNeedsReply(false, true), true, "prior debt keeps active mode after a reply");
  assert.equal(resolveModeNeedsReply(false, false), false);
  assert.equal(resolveModeNeedsReply(true, true), true);
});

test("persistedNeedsReplyFromBrief: settles on the CURRENT brief", () => {
  // Operator hasn't replied yet -> always needs reply.
  assert.equal(persistedNeedsReplyFromBrief(true, brief(0)), true);
  // Replied once, but the model still finds open required points -> stays true.
  assert.equal(persistedNeedsReplyFromBrief(false, brief(4)), true);
  // Replied and everything is now handled -> clears (the settling case).
  assert.equal(persistedNeedsReplyFromBrief(false, brief(0)), false);
  // No brief produced (AI degraded) -> fall back to the timestamp signal.
  assert.equal(persistedNeedsReplyFromBrief(false, null), false);
  assert.equal(persistedNeedsReplyFromBrief(true, null), true);
});

test("acceptance: 5 topics, reply to 1 -> active with 4 open, then settles", () => {
  // Before the reply: brief had 5 required points; timestamp said needs-reply.
  const before = brief(5);
  // Operator replies to ONE topic. Timestamp now says "already replied".
  const timestampAfterReply = false;
  // Mode signal still active because reply debt remained.
  assert.equal(
    resolveModeNeedsReply(timestampAfterReply, priorReplyDebtExists({ previousReplyBrief: before, previousOpenLoops: [], dismissedOpenLoops: [] })),
    true
  );
  // Model re-evaluates and keeps the other 4 as required points.
  const afterPartial = brief(4);
  assert.equal(persistedNeedsReplyFromBrief(timestampAfterReply, afterPartial), true, "still owes 4 replies");
  // Later, operator clears the remaining 4 -> required_points empty -> settles.
  const afterAll = brief(0);
  assert.equal(persistedNeedsReplyFromBrief(timestampAfterReply, afterAll), false, "nudge clears once handled");
});
