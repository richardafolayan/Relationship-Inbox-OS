import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileSelectedPlatformLifecycle,
  shouldStartLinkedInRealtimeWatcher
} from "../apps/runner/src/services/platform-selection-reconciler.ts";

test("deselection aborts any active platform and closes its managed session", async () => {
  let enabledPlatforms = ["LINKEDIN"];
  const aborted = [];
  const closed = [];
  enabledPlatforms = [];
  await reconcileSelectedPlatformLifecycle({
    getEnabledPlatforms: async () => enabledPlatforms,
    getCurrentScanPlatform: () => "LINKEDIN",
    requestAbort: (reason) => aborted.push(reason),
    managedPlatforms: ["LINKEDIN", "INSTAGRAM"],
    withPlatformLocks: async (_platform, work) => work(),
    closeSession: async (platform) => closed.push(platform)
  });
  assert.deepEqual(aborted, ["platform_deselected"]);
  assert.deepEqual(closed.sort(), ["INSTAGRAM", "LINKEDIN"]);
});

test("a stale disable task rechecks settings inside platform locks", async () => {
  let enabledPlatforms = [];
  let releaseLock;
  const lockHeld = new Promise((resolve) => { releaseLock = resolve; });
  const closed = [];
  const reconciliation = reconcileSelectedPlatformLifecycle({
    getEnabledPlatforms: async () => enabledPlatforms,
    getCurrentScanPlatform: () => null,
    requestAbort: () => undefined,
    managedPlatforms: ["WHATSAPP"],
    withPlatformLocks: async (_platform, work) => {
      await lockHeld;
      return work();
    },
    closeSession: async (platform) => closed.push(platform)
  });
  enabledPlatforms = ["WHATSAPP"];
  releaseLock();
  await reconciliation;
  assert.deepEqual(closed, []);
});

test("LinkedIn watcher starts only for a selected historically connected source", () => {
  assert.equal(shouldStartLinkedInRealtimeWatcher({ available: true, selected: false, connectedAt: new Date() }), false);
  assert.equal(shouldStartLinkedInRealtimeWatcher({ available: true, selected: true, connectedAt: null }), false);
  assert.equal(shouldStartLinkedInRealtimeWatcher({ available: true, selected: true, connectedAt: new Date() }), true);
});
