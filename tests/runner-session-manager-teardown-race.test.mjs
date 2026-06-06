import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionManager } from "../apps/runner/dist/services/session-manager.js";

// Regression test for PM15: the lease-drain check and the context/page
// teardown were two SEPARATE personMutex.runExclusive acquisitions with an
// await boundary between them. waitForLeaseDrain released the mutex on return,
// and the teardown re-acquired it without re-checking activeLeases, so a
// concurrent withPlatformLease could increment activeLeases in the gap and
// then have its context/page closed out from under it ('target page/context
// closed'). The fix marks the session as tearing down UNDER the mutex BEFORE
// draining, so withPlatformLease refuses any new lease for the whole
// drain -> teardown window. These tests assert that refusal.

const defaultBrowserProfile = {
  mode: "isolated",
  fallbackBehavior: "allow_isolated",
  personalProfileSyncMode: "smart",
  personalProfileMirrorRoot: "/tmp/mirror-root",
  personalChromeUserDataDir: "/tmp/chrome-user-data",
  personalChromeProfileDirectory: "Default",
  personalChromeProfileName: "Test Profile",
  personalChromeProfileResolutionStrategy: "directory_exact"
};

const defaultSettings = {
  scanIntervalSeconds: 30,
  amberHours: 24,
  redHours: 72,
  headless: true,
  maxMessagesPerThread: 40,
  enabledPlatforms: ["LINKEDIN", "INSTAGRAM", "TIKTOK"],
  demoMode: false,
  recentThreadSweepCount: 30
};

function createFakePage(initialUrl = "about:blank") {
  let closed = false;
  let currentUrl = initialUrl;
  const closeListeners = [];

  return {
    isClosed: () => closed,
    url: () => currentUrl,
    goto: async (nextUrl) => {
      currentUrl = nextUrl;
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const listener of closeListeners) {
        listener();
      }
    },
    on: (event, listener) => {
      if (event === "close") {
        closeListeners.push(listener);
      }
    }
  };
}

function createFakeContext(input = {}) {
  const pages = input.initialPages ? [...input.initialPages] : [];
  let closed = false;
  const closeListeners = [];

  return {
    pages: () => {
      if (closed) {
        throw new Error("context closed");
      }
      return pages;
    },
    newPage: async () => {
      if (closed) {
        throw new Error("context closed");
      }
      const page = createFakePage("about:blank");
      pages.push(page);
      return page;
    },
    pageCount: () => pages.length,
    on: (event, listener) => {
      if (event === "close") {
        closeListeners.push(listener);
      }
    },
    close: async () => {
      closed = true;
      for (const page of pages) {
        await page.close();
      }
      for (const listener of closeListeners) {
        listener();
      }
    }
  };
}

function createManager(launchPersistentContext) {
  return createSessionManager({
    profileRootDir: join(tmpdir(), `session-manager-pm15-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    browserProfile: defaultBrowserProfile,
    getSettings: async () => defaultSettings,
    launchPersistentContext
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("closePlatformPage refuses a new lease acquired during teardown drain", async () => {
  const context = createFakeContext();
  const manager = createManager(async () => context);
  await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });

  // Lease A holds the drain open so teardown is parked in waitForLeaseDrain.
  const leaseA = createDeferred();
  const leaseAWork = manager.withPlatformLease({ platform: "LINKEDIN", personKey: "default" }, async () => {
    await leaseA.promise;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Teardown begins: marks the platform as tearing down, then blocks in drain.
  const closePromise = manager.closePlatformPage({ platform: "LINKEDIN", personKey: "default" });
  await new Promise((resolve) => setTimeout(resolve, 40));

  // Lease B lands in the drain window. With the fix it is refused before its
  // work runs; pre-fix it was granted and its page would be closed mid-use.
  let bRan = false;
  let bRejected = false;
  const leaseBWork = manager
    .withPlatformLease({ platform: "LINKEDIN", personKey: "default" }, async () => {
      bRan = true;
    })
    .catch(() => {
      bRejected = true;
    });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(bRan, false, "lease B work must NOT run while the platform is tearing down");
  assert.equal(bRejected, true, "lease B acquisition must be refused while the platform is tearing down");

  leaseA.resolve();
  await leaseAWork;
  await leaseBWork;
  await closePromise;

  // After teardown completes a fresh lease is allowed again.
  let cRan = false;
  await manager.withPlatformLease({ platform: "LINKEDIN", personKey: "default" }, async () => {
    cRan = true;
  });
  assert.equal(cRan, true, "a lease acquired after teardown completes must succeed");
});

test("resetPersonSession refuses a new lease acquired during teardown drain", async () => {
  const context = createFakeContext();
  const manager = createManager(async () => context);
  await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });

  const leaseA = createDeferred();
  const leaseAWork = manager.withPlatformLease({ platform: "LINKEDIN", personKey: "default" }, async () => {
    await leaseA.promise;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const resetPromise = manager.resetPersonSession({ personKey: "default", clearProfileDir: false });
  await new Promise((resolve) => setTimeout(resolve, 40));

  // Whole-context teardown must refuse leases for ANY platform, not just the
  // one currently active.
  let bRan = false;
  let bRejected = false;
  const leaseBWork = manager
    .withPlatformLease({ platform: "INSTAGRAM", personKey: "default" }, async () => {
      bRan = true;
    })
    .catch(() => {
      bRejected = true;
    });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(bRan, false, "lease B work must NOT run while the context is tearing down");
  assert.equal(bRejected, true, "lease B acquisition must be refused while the context is tearing down");

  leaseA.resolve();
  await leaseAWork;
  await leaseBWork;
  await resetPromise;
});
