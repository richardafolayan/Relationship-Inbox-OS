import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import below.
const { isActiveThreadIdentity, shouldApplyThreadScopedResult } = await import(
  "../apps/dashboard/lib/thread-identity-guard.ts"
);

// The thread page does not remount across /thread/A -> /thread/B. Async AI
// helpers snapshot the route thread id and only apply their result while that
// thread is still live, avoiding state from A appearing on B.

test("applies a result when still on the thread that started the request", () => {
  assert.equal(shouldApplyThreadScopedResult("thread-A", "thread-A"), true);
});

test("skips the result when the operator has navigated to a different thread", () => {
  // A's transform resolves after navigating to B — must NOT write to B.
  assert.equal(shouldApplyThreadScopedResult("thread-A", "thread-B"), false);
});

test("simulated request race: A's late result never lands in B's state", () => {
  // Model the composer the way the page does: a single piece of route-scoped
  // state shared across navigation (no remount).
  let routeThreadId = "thread-A";
  let composer = "draft for A";

  // An async helper starts on A and snapshots the route id first.
  const startThreadId = routeThreadId;

  // ...the await is in flight. Operator navigates to B; the reset effect both
  // points the guard at B and clears B's composer.
  routeThreadId = "thread-B";
  composer = "";

  // A's request now resolves after navigation.
  const transformOutput = "late result for A";
  if (shouldApplyThreadScopedResult(startThreadId, routeThreadId)) {
    composer = transformOutput;
  }

  // B's composer must be untouched by A's stale result.
  assert.equal(composer, "");
});

test("same-thread request still applies its result", () => {
  let routeThreadId = "thread-A";
  let composer = "draft for A";

  const startThreadId = routeThreadId;
  // No navigation occurs.
  const transformOutput = "result for A";
  if (shouldApplyThreadScopedResult(startThreadId, routeThreadId)) {
    composer = transformOutput;
  }

  assert.equal(composer, "result for A");
});

test("guards are symmetric for null / undefined ids without false positives", () => {
  assert.equal(shouldApplyThreadScopedResult(null, "thread-A"), false);
  assert.equal(shouldApplyThreadScopedResult("thread-A", null), false);
  assert.equal(shouldApplyThreadScopedResult(undefined, "thread-A"), false);
});

test("active thread identity requires the route and loaded payload to match the action owner", () => {
  assert.equal(isActiveThreadIdentity("A", "A", "A"), true);
  assert.equal(isActiveThreadIdentity("A", "B", "A"), false);
  assert.equal(isActiveThreadIdentity("A", "A", "B"), false);
  assert.equal(isActiveThreadIdentity("A", "B", "B"), false);
});
