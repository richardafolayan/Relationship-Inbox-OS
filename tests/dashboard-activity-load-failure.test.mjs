import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
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
});
