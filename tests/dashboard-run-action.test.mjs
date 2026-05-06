import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import
// below — see test:all in the root package.json.
const { runAction, ApiRequestError } = await import("../apps/dashboard/lib/api.ts");

// `runAction` is the helper every dashboard action button funnels through.
// Without it, `void apiPost(...)` rejections bubble to Next.js's dev error
// overlay and pile up in the floating "N errors" badge — which is exactly
// the user-reported regression these tests pin down.

test("runAction resolves: clears error and runs onDone", async () => {
  const calls = { setError: [], onDone: 0 };
  const setError = (msg) => calls.setError.push(msg);
  const onDone = () => {
    calls.onDone += 1;
  };

  runAction(Promise.resolve("ok"), setError, onDone);
  // Let microtasks flush so the `.then(...)` chain runs.
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(calls.setError, [null], "setError called with null on success");
  assert.equal(calls.onDone, 1, "onDone called exactly once on success");
});

test("runAction rejects: captures error message in setError, no onDone", async () => {
  const calls = { setError: [], onDone: 0 };
  const setError = (msg) => calls.setError.push(msg);
  const onDone = () => {
    calls.onDone += 1;
  };

  runAction(Promise.reject(new Error("Auth required")), setError, onDone);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(calls.setError, ["Auth required"]);
  assert.equal(calls.onDone, 0, "onDone NOT called on failure");
});

test("runAction stringifies non-Error rejections", async () => {
  const calls = { setError: [] };
  const setError = (msg) => calls.setError.push(msg);

  runAction(Promise.reject("plain string reason"), setError);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(calls.setError, ["plain string reason"]);
});

test("runAction surfaces ApiRequestError message verbatim", async () => {
  const calls = { setError: [] };
  const setError = (msg) => calls.setError.push(msg);
  const apiError = new ApiRequestError("LinkedIn auth required", 401);

  runAction(Promise.reject(apiError), setError);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(calls.setError, ["LinkedIn auth required"]);
});

test("runAction does NOT throw an unhandled rejection for a failed promise", async () => {
  // The whole point: rejections must be swallowed by the helper, never
  // bubble to process.on('unhandledRejection'). If this test ever sees a
  // rejection event from runAction's input promise, the implementation
  // regressed to the old `void apiPost(...)` shape.
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on("unhandledRejection", handler);

  runAction(Promise.reject(new Error("must be swallowed")), () => undefined);
  // Two ticks: enough for the rejection to surface if it was going to.
  await new Promise((r) => setTimeout(r, 20));

  process.off("unhandledRejection", handler);
  assert.equal(seen.length, 0, `runAction leaked an unhandled rejection: ${seen.map(String).join(", ")}`);
});

test("runAction onDone errors do not leak as unhandled rejections", async () => {
  // If onDone itself throws, the error should surface via setError too —
  // not as an unhandled rejection from the promise chain.
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on("unhandledRejection", handler);
  const calls = { setError: [] };
  const setError = (msg) => calls.setError.push(msg);

  runAction(Promise.resolve(), setError, () => {
    throw new Error("refresh exploded");
  });
  await new Promise((r) => setTimeout(r, 20));

  process.off("unhandledRejection", handler);
  // onDone throwing should not propagate as an unhandled rejection.
  assert.equal(seen.length, 0, `onDone leaked an unhandled rejection: ${seen.map(String).join(", ")}`);
});
