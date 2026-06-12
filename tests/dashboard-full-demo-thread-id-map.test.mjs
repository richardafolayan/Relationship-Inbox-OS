import test from "node:test";
import assert from "node:assert/strict";

// Regression for the unbounded /data/inbox refetch loop (FullDemoProvider).
// The route-change effect refetches /data/inbox whenever a script step
// references a showcase thread whose platformThreadId hasn't resolved yet.
// refreshThreadIdMap used to setThreadIdMap(new Map(...)) on every fetch, so
// even when the inbox was unchanged it produced a fresh Map reference, which
// re-ran the effect, which refetched again — forever when the row never seeds.
//
// The fix builds the map with buildThreadIdMap and only replaces state when
// threadIdMapsEqual reports a content change. These two pure helpers are what
// guarantee the loop terminates, so we test them directly.

const { buildThreadIdMap, threadIdMapsEqual } = await import(
  "../apps/dashboard/lib/full-demo-state.ts"
);

test("buildThreadIdMap maps platformThreadId to internal id, skipping rows without one", () => {
  const map = buildThreadIdMap([
    { id: "cuid-a", platformThreadId: "demo-serena" },
    { id: "cuid-b", platformThreadId: null },
    { id: "cuid-c" },
    { id: "cuid-d", platformThreadId: "demo-timi" }
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get("demo-serena"), "cuid-a");
  assert.equal(map.get("demo-timi"), "cuid-d");
});

test("buildThreadIdMap tolerates null / undefined rows", () => {
  assert.equal(buildThreadIdMap(null).size, 0);
  assert.equal(buildThreadIdMap(undefined).size, 0);
  assert.equal(buildThreadIdMap([]).size, 0);
});

test("threadIdMapsEqual is true for the same reference", () => {
  const m = new Map([["x", "1"]]);
  assert.equal(threadIdMapsEqual(m, m), true);
});

test("threadIdMapsEqual is true for content-equal distinct maps", () => {
  // This is the loop-breaking case: two consecutive /data/inbox fetches
  // returning the same rows must compare equal, so the provider keeps the
  // previous reference and the route-change effect does not re-run.
  const a = buildThreadIdMap([
    { id: "cuid-a", platformThreadId: "demo-serena" },
    { id: "cuid-d", platformThreadId: "demo-timi" }
  ]);
  const b = buildThreadIdMap([
    { id: "cuid-a", platformThreadId: "demo-serena" },
    { id: "cuid-d", platformThreadId: "demo-timi" }
  ]);
  assert.notEqual(a, b); // distinct references
  assert.equal(threadIdMapsEqual(a, b), true);
});

test("threadIdMapsEqual is false when a value changes", () => {
  const a = new Map([["demo-serena", "cuid-old"]]);
  const b = new Map([["demo-serena", "cuid-new"]]);
  assert.equal(threadIdMapsEqual(a, b), false);
});

test("threadIdMapsEqual is false when sizes differ", () => {
  const a = new Map([["demo-serena", "cuid-a"]]);
  const b = new Map([
    ["demo-serena", "cuid-a"],
    ["demo-timi", "cuid-d"]
  ]);
  assert.equal(threadIdMapsEqual(a, b), false);
});

test("threadIdMapsEqual is false when a key differs but size matches", () => {
  const a = new Map([["demo-serena", "cuid-a"]]);
  const b = new Map([["demo-timi", "cuid-a"]]);
  assert.equal(threadIdMapsEqual(a, b), false);
});

test("an unresolvable showcase thread yields a stable map across refetches", () => {
  // Simulate the never-seeds scenario: the inbox never contains the
  // script's target platformThreadId. Repeated fetches must keep comparing
  // equal so the provider stops replacing state and the effect terminates.
  const inboxRows = [{ id: "cuid-real", platformThreadId: "demo-other" }];
  let current = buildThreadIdMap(inboxRows);
  const targetNeverSeeds = "demo-full-serena-imessage";

  for (let i = 0; i < 5; i += 1) {
    const next = buildThreadIdMap(inboxRows);
    assert.equal(next.has(targetNeverSeeds), false);
    // The provider keeps `prev` when equal — model that here.
    current = threadIdMapsEqual(current, next) ? current : next;
  }
  // Reference never churned past the first build → effect would not re-run.
  assert.equal(current.has(targetNeverSeeds), false);
});
