import test from "node:test";
import assert from "node:assert/strict";
import { createAdminResetCoordinator } from "../apps/runner/dist/services/admin-reset-coordinator.js";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

function result(platform = "LINKEDIN") {
  return {
    platform,
    matchedThreadCount: 1,
    deleted: {
      sendRequests: 1,
      drafts: 0,
      messages: 1,
      threads: 1,
      orphanPeople: 1
    }
  };
}

function harness(overrides = {}) {
  const mutex = createKeyedMutex();
  const events = [];
  const coordinator = createAdminResetCoordinator({
    platforms: ["LINKEDIN", "INSTAGRAM"],
    requestAbort: (reason) => events.push(`abort:${reason}`),
    clearAbort: () => events.push("abort-cleared"),
    clearInFlight: () => events.push("in-flight-cleared"),
    withGlobalResetLock: (work) => mutex.runExclusive("global", work),
    withExternalActionLock: (platform, work) =>
      mutex.runExclusive(`external:${platform}`, work),
    withPlatformLock: (platform, work) =>
      mutex.runExclusive(`platform:${platform}`, work),
    resetGraph: async (platform) => {
      events.push(`graph:${platform}`);
      return result(platform);
    },
    auditLog: async () => {
      events.push("audit");
    },
    ...overrides
  });
  return { coordinator, events, mutex };
}

test("an active external action reaches terminal persistence before reset deletion", async () => {
  const h = harness();
  let releaseAction;
  let markActionStarted;
  const actionStarted = new Promise((resolve) => {
    markActionStarted = resolve;
  });
  const action = h.mutex.runExclusive("external:LINKEDIN", async () => {
    h.events.push("adapter-started");
    markActionStarted();
    await new Promise((resolve) => {
      releaseAction = resolve;
    });
    h.events.push("terminal-persisted");
  });
  await actionStarted;

  const reset = h.coordinator.reset({ platform: "LINKEDIN", requestId: "reset-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.includes("graph:LINKEDIN"), false);

  releaseAction();
  await action;
  await reset;

  assert.ok(h.events.indexOf("terminal-persisted") < h.events.indexOf("graph:LINKEDIN"));
  assert.equal(h.events.at(-1), "abort-cleared");
});

test("reset keeps both action and target platform fences through graph deletion", async () => {
  let releaseGraph;
  let markGraphStarted;
  const graphStarted = new Promise((resolve) => {
    markGraphStarted = resolve;
  });
  const h = harness({
    resetGraph: async (platform) => {
      h.events.push(`graph-start:${platform}`);
      markGraphStarted();
      await new Promise((resolve) => {
        releaseGraph = resolve;
      });
      h.events.push(`graph-finish:${platform}`);
      return result(platform);
    }
  });

  const reset = h.coordinator.reset({ platform: "LINKEDIN", requestId: "reset-2" });
  await graphStarted;

  let externalRan = false;
  let platformRan = false;
  const external = h.mutex.runExclusive("external:LINKEDIN", async () => {
    externalRan = true;
  });
  const platform = h.mutex.runExclusive("platform:LINKEDIN", async () => {
    platformRan = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(externalRan, false);
  assert.equal(platformRan, false);

  releaseGraph();
  await reset;
  await Promise.all([external, platform]);
  assert.equal(externalRan, true);
  assert.equal(platformRan, true);
});

test("reset always clears scan abort state after graph failure", async () => {
  const h = harness({
    resetGraph: async () => {
      throw new Error("delete failed");
    }
  });

  await assert.rejects(
    () => h.coordinator.reset({ platform: "LINKEDIN", requestId: "reset-3" }),
    /delete failed/
  );
  assert.equal(h.events.at(-1), "abort-cleared");
});
