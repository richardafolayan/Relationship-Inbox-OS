import test from "node:test";
import assert from "node:assert/strict";
import { interpretReassessAllResult } from "../apps/dashboard/lib/reassess-all-result.ts";

// ReassessAllControl ("Reset all for reassessment") used to read
// `result.threadsMarked` straight into its success line. In the live
// presenter demo the dashboard's fetch interceptor swallows the mutation
// and resolves with a read-only sentinel `{ ok: true, intercepted: true,
// action }` that has NO `threadsMarked` — so the UI rendered "undefined
// active threads reset for reassessment" mid-presentation.
//
// interpretReassessAllResult folds the success-path shapes into an
// explicit outcome the component renders honestly.

test("intercepted sentinel maps to an intercepted outcome with no count", () => {
  const outcome = interpretReassessAllResult({ ok: true, intercepted: true, action: "make a change" });
  assert.equal(outcome.status, "intercepted");
  assert.equal(outcome.count, null);
});

test("intercepted takes priority even if a count is somehow present", () => {
  // Defence in depth: a sentinel must never be treated as a real reset.
  const outcome = interpretReassessAllResult({ ok: true, intercepted: true, threadsMarked: 5 });
  assert.equal(outcome.status, "intercepted");
  assert.equal(outcome.count, null);
});

test("real numeric count maps to a done outcome carrying the count", () => {
  const outcome = interpretReassessAllResult({ ok: true, threadsMarked: 345 });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.count, 345);
});

test("zero is a valid count, not falsy-coerced away", () => {
  const outcome = interpretReassessAllResult({ ok: true, threadsMarked: 0 });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.count, 0);
});

test("a missing threadsMarked never yields an undefined count", () => {
  // The pre-fix bug: undefined count would render literally as "undefined".
  const outcome = interpretReassessAllResult({ ok: true });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.count, null);
  assert.notEqual(outcome.count, undefined);
});

test("null / undefined response is handled defensively", () => {
  for (const bad of [null, undefined]) {
    const outcome = interpretReassessAllResult(bad);
    assert.equal(outcome.status, "done");
    assert.equal(outcome.count, null);
  }
});
