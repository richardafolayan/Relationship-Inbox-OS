import test from "node:test";
import assert from "node:assert/strict";

// inbox-events.ts is framework-free, so the tsx loader resolves this .ts
// import directly, the same way dashboard-inbox-bulk-rescan.test.mjs imports
// inbox-bulk.ts.
const { shouldInboxRefreshOnRunnerEvent } = await import(
  "../apps/dashboard/lib/inbox-events.ts"
);

// P4L1: the Inbox used to ignore the `runner-event` stream entirely (it only
// listened for `runner-resync` + a 10s poll), so a finished scan or a send
// from the thread page / another tab left it stale until the next poll while
// Today reflected it near-instantly. The fix mirrors Today's subscription;
// this helper is the decision Today and Inbox now share.

test("refreshes on the data-changing runner events (mirrors Today)", () => {
  assert.equal(shouldInboxRefreshOnRunnerEvent("THREAD_UPDATED"), true);
  assert.equal(shouldInboxRefreshOnRunnerEvent("MESSAGES_PERSISTED"), true);
  assert.equal(shouldInboxRefreshOnRunnerEvent("MESSAGE_SENT"), true);
  assert.equal(shouldInboxRefreshOnRunnerEvent("MESSAGE_SEND_FAILED"), true);
  assert.equal(shouldInboxRefreshOnRunnerEvent("SCAN_FINISHED"), true);
});

test("RESYNC_REQUIRED does NOT trigger a runner-event refresh", () => {
  // The shell re-dispatches RESYNC_REQUIRED as a separate `runner-resync`
  // event that the Inbox already handles; refreshing on the `runner-event`
  // copy too would double-fetch.
  assert.equal(shouldInboxRefreshOnRunnerEvent("RESYNC_REQUIRED"), false);
});

test("unknown / missing event types do not refetch (no refetch on noise)", () => {
  assert.equal(shouldInboxRefreshOnRunnerEvent("SOMETHING_ELSE"), false);
  assert.equal(shouldInboxRefreshOnRunnerEvent(""), false);
  assert.equal(shouldInboxRefreshOnRunnerEvent(undefined), false);
  assert.equal(shouldInboxRefreshOnRunnerEvent(null), false);
});

// --- Listener-wiring simulation -------------------------------------------
// Reproduces the inbox's `runner-event` handler: parse the event detail, and
// call the debounced refresh when the helper says so. Proves the regression:
// before the fix NO handler existed, so the events below would never refetch.

function makeInboxRunnerEventHandler(scheduleRefresh) {
  return (event) => {
    const detail = event?.detail;
    if (shouldInboxRefreshOnRunnerEvent(detail?.type)) {
      scheduleRefresh();
    }
  };
}

test("a SCAN_FINISHED event schedules exactly one inbox refresh", () => {
  let refreshes = 0;
  const handler = makeInboxRunnerEventHandler(() => {
    refreshes += 1;
  });
  handler({ detail: { type: "SCAN_FINISHED" } });
  assert.equal(refreshes, 1, "finished scan must refresh the open inbox");
});

test("newly persisted messages refresh before optional scan enrichment finishes", () => {
  let refreshes = 0;
  const handler = makeInboxRunnerEventHandler(() => {
    refreshes += 1;
  });
  handler({ detail: { type: "MESSAGES_PERSISTED", threadId: "t1" } });
  assert.equal(refreshes, 1);
});

test("a thread-page send (MESSAGE_SENT) refreshes the open inbox", () => {
  let refreshes = 0;
  const handler = makeInboxRunnerEventHandler(() => {
    refreshes += 1;
  });
  handler({ detail: { type: "MESSAGE_SENT", threadId: "t1" } });
  assert.equal(refreshes, 1, "a send elsewhere must refresh the inbox row");
});

test("a malformed / typeless event is ignored", () => {
  let refreshes = 0;
  const handler = makeInboxRunnerEventHandler(() => {
    refreshes += 1;
  });
  handler({ detail: {} });
  handler({ detail: undefined });
  handler({});
  assert.equal(refreshes, 0, "no refetch on noise");
});
