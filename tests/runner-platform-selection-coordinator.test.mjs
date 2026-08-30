import test from "node:test";
import assert from "node:assert/strict";

import {
  PlatformNotSelectedError,
  PlatformSelectionSupersededError,
  createPlatformSelectionCoordinator
} from "../apps/runner/src/services/platform-selection-coordinator.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a deselection aborts first and remains held against platform work until its durable write", async () => {
  let enabled = ["IMESSAGE", "LINKEDIN"];
  const calls = [];
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["IMESSAGE", "LINKEDIN"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: (reason) => calls.push(`abort:${reason}`),
    withPlatformLocks: async (platform, work) => {
      calls.push(`lock:${platform}`);
      return work();
    }
  });

  await coordinator.mutate(["IMESSAGE"], async () => {
    calls.push("persist:start");
    enabled = ["IMESSAGE"];
    calls.push("persist:end");
  });

  assert.deepEqual(calls, [
    "abort:platform_selection_changed",
    "lock:IMESSAGE",
    "lock:LINKEDIN",
    "persist:start",
    "persist:end"
  ]);
});

test("an older reserved selection cannot overwrite a newer request", async () => {
  let enabled = ["IMESSAGE", "LINKEDIN"];
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["IMESSAGE", "LINKEDIN"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: () => undefined,
    withPlatformLocks: async (_platform, work) => work()
  });

  const older = coordinator.reserveMutation(["LINKEDIN"]);
  const newer = coordinator.reserveMutation(["IMESSAGE"]);

  await assert.rejects(
    older.run(async () => {
      enabled = ["LINKEDIN"];
    }),
    PlatformSelectionSupersededError
  );
  await newer.run(async () => {
    enabled = ["IMESSAGE"];
  });

  assert.deepEqual(enabled, ["IMESSAGE"]);
});

test("a connect queued behind a newer deselection cannot reopen or reselect the source", async () => {
  let enabled = ["LINKEDIN"];
  const locked = deferred();
  const entered = deferred();
  let physicalConnects = 0;
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["LINKEDIN"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: () => undefined,
    withPlatformLocks: async (_platform, work) => {
      entered.resolve();
      await locked.promise;
      return work();
    }
  });

  const connect = coordinator.withSelectedPlatform("LINKEDIN", async () => {
    physicalConnects += 1;
  });
  await entered.promise;
  enabled = [];
  locked.resolve();

  await assert.rejects(connect, PlatformNotSelectedError);
  assert.equal(physicalConnects, 0);
  assert.deepEqual(enabled, []);
});
