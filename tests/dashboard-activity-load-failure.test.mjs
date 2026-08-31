import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  activityReceiptPresentation,
  beginActivityLoad,
  createLatestActivityLoader,
  failActivityLoad,
  initialActivityLoadState,
  finishActivityLoad
} = await import("../apps/dashboard/lib/activity-load.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createActivityHarness() {
  let state = initialActivityLoadState();
  const loader = createLatestActivityLoader((update) => {
    state = update(state);
  });
  return { loader, read: () => state };
}

const activitySource = readFileSync(
  new URL("../apps/dashboard/app/logs/page.tsx", import.meta.url),
  "utf8"
);

test("a failed initial Activity load settles as retryable error, not empty or loading", () => {
  const pending = beginActivityLoad(initialActivityLoadState());
  const failed = failActivityLoad(pending, "Runner unavailable");

  assert.deepEqual(failed, {
    rows: null,
    pending: false,
    error: "Runner unavailable"
  });
  assert.match(activitySource, /role="alert"/);
  assert.match(
    activitySource,
    /loadState\.pending \? "Trying again…" : "Try again"/
  );
  assert.deepEqual(activityReceiptPresentation(failed), {
    count: null,
    drawerAvailable: false
  });
  assert.doesNotMatch(activitySource, /logs\?\.length \?\? 0/);
  assert.match(activitySource, /receiptPresentation\.count === null/);
  assert.match(activitySource, /receiptPresentation\.drawerAvailable \? \(/);
});

test("retry leaves the error state and every result settles pending", () => {
  const failed = failActivityLoad(
    beginActivityLoad(initialActivityLoadState()),
    "Runner unavailable"
  );
  const retrying = beginActivityLoad(failed);
  const empty = finishActivityLoad(retrying, []);

  assert.deepEqual(retrying, {
    rows: null,
    pending: true,
    error: "Runner unavailable"
  });
  assert.deepEqual(empty, { rows: [], pending: false, error: null });
});

test("a failed refresh preserves previously loaded receipts", () => {
  const loaded = finishActivityLoad(initialActivityLoadState(), [
    { id: "receipt-1" }
  ]);
  const failed = failActivityLoad(beginActivityLoad(loaded), "Refresh failed");

  assert.deepEqual(failed, {
    rows: [{ id: "receipt-1" }],
    pending: false,
    error: "Refresh failed"
  });
  assert.deepEqual(activityReceiptPresentation(failed), {
    count: 1,
    drawerAvailable: true
  });
  assert.match(
    activitySource,
    /open=\{receiptPresentation\.drawerAvailable && drawerOpen\}/
  );
});

test("a late older Activity response cannot replace the newer result", async () => {
  const first = deferred();
  const second = deferred();
  const activity = createActivityHarness();

  const firstRefresh = activity.loader.refresh(() => first.promise);
  const secondRefresh = activity.loader.refresh(() => second.promise);
  second.resolve([{ id: "newest" }]);
  await secondRefresh;
  first.resolve([{ id: "stale" }]);
  await firstRefresh;

  assert.deepEqual(activity.read(), {
    rows: [{ id: "newest" }],
    pending: false,
    error: null
  });
});

test("an early older Activity response leaves the newer request pending", async () => {
  const first = deferred();
  const second = deferred();
  const activity = createActivityHarness();

  const firstRefresh = activity.loader.refresh(() => first.promise);
  const secondRefresh = activity.loader.refresh(() => second.promise);
  first.resolve([{ id: "stale" }]);
  await firstRefresh;
  assert.deepEqual(activity.read(), {
    rows: null,
    pending: true,
    error: null
  });

  second.resolve([{ id: "newest" }]);
  await secondRefresh;
  assert.deepEqual(activity.read(), {
    rows: [{ id: "newest" }],
    pending: false,
    error: null
  });
});
