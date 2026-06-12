import test from "node:test";
import assert from "node:assert/strict";

// Regression for P3-PL8: a single module-level debounce timer was cancelled
// unconditionally by cancelThreadPrefetch(), with no reference to which row
// scheduled it. Every row wires onFocus={() => prefetchThreadData(row.id)}
// AND onMouseLeave={cancelThreadPrefetch}, so keyboard focus and mouse hover
// are two simultaneously-live input paths into the same timer. Tabbing to
// Row A schedules A's prefetch; if the mouse then leaves a DIFFERENT Row B
// within the 80ms debounce, B's onMouseLeave cancelled A's pending timer, so
// A's prefetch never fired and the Enter click paid the cold round-trip.
//
// Fix: cancelThreadPrefetch(id) ignores the cancel when `id` does not match
// the row that scheduled the pending timer.

// Capture which paths the module warms by stubbing global fetch (apiGet ->
// apiGetRaw uses the global fetch with the path verbatim).
const warmed = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  warmed.push(String(url));
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const { prefetchThreadData, cancelThreadPrefetch } = await import(
  "../apps/dashboard/lib/thread-prefetch.ts"
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(() => {
  globalThis.fetch = realFetch;
});

test("a different row's cancel does not abort the focused row's pending prefetch", async () => {
  warmed.length = 0;

  // (1) Tab focuses Row A -> schedule A's 80ms prefetch.
  prefetchThreadData("A");
  // (2) Within the debounce, the mouse leaves a DIFFERENT Row B.
  cancelThreadPrefetch("B");

  // (3) After the debounce, A's prefetch must still have fired.
  await wait(160);

  assert.ok(
    warmed.some((u) => u.includes("/runner/data/thread/A")),
    `expected Row A to be prefetched despite Row B's cancel; warmed=${JSON.stringify(warmed)}`
  );
});

test("the owning row's cancel still cancels its own pending prefetch", async () => {
  warmed.length = 0;

  prefetchThreadData("A");
  cancelThreadPrefetch("A");

  await wait(160);

  assert.equal(
    warmed.length,
    0,
    `expected no prefetch after the owning row cancelled; warmed=${JSON.stringify(warmed)}`
  );
});

test("a bare cancel (no id) still cancels unconditionally", async () => {
  warmed.length = 0;

  prefetchThreadData("A");
  cancelThreadPrefetch();

  await wait(160);

  assert.equal(warmed.length, 0, `warmed=${JSON.stringify(warmed)}`);
});
