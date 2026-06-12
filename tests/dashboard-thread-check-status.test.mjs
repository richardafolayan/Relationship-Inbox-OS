import test from "node:test";
import assert from "node:assert/strict";

// Per-thread "check for new messages" ticker state. The rescan progress
// used to render inline in the thread header ("Reading messages…"); it now
// lives in the TopStatus ticker, named after the contact, with a transient
// result line answering "were there any new messages?". These tests cover
// the event reducer (start / progress / finish ordering, bulk overlap,
// stale pruning, failed checks) and the copy.

const {
  EMPTY_THREAD_CHECK,
  THREAD_CHECK_RESULT_FRESH_MS,
  isThreadCheckEvent,
  reduceThreadCheck,
  selectThreadCheck,
  threadCheckLabel
} = await import("../apps/dashboard/lib/thread-check-status.ts");

const T0 = 1_000_000;

function started(threadId, personName) {
  return { type: "SCAN_THREAD_STARTED", threadId, personName };
}

function progress(threadId, stage, personName) {
  return { type: "SCAN_THREAD_PROGRESS", threadId, stage, personName };
}

function finished(threadId, personName, newMessages, failed) {
  return { type: "SCAN_THREAD_FINISHED", threadId, personName, newMessages, failed };
}

test("isThreadCheckEvent: matches only the SCAN_THREAD_* family", () => {
  assert.equal(isThreadCheckEvent("SCAN_THREAD_STARTED"), true);
  assert.equal(isThreadCheckEvent("SCAN_THREAD_PROGRESS"), true);
  assert.equal(isThreadCheckEvent("SCAN_THREAD_FINISHED"), true);
  assert.equal(isThreadCheckEvent("SCAN_STARTED"), false);
  assert.equal(isThreadCheckEvent("THREAD_UPDATED"), false);
  assert.equal(isThreadCheckEvent(undefined), false);
});

test("start -> checking with the contact's name", () => {
  const snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", "Tola"), T0);
  const ticker = selectThreadCheck(snap, T0 + 1000);
  assert.deepEqual(ticker, { kind: "checking", personName: "Tola", count: 1 });
  assert.equal(threadCheckLabel(ticker), "Checking Tola's messages");
});

test("progress without a prior start still registers (missed STARTED)", () => {
  const snap = reduceThreadCheck(
    EMPTY_THREAD_CHECK,
    progress("t1", "Reading messages", "Tola"),
    T0
  );
  const ticker = selectThreadCheck(snap, T0);
  assert.deepEqual(ticker, { kind: "checking", personName: "Tola", count: 1 });
});

test("progress keeps the name from STARTED when the event omits it", () => {
  let snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", "Tola"), T0);
  snap = reduceThreadCheck(snap, progress("t1", "Saving updates", undefined), T0 + 500);
  const ticker = selectThreadCheck(snap, T0 + 500);
  assert.equal(ticker.personName, "Tola");
});

test("finish -> transient result, then ages out", () => {
  let snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", "Tola"), T0);
  snap = reduceThreadCheck(snap, finished("t1", "Tola", 2), T0 + 3000);
  const fresh = selectThreadCheck(snap, T0 + 3000);
  assert.deepEqual(fresh, { kind: "checked", personName: "Tola", newMessages: 2 });
  assert.equal(threadCheckLabel(fresh), "2 new messages from Tola");
  const stale = selectThreadCheck(snap, T0 + 3000 + THREAD_CHECK_RESULT_FRESH_MS + 1);
  assert.deepEqual(stale, { kind: "none" });
  assert.equal(threadCheckLabel(stale), "");
});

test("zero new messages reads as a clear no", () => {
  const snap = reduceThreadCheck(EMPTY_THREAD_CHECK, finished("t1", "Tola", 0), T0);
  const ticker = selectThreadCheck(snap, T0);
  assert.equal(threadCheckLabel(ticker), "No new messages from Tola");
});

test("singular copy for exactly one new message", () => {
  const snap = reduceThreadCheck(EMPTY_THREAD_CHECK, finished("t1", "Tola", 1), T0);
  assert.equal(threadCheckLabel(selectThreadCheck(snap, T0)), "1 new message from Tola");
});

