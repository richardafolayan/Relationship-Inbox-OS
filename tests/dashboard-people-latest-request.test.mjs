import test from "node:test";
import assert from "node:assert/strict";

// latest-request.ts is framework-free, so the tsx loader resolves this .ts
// import directly (same pattern as dashboard-horizon.test.mjs). It backs the
// People page's loadDetail stale-response guard: when switching people
// quickly, only the latest detail fetch may write to state.
const { createLatestRequestGate, createLatestKeyedRequestGate } = await import(
  "../apps/dashboard/lib/latest-request.ts"
);

test("the most recent token is the latest", () => {
  const gate = createLatestRequestGate();
  const t1 = gate.next();
  assert.equal(gate.isLatest(t1), true);
});

test("starting a newer request marks the earlier one stale", () => {
  const gate = createLatestRequestGate();
  const tA = gate.next(); // request for person A
  const tB = gate.next(); // user switches to person B before A resolves
  assert.equal(gate.isLatest(tA), false, "A is stale once B started");
  assert.equal(gate.isLatest(tB), true, "B is the latest");
});

test("out-of-order resolution: an older response is rejected by its token", () => {
  const gate = createLatestRequestGate();
  // Simulate two in-flight reads: A starts first, then B.
  const tA = gate.next();
  const tB = gate.next();
  // B's response lands first and is applied (it is the latest).
  assert.equal(gate.isLatest(tB), true);
  // A's response lands LATER; without the guard this would overwrite B.
  assert.equal(gate.isLatest(tA), false, "late A response must be dropped");
});

test("tokens are strictly increasing and unique", () => {
  const gate = createLatestRequestGate();
  const seen = new Set();
  let prev = -Infinity;
  for (let i = 0; i < 5; i++) {
    const t = gate.next();
    assert.ok(t > prev, "each token is greater than the previous");
    assert.ok(!seen.has(t), "tokens are unique");
    seen.add(t);
    prev = t;
  }
});

test("a same-person re-fetch (enrich/starters) supersedes the earlier read", () => {
  const gate = createLatestRequestGate();
  const initial = gate.next(); // initial detail load
  const refetch = gate.next(); // refresh-enrichment / fetch-starters re-read
  assert.equal(gate.isLatest(initial), false, "the slower initial read is superseded");
  assert.equal(gate.isLatest(refetch), true, "the fresh re-fetch wins");
});

test("a later request for another key cannot supersede an in-flight route", () => {
  const gate = createLatestKeyedRequestGate();
  const threadB = gate.next("thread-b");
  gate.next("thread-a");

  assert.equal(
    gate.isLatest("thread-b", threadB),
    true,
    "a late Thread A refresh must not invalidate Thread B's navigation response"
  );
});

test("a newer request for the same key supersedes the earlier request", () => {
  const gate = createLatestKeyedRequestGate();
  const firstThreadB = gate.next("thread-b");
  const secondThreadB = gate.next("thread-b");

  assert.equal(gate.isLatest("thread-b", firstThreadB), false);
  assert.equal(gate.isLatest("thread-b", secondThreadB), true);
});

test("re-entering a route invalidates its previous visit before the new fetch starts", () => {
  const gate = createLatestKeyedRequestGate();
  const firstVisitA = gate.next("thread-a");
  gate.next("thread-b");

  const enteringA = gate.next("thread-a");
  assert.equal(gate.isLatest("thread-a", firstVisitA), false);

  const secondVisitA = gate.next("thread-a");
  assert.equal(gate.isLatest("thread-a", enteringA), false);
  assert.equal(gate.isLatest("thread-a", secondVisitA), true);
});
