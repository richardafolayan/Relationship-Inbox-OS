import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  activityReceiptPresentation,
  beginActivityLoad,
  failActivityLoad,
  initialActivityLoadState,
  finishActivityLoad
} = await import("../apps/dashboard/lib/activity-load.ts");

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
