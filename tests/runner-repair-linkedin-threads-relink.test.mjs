import test from "node:test";
import assert from "node:assert/strict";
import { planThreadMergeRelinkage } from "../apps/runner/dist/scripts/repair-linkedin-threads.js";

// Bug Q3 (data-loss): the LinkedIn thread-merge repair deletes the duplicate
// Thread with prisma.thread.delete. Draft.thread and SendRequest.thread both
// carry `onDelete: Cascade` in the schema, so before the fix the duplicate's
// saved reply Draft and its PENDING/SCHEDULED SendRequest rows were silently
// cascade-deleted — a queued or scheduled send just vanished — because the
// apply loop only re-pointed Message rows.
//
// planThreadMergeRelinkage is the pure rule the apply loop now consults BEFORE
// the delete to decide what to migrate onto the keeper. These cases pin the
// behaviour so the regression cannot come back silently.

test("send requests always re-point to the keeper (queued/scheduled sends are never dropped)", () => {
  // Keeper has no draft of its own — the common case.
  const plan = planThreadMergeRelinkage({
    keepThreadId: "keep",
    mergeThreadId: "merge",
    keeperHasDraft: false
  });
  assert.equal(plan.relinkSendRequests, true);
});

test("duplicate's draft moves to the keeper when the keeper has no draft", () => {
  const plan = planThreadMergeRelinkage({
    keepThreadId: "keep",
    mergeThreadId: "merge",
    keeperHasDraft: false
  });
  assert.equal(plan.relinkDraft, true);
  assert.equal(plan.dropDuplicateDraft, false);
});

test("keeper already has a draft: keep it, drop the duplicate's (no double draft)", () => {
  const plan = planThreadMergeRelinkage({
    keepThreadId: "keep",
    mergeThreadId: "merge",
    keeperHasDraft: true
  });
  assert.equal(plan.relinkDraft, false);
  assert.equal(plan.dropDuplicateDraft, true);
  // Send requests still always move regardless of the draft outcome.
  assert.equal(plan.relinkSendRequests, true);
});

test("draft re-point and drop are mutually exclusive in both branches", () => {
  for (const keeperHasDraft of [true, false]) {
    const plan = planThreadMergeRelinkage({
      keepThreadId: "keep",
      mergeThreadId: "merge",
      keeperHasDraft
    });
    assert.notEqual(
      plan.relinkDraft,
      plan.dropDuplicateDraft,
      `exactly one of relinkDraft/dropDuplicateDraft must be true (keeperHasDraft=${keeperHasDraft})`
    );
  }
});
