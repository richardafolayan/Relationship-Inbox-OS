import test from "node:test";
import assert from "node:assert/strict";

import {
  PlatformNotSelectedError,
  PlatformSelectionSupersededError,
  createPlatformSelectionCoordinator
} from "../apps/runner/src/services/platform-selection-coordinator.ts";
import { createAdminResetCoordinator } from "../apps/runner/src/services/admin-reset-coordinator.ts";
import { createKeyedMutex } from "../apps/runner/src/services/keyed-mutex.ts";

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
    withGlobalResetLock: async (work) => work(),
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
    withGlobalResetLock: async (work) => work(),
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

test("cancelling pre-run work restores the authoritative selection when the reservation is latest", async () => {
  let enabled = ["LINKEDIN"];
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["LINKEDIN"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: () => undefined,
    withGlobalResetLock: async (work) => work(),
    withPlatformLocks: async (_platform, work) => work()
  });

  const reservation = coordinator.reserveMutation([]);
  assert.equal(coordinator.isPlatformSelectedForNewWork("LINKEDIN"), false);
  await reservation.cancel();

  assert.equal(coordinator.isPlatformSelectedForNewWork("LINKEDIN"), true);
  await assert.doesNotReject(
    coordinator.withSelectedPlatform("LINKEDIN", async () => "allowed")
  );
});

test("cancelling an older reservation cannot overwrite a newer desired selection", async () => {
  let enabled = ["LINKEDIN"];
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["IMESSAGE", "LINKEDIN"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: () => undefined,
    withGlobalResetLock: async (work) => work(),
    withPlatformLocks: async (_platform, work) => work()
  });

  const older = coordinator.reserveMutation([]);
  const newer = coordinator.reserveMutation(["IMESSAGE"]);
  await older.cancel();

  assert.equal(coordinator.isPlatformSelectedForNewWork("LINKEDIN"), false);
  assert.equal(coordinator.isPlatformSelectedForNewWork("IMESSAGE"), true);
  enabled = ["IMESSAGE"];
  await newer.run(async () => undefined);
});

test("a stale durable read cannot overwrite a newer platform opt-out", async () => {
  const entered = deferred();
  const release = deferred();
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["LINKEDIN"],
    getEnabledPlatforms: async () => {
      entered.resolve();
      await release.promise;
      return ["LINKEDIN"];
    },
    requestAbort: () => undefined,
    withGlobalResetLock: async (work) => work(),
    withPlatformLocks: async (_platform, work) => work()
  });

  const older = coordinator.reserveMutation(["LINKEDIN"]);
  const cancelling = older.cancel();
  await entered.promise;
  coordinator.reserveMutation([]);
  release.resolve();
  await cancelling;

  assert.equal(coordinator.isPlatformSelectedForNewWork("LINKEDIN"), false);
});

test("cancel waits for older platform persistence before restoring durable state", async () => {
  let enabled = [];
  let lockTail = Promise.resolve();
  const olderEntered = deferred();
  const releaseOlder = deferred();
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["LINKEDIN"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: () => undefined,
    withGlobalResetLock: async (work) => work(),
    withPlatformLocks: async (_platform, work) => {
      const previous = lockTail;
      const release = deferred();
      lockTail = previous.then(() => release.promise);
      await previous;
      try {
        return await work();
      } finally {
        release.resolve();
      }
    }
  });

  const older = coordinator.reserveMutation(["LINKEDIN"]);
  const olderRun = older.run(async () => {
    olderEntered.resolve();
    await releaseOlder.promise;
    enabled = ["LINKEDIN"];
  });
  await olderEntered.promise;

  const newer = coordinator.reserveMutation([]);
  const cancelling = newer.cancel();
  releaseOlder.resolve();
  await Promise.all([olderRun, cancelling]);

  assert.equal(coordinator.isPlatformSelectedForNewWork("LINKEDIN"), true);
});

