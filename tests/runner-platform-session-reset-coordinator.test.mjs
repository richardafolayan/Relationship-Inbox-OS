import test from "node:test";
import assert from "node:assert/strict";
import { createPlatformSessionResetCoordinator } from "../apps/runner/dist/services/platform-session-reset-coordinator.js";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

function harness(overrides = {}) {
  const mutex = createKeyedMutex();
  const events = [];
  const coordinator = createPlatformSessionResetCoordinator({
    platforms: ["LINKEDIN", "INSTAGRAM", "TIKTOK"],
    requestAbort: (reason) => events.push(`abort:${reason}`),
    clearAbort: () => events.push("abort-cleared"),
    clearInFlight: () => events.push("in-flight-cleared"),
    withGlobalResetLock: (work) => mutex.runExclusive("global", work),
    withExternalActionLock: (platform, work) =>
      mutex.runExclusive(`external:${platform}`, work),
    withPlatformLock: (platform, work) =>
      mutex.runExclusive(`platform:${platform}`, work),
    resetSharedSession: async () => events.push("shared-session-reset"),
    resetInstagramSession: async () => events.push("instagram-session-reset"),
    persistStatus: async (platform) => events.push(`status:${platform}`),
    auditLog: async () => events.push("audit"),
    ...overrides
  });
  return { coordinator, events, mutex };
}

test("an active send finishes before a shared platform session is reset", async () => {
  const h = harness();
  let releaseSend;
  let markSendStarted;
  const sendStarted = new Promise((resolve) => {
    markSendStarted = resolve;
  });
  const send = h.mutex.runExclusive("external:LINKEDIN", async () => {
    h.events.push("send-started");
    markSendStarted();
    await new Promise((resolve) => {
      releaseSend = resolve;
    });
    h.events.push("send-terminal-persisted");
  });
  await sendStarted;

  const reset = h.coordinator.reset("LINKEDIN");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.includes("shared-session-reset"), false);

  releaseSend();
  await send;
  await reset;

  assert.ok(
    h.events.indexOf("send-terminal-persisted") < h.events.indexOf("shared-session-reset")
  );
  assert.equal(h.events.at(-1), "abort-cleared");
});

test("session reset holds every affected action and platform fence until persistence", async () => {
  let releaseSessionReset;
  let markSessionResetStarted;
  const sessionResetStarted = new Promise((resolve) => {
    markSessionResetStarted = resolve;
  });
  const h = harness({
    resetSharedSession: async () => {
      h.events.push("shared-session-reset-started");
      markSessionResetStarted();
      await new Promise((resolve) => {
        releaseSessionReset = resolve;
      });
    }
  });

  const reset = h.coordinator.reset("LINKEDIN");
  await sessionResetStarted;

  const entered = [];
  const contenders = ["LINKEDIN", "TIKTOK"].flatMap((platform) => [
    h.mutex.runExclusive(`external:${platform}`, async () => entered.push(`external:${platform}`)),
    h.mutex.runExclusive(`platform:${platform}`, async () => entered.push(`platform:${platform}`))
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, []);

  releaseSessionReset();
  await reset;
  await Promise.all(contenders);
  assert.equal(h.events.includes("status:LINKEDIN"), true);
  assert.equal(h.events.includes("status:TIKTOK"), true);
});

test("session reset clears scan abort state after a reset failure", async () => {
  const h = harness({
    resetInstagramSession: async () => {
      throw new Error("profile removal failed");
    }
  });

  await assert.rejects(() => h.coordinator.reset("INSTAGRAM"), /profile removal failed/);
  assert.equal(h.events.at(-1), "abort-cleared");
});
