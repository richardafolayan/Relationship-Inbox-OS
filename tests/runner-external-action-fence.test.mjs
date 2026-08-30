import test from "node:test";
import assert from "node:assert/strict";
import { createThreadExternalActionFence } from "../apps/runner/dist/services/external-action-fence.js";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

test("a reset that enters first prevents stale thread work after deletion", async () => {
  const mutex = createKeyedMutex();
  let target = { platform: "LINKEDIN", threadId: "thread-1" };
  let workCalls = 0;
  let releaseReset;
  let markResetReady;
  const resetReady = new Promise((resolve) => {
    markResetReady = resolve;
  });
  const reset = mutex.runExclusive("external:LINKEDIN", async () => {
    markResetReady();
    await new Promise((resolve) => {
      releaseReset = resolve;
    });
  });
  await resetReady;

  const fence = createThreadExternalActionFence({
    discoverPlatform: async () => "LINKEDIN",
    loadTarget: async () => target,
    withExternalActionLock: (platform, work) =>
      mutex.runExclusive(`external:${platform}`, work),
    withPlatformLock: (platform, work) =>
      mutex.runExclusive(`platform:${platform}`, work)
  });
  const action = fence.run("thread-1", async () => {
    workCalls += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));

  target = null;
  releaseReset();
  await reset;
  const outcome = await action;

  assert.deepEqual(outcome, { status: "missing" });
  assert.equal(workCalls, 0);
});

test("thread action work holds the external and platform fences together", async () => {
  const mutex = createKeyedMutex();
  let releaseWork;
  let markWorkStarted;
  const workStarted = new Promise((resolve) => {
    markWorkStarted = resolve;
  });
  const fence = createThreadExternalActionFence({
    discoverPlatform: async () => "LINKEDIN",
    loadTarget: async () => ({ platform: "LINKEDIN", threadId: "thread-1" }),
    withExternalActionLock: (platform, work) =>
      mutex.runExclusive(`external:${platform}`, work),
    withPlatformLock: (platform, work) =>
      mutex.runExclusive(`platform:${platform}`, work)
  });

  const action = fence.run("thread-1", async () => {
    markWorkStarted();
    await new Promise((resolve) => {
      releaseWork = resolve;
    });
    return "done";
  });
  await workStarted;

  let externalRan = false;
  let platformRan = false;
  const external = mutex.runExclusive("external:LINKEDIN", async () => {
    externalRan = true;
  });
  const platform = mutex.runExclusive("platform:LINKEDIN", async () => {
    platformRan = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(externalRan, false);
  assert.equal(platformRan, false);

  releaseWork();
  assert.deepEqual(await action, { status: "completed", value: "done" });
  await Promise.all([external, platform]);
});

test("platform changes fail closed instead of using a mismatched lock", async () => {
  let workCalls = 0;
  const fence = createThreadExternalActionFence({
    discoverPlatform: async () => "LINKEDIN",
    loadTarget: async () => ({ platform: "INSTAGRAM", threadId: "thread-1" }),
    withExternalActionLock: (_platform, work) => work(),
    withPlatformLock: (_platform, work) => work()
  });

  const outcome = await fence.run("thread-1", async () => {
    workCalls += 1;
  });

  assert.deepEqual(outcome, { status: "missing" });
  assert.equal(workCalls, 0);
});
