import test from "node:test";
import assert from "node:assert/strict";

// inbox-bulk.ts is framework-free, so the tsx loader resolves this .ts import
// directly, the same way dashboard-horizon.test.mjs imports horizon.ts.
const { bulkActionRemovesRow } = await import("../apps/dashboard/lib/inbox-bulk.ts");

test("membership-changing actions remove their rows optimistically", () => {
  assert.equal(bulkActionRemovesRow("Mark done"), true);
  assert.equal(bulkActionRemovesRow("Snooze 16h"), true);
});

test("Rescan does NOT remove its rows (BUG H2)", () => {
  // The regression: Rescan never flips needsReply, so it must not seed
  // removedIds or the row is stranded until a full reload.
  assert.equal(bulkActionRemovesRow("Rescan"), false);
});

test("unknown labels default to not-removing (safe choice)", () => {
  assert.equal(bulkActionRemovesRow("Something new"), false);
  assert.equal(bulkActionRemovesRow(""), false);
});

// --- End-to-end state-transition simulation -------------------------------
// Reproduces runBulk's optimistic add + applyInbox's self-heal to prove the
// fix. With the pre-fix "always remove" behaviour the rescanned, still-needs-
// reply id stays stuck in removedIds; gating the add on bulkActionRemovesRow
// keeps it out, so the row stays visible.

// applyInbox's removedIds reconciliation (apps/dashboard/app/inbox/page.tsx):
// keep an id only if it is still present AND needsReply !== false.
function applyInboxRemoved(prevRemoved, rows) {
  const stillPending = new Set(
    rows.filter((row) => row.needsReply !== false).map((row) => row.id)
  );
  const next = new Set();
  prevRemoved.forEach((id) => {
    if (stillPending.has(id)) next.add(id);
  });
  return next;
}

// runBulk's optimistic add, gated by the helper under test.
function runBulkOptimistic(prevRemoved, label, ids) {
  const next = new Set(prevRemoved);
  if (bulkActionRemovesRow(label)) {
    ids.forEach((id) => next.add(id));
  }
  return next;
}

// sections' filter: a row is shown only if it is not in removedIds.
const isVisible = (removed, id) => !removed.has(id);

test("Rescan leaves a still-needs-reply thread visible after refresh", () => {
  const id = "t1";
  // Server still reports the thread as needing a reply (Rescan didn't clear it).
  const rowsAfterRescan = [{ id, needsReply: true }];

  let removed = new Set();
  removed = runBulkOptimistic(removed, "Rescan", [id]);
  removed = applyInboxRemoved(removed, rowsAfterRescan);

  assert.equal(isVisible(removed, id), true, "rescanned row must stay visible");
});

test("pre-fix always-remove behaviour would strand the rescanned row", () => {
  // Guards the regression: if Rescan were treated as membership-changing,
  // applyInbox's self-heal can never clear it (row present + needsReply true),
  // so it would be hidden until reload.
  const id = "t1";
  const rowsAfterRescan = [{ id, needsReply: true }];

  let removed = new Set([id]); // simulate the old unconditional optimistic add
  removed = applyInboxRemoved(removed, rowsAfterRescan);

  assert.equal(isVisible(removed, id), false, "demonstrates the stranded-row bug");
});

test("Mark done still hides its row (self-heal clears it when needsReply flips)", () => {
  const id = "t2";
  // mark-done flips needsReply to false on the server.
  const rowsAfterMarkDone = [{ id, needsReply: false }];

  let removed = new Set();
  removed = runBulkOptimistic(removed, "Mark done", [id]);
  assert.equal(isVisible(removed, id), false, "hidden optimistically");

  removed = applyInboxRemoved(removed, rowsAfterMarkDone);
  // needsReply===false drops it from removedIds; the row itself is gone/handled
  // so it no longer shows in the active inbox regardless.
  assert.equal(removed.has(id), false, "removedIds self-heals once needsReply flips");
});