test("a failed platform restore cannot publish a stale read over a newer opt-out", async () => {
  const restoreEntered = deferred();
  const releaseRestore = deferred();
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["LINKEDIN"],
    getEnabledPlatforms: async () => {
      restoreEntered.resolve();
      await releaseRestore.promise;
      return ["LINKEDIN"];
    },
    requestAbort: () => undefined,
    withGlobalResetLock: async (work) => work(),
    withPlatformLocks: async (_platform, work) => work()
  });
  const older = coordinator.reserveMutation([]);
  const olderRun = older.run(async () => {
    throw new Error("write failed");
  });
  await restoreEntered.promise;

  const newer = coordinator.reserveMutation([]);
  releaseRestore.resolve();
  await assert.rejects(olderRun, /write failed/);

  assert.equal(coordinator.isPlatformSelectedForNewWork("LINKEDIN"), false);
  await newer.run(async () => undefined);
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
    withGlobalResetLock: async (work) => work(),
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

test("a reserved deselection rejects new target work while an earlier platform lock drains", async () => {
  let enabled = ["GOOGLE_MESSAGES", "LINKEDIN"];
  const googleEntered = deferred();
  const releaseGoogle = deferred();
  let linkedInLockEntries = 0;
  const coordinator = createPlatformSelectionCoordinator({
    platforms: ["GOOGLE_MESSAGES", "LINKEDIN"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: () => undefined,
    withGlobalResetLock: async (work) => work(),
    withPlatformLocks: async (platform, work) => {
      if (platform === "GOOGLE_MESSAGES") {
        googleEntered.resolve();
        await releaseGoogle.promise;
      } else {
        linkedInLockEntries += 1;
      }
      return work();
    }
  });

  const mutation = coordinator.mutate(["GOOGLE_MESSAGES"], async () => {
    enabled = ["GOOGLE_MESSAGES"];
  });
  await googleEntered.promise;

  await assert.rejects(
    coordinator.withSelectedPlatform("LINKEDIN", async () => {
      throw new Error("must not run");
    }),
    PlatformNotSelectedError
  );
  assert.equal(linkedInLockEntries, 0);

  releaseGoogle.resolve();
  await mutation;
});

test("platform selection and admin reset cannot deadlock across platform lock order", async () => {
  const mutex = createKeyedMutex();
  const resetHasWhatsApp = deferred();
  const releaseReset = deferred();
  let enabled = ["LINKEDIN", "WHATSAPP"];
  const withGlobalResetLock = (work) => mutex.runExclusive("global-reset", work);
  const withExternalActionLock = (platform, work) =>
    mutex.runExclusive(`external:${platform}`, work);
  const withPlatformLock = (platform, work) =>
    mutex.runExclusive(`platform:${platform}`, work);

  const admin = createAdminResetCoordinator({
    platforms: ["LINKEDIN", "WHATSAPP"],
    requestAbort: () => undefined,
    clearAbort: () => undefined,
    clearInFlight: () => undefined,
    withGlobalResetLock,
    withExternalActionLock: (platform, work) =>
      withExternalActionLock(platform, async () => {
        if (platform === "WHATSAPP") {
          resetHasWhatsApp.resolve();
          await releaseReset.promise;
        }
        return work();
      }),
    withPlatformLock,
    resetGraph: async (platform) => ({
      platform,
      matchedThreadCount: 0,
      deleted: {
        sendRequests: 0,
        drafts: 0,
        messages: 0,
        threads: 0,
        orphanPeople: 0
      }
    }),
    auditLog: async () => undefined
  });
  const selection = createPlatformSelectionCoordinator({
    platforms: ["LINKEDIN", "WHATSAPP"],
    getEnabledPlatforms: async () => enabled,
    requestAbort: () => undefined,
    withGlobalResetLock,
    withPlatformLocks: (platform, work) =>
      withExternalActionLock(platform, () => withPlatformLock(platform, work))
  });

  const reset = admin.reset({ platform: "WHATSAPP", requestId: "reset-lock-order" });
  await resetHasWhatsApp.promise;
  const mutation = selection.mutate([], async () => {
    enabled = [];
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseReset.resolve();

  await Promise.race([
    Promise.all([reset, mutation]),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("platform selection/admin reset deadlocked")), 500)
    )
  ]);
  assert.deepEqual(enabled, []);
});
