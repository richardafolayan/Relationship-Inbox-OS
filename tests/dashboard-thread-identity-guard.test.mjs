import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import below.
const { shouldApplyThreadScopedResult } = await import(
  "../apps/dashboard/lib/thread-identity-guard.ts"
);

// Regression: the thread page's transform (shorten / warmer) handler awaited
// /transform then unconditionally wrote output.text into the composer. Because
// the page does NOT remount across /thread/A -> /thread/B, a transform fired on
// A could resolve after the operator navigated to B and overwrite B's composer
// with A's text -> wrong-recipient send. The fix snapshots the route thread id
// before the await and only applies the result when it is still the live thread.

test("applies the result when still on the thread that started the transform", () => {
  assert.equal(shouldApplyThreadScopedResult("thread-A", "thread-A"), true);
});

test("skips the result when the operator has navigated to a different thread", () => {
  // A's transform resolves after navigating to B — must NOT write to B.
  assert.equal(shouldApplyThreadScopedResult("thread-A", "thread-B"), false);
});

test("simulated transform race: A's late result never lands in B's composer", () => {
  // Model the composer the way the page does: a single piece of route-scoped
  // state shared across navigation (no remount).
  let routeThreadId = "thread-A";
  let composer = "draft for A";

  // Operator clicks shorten on A. The handler snapshots the route id first.
  const startThreadId = routeThreadId;

  // ...the await is in flight. Operator navigates to B; the reset effect both
  // points the guard at B and clears B's composer.
  routeThreadId = "thread-B";
  composer = "";

  // A's /transform now resolves with A's shortened text.
  const transformOutput = "shortened A text";
  if (shouldApplyThreadScopedResult(startThreadId, routeThreadId)) {
    composer = transformOutput;
  }

  // B's composer must be untouched by A's stale result.
  assert.equal(composer, "");
});

test("same-thread transform still applies its result", () => {
  let routeThreadId = "thread-A";
  let composer = "draft for A";

  const startThreadId = routeThreadId;
  // No navigation occurs.
  const transformOutput = "shortened A text";
  if (shouldApplyThreadScopedResult(startThreadId, routeThreadId)) {
    composer = transformOutput;
  }

  assert.equal(composer, "shortened A text");
});

test("guards are symmetric for null / undefined ids without false positives", () => {
  assert.equal(shouldApplyThreadScopedResult(null, "thread-A"), false);
  assert.equal(shouldApplyThreadScopedResult("thread-A", null), false);
  assert.equal(shouldApplyThreadScopedResult(undefined, "thread-A"), false);
});