test("older runner without newMessages -> neutral 'Checked' copy, never a false 'No new messages'", () => {
  const snap = reduceThreadCheck(
    EMPTY_THREAD_CHECK,
    { type: "SCAN_THREAD_FINISHED", threadId: "t1", personName: "Tola" },
    T0
  );
  assert.equal(threadCheckLabel(selectThreadCheck(snap, T0)), "Checked Tola's messages");
});

test("missing personName falls back to generic copy", () => {
  let snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", undefined), T0);
  assert.equal(threadCheckLabel(selectThreadCheck(snap, T0)), "Checking messages");
  snap = reduceThreadCheck(snap, finished("t1", undefined, 0), T0 + 1000);
  assert.equal(threadCheckLabel(selectThreadCheck(snap, T0 + 1000)), "No new messages");
});

test("failed check drops the active entry without minting a result", () => {
  let snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", "Tola"), T0);
  snap = reduceThreadCheck(snap, finished("t1", "Tola", undefined, true), T0 + 2000);
  assert.deepEqual(selectThreadCheck(snap, T0 + 2000), { kind: "none" });
});

test("failed check preserves an earlier successful result", () => {
  let snap = reduceThreadCheck(EMPTY_THREAD_CHECK, finished("t1", "Tola", 1), T0);
  snap = reduceThreadCheck(snap, started("t2", "Kaiye"), T0 + 1000);
  snap = reduceThreadCheck(snap, finished("t2", "Kaiye", undefined, true), T0 + 2000);
  const ticker = selectThreadCheck(snap, T0 + 2000);
  assert.deepEqual(ticker, { kind: "checked", personName: "Tola", newMessages: 1 });
});

test("bulk rescan: counts people, most recent activity names the label", () => {
  let snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", "Tola"), T0);
  snap = reduceThreadCheck(snap, started("t2", "Kaiye"), T0 + 100);
  snap = reduceThreadCheck(snap, started("t3", "Oti"), T0 + 200);
  const ticker = selectThreadCheck(snap, T0 + 300);
  assert.deepEqual(ticker, { kind: "checking", personName: "Oti", count: 3 });
  assert.equal(threadCheckLabel(ticker), "Checking messages for 3 people");

  // Progress on t1 moves it to the front of the label.
  snap = reduceThreadCheck(snap, progress("t1", "Reading messages", "Tola"), T0 + 400);
  assert.equal(selectThreadCheck(snap, T0 + 400).personName, "Tola");

  // Finishing them one by one shrinks the count, then surfaces the last result.
  snap = reduceThreadCheck(snap, finished("t1", "Tola", 0), T0 + 500);
  snap = reduceThreadCheck(snap, finished("t3", "Oti", 0), T0 + 600);
  assert.deepEqual(selectThreadCheck(snap, T0 + 700), {
    kind: "checking",
    personName: "Kaiye",
    count: 1
  });
  snap = reduceThreadCheck(snap, finished("t2", "Kaiye", 3), T0 + 800);
  assert.equal(threadCheckLabel(selectThreadCheck(snap, T0 + 900)), "3 new messages from Kaiye");
});

test("duplicate start for the same thread does not double-count", () => {
  let snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", "Tola"), T0);
  snap = reduceThreadCheck(snap, started("t1", "Tola"), T0 + 100);
  assert.equal(selectThreadCheck(snap, T0 + 200).count, 1);
});

test("a lost FINISHED ages the active entry out instead of stranding the ticker", () => {
  const snap = reduceThreadCheck(EMPTY_THREAD_CHECK, started("t1", "Tola"), T0);
  assert.equal(selectThreadCheck(snap, T0 + 44_000).kind, "checking");
  assert.deepEqual(selectThreadCheck(snap, T0 + 46_000), { kind: "none" });
});

test("non-thread-check events leave the snapshot untouched", () => {
  const snap = reduceThreadCheck(EMPTY_THREAD_CHECK, { type: "THREAD_UPDATED", threadId: "t1" }, T0);
  assert.equal(snap, EMPTY_THREAD_CHECK);
  const noId = reduceThreadCheck(EMPTY_THREAD_CHECK, { type: "SCAN_THREAD_STARTED" }, T0);
  assert.equal(noId, EMPTY_THREAD_CHECK);
});
