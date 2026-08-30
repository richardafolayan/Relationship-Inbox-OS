import test from "node:test";
import assert from "node:assert/strict";
import { createDemoCleanupCoordinator } from "../apps/runner/dist/services/demo-cleanup-coordinator.js";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

function harness(platforms = ["LINKEDIN", "IMESSAGE"]) {
  const mutex = createKeyedMutex();
  const coordinator = createDemoCleanupCoordinator({
    resolvePlatforms: async () => platforms,
    withGlobalResetLock: (work) => mutex.runExclusive("global", work),
    withExternalActionLock: (platform, work) =>
      mutex.runExclusive(`external:${platform}`, work)
  });
  return { coordinator, mutex };
}

test("an active sandbox send reaches terminal persistence before demo cleanup", async () => {
  const h = harness(["LINKEDIN"]);
  const events = [];
  let releaseSend;
  let markSendStarted;
  const sendStarted = new Promise((resolve) => {
    markSendStarted = resolve;
  });
  const send = h.mutex.runExclusive("external:LINKEDIN", async () => {
    events.push("send-started");
    markSendStarted();
    await new Promise((resolve) => {
      releaseSend = resolve;
    });
    events.push("send-terminal-persisted");
  });
  await sendStarted;

  const cleanup = h.coordinator.run(["demo-thread"], async () => {
    events.push("demo-rows-deleted");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("demo-rows-deleted"), false);

  releaseSend();
  await Promise.all([send, cleanup]);
  assert.ok(
    events.indexOf("send-terminal-persisted") < events.indexOf("demo-rows-deleted")
  );
});

test("demo cleanup retains every affected external fence through settings transition", async () => {
  const h = harness();
  let releaseCleanup;
  let markCleanupStarted;
  const cleanupStarted = new Promise((resolve) => {
    markCleanupStarted = resolve;
  });
  const cleanup = h.coordinator.run(["demo-a", "demo-b"], async () => {
    markCleanupStarted();
    await new Promise((resolve) => {
      releaseCleanup = resolve;
    });
  });
  await cleanupStarted;

  const entered = [];
  const contenders = ["LINKEDIN", "IMESSAGE"].map((platform) =>
    h.mutex.runExclusive(`external:${platform}`, async () => entered.push(platform))
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, []);

  releaseCleanup();
  await cleanup;
  await Promise.all(contenders);
  assert.deepEqual(entered.sort(), ["IMESSAGE", "LINKEDIN"]);
});
