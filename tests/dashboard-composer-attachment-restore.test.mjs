import test from "node:test";
import assert from "node:assert/strict";

// composer-attachments.ts is framework-free, so the tsx loader resolves this
// .ts import directly (same pattern as dashboard-toast-gesture.test.mjs).
const { restoreFailedAttachments } = await import(
  "../apps/dashboard/lib/composer-attachments.ts"
);

// Regression for P1-L2: a failed send used to call
// setComposerAttachments(attachmentsToSend), unconditionally OVERWRITING
// whatever the operator staged while the send was in flight. Any newly-staged
// attachments were discarded and their previewUrl object URLs leaked (never
// revoked). The restore must now MERGE: prepend the failed attachments to the
// current list, preserving in-flight additions.

const att = (id) => ({ id, previewUrl: `blob:${id}` });

test("failed attachments are restored when nothing was staged meanwhile", () => {
  const failed = [att("a"), att("b")];
  const current = [];
  const merged = restoreFailedAttachments(failed, current);
  assert.deepEqual(
    merged.map((a) => a.id),
    ["a", "b"],
    "the failed attachments must come back"
  );
});

test("attachments staged DURING the in-flight send survive a restore", () => {
  // The bug: `current` (staged after the optimistic clear) was thrown away.
  const failed = [att("a"), att("b")];
  const current = [att("c"), att("d")]; // staged while the send was in flight
  const merged = restoreFailedAttachments(failed, current);
  assert.deepEqual(
    merged.map((a) => a.id),
    ["a", "b", "c", "d"],
    "in-flight-staged attachments must NOT be discarded by the restore"
  );
  // None of the in-flight previewUrls are dropped, so none can leak.
  for (const id of ["c", "d"]) {
    assert.ok(
      merged.some((a) => a.id === id && a.previewUrl === `blob:${id}`),
      `staged attachment ${id} and its previewUrl must be preserved`
    );
  }
});

test("failed attachments are prepended, ahead of in-flight additions", () => {
  const failed = [att("a")];
  const current = [att("b")];
  const merged = restoreFailedAttachments(failed, current);
  assert.deepEqual(merged.map((a) => a.id), ["a", "b"]);
});

test("inputs are not mutated (returns a fresh array)", () => {
  const failed = [att("a")];
  const current = [att("b")];
  const merged = restoreFailedAttachments(failed, current);
  assert.notEqual(merged, failed);
  assert.notEqual(merged, current);
  assert.equal(failed.length, 1);
  assert.equal(current.length, 1);
});
