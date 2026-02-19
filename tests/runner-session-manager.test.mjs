import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionManager } from "../apps/runner/dist/services/session-manager.js";

const defaultBrowserProfile = {
  mode: "isolated",
  fallbackBehavior: "allow_isolated",
  personalProfileSyncMode: "smart",
  personalProfileMirrorRoot: "/tmp/mirror-root",
  personalChromeUserDataDir: "/tmp/chrome-user-data",
  personalChromeProfileDirectory: "Default",
  personalChromeProfileName: "Richard",
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
  let remainingNewPageFailures = Number.isFinite(input.failNewPageCount) ? Math.max(0, input.failNewPageCount) : 0;
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
      if (remainingNewPageFailures > 0) {
        remainingNewPageFailures -= 1;
        throw new Error(input.failNewPageMessage ?? "browserContext.newPage: Target page, context or browser has been closed");
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
    profileRootDir: join(tmpdir(), `session-manager-${Date.now()}-${Math.random().toString(16).slice(2)}`),
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

test("SessionManager recreates closed platform pages in the same context", async () => {
  const context = createFakeContext();
  let launchCount = 0;
  const manager = createManager(async () => {
    launchCount += 1;
    return context;
  });

  const firstPage = await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
  const secondPage = await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
  assert.equal(firstPage, secondPage);
  assert.equal(launchCount, 1);

  await firstPage.close();
  const recreated = await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
  assert.notEqual(recreated, firstPage);
  assert.equal(launchCount, 1);
});

test("SessionManager reset closes context and clears platform page references", async () => {
  let contextClosed = 0;
  const manager = createManager(async () => {
    const context = createFakeContext();
    return {
      ...context,
      close: async () => {
        contextClosed += 1;
        await context.close();
      }
    };
  });

  await manager.getManagedPage({ platform: "LINKEDIN" });
  await manager.resetPersonSession({ personKey: "default", clearProfileDir: false });
  assert.equal(contextClosed, 1);

  await manager.getManagedPage({ platform: "LINKEDIN" });
  assert.equal(contextClosed, 1);
});

test("SessionManager relaunches context if newPage fails with target-closed error", async () => {
  const firstContext = createFakeContext({
    failNewPageCount: 1,
    failNewPageMessage: "browserContext.newPage: Target page, context or browser has been closed"
  });
  const secondContext = createFakeContext();
  let launchCount = 0;

  const manager = createManager(async () => {
    launchCount += 1;
    return launchCount === 1 ? firstContext : secondContext;
  });

  const page = await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
  assert.ok(page);
  assert.equal(launchCount, 2);
  assert.equal(secondContext.pageCount(), 1);
});

test("SessionManager reuses an unassigned default about:blank page", async () => {
  const defaultBlankPage = createFakePage("about:blank");
  const context = createFakeContext({ initialPages: [defaultBlankPage] });

  const manager = createManager(async () => context);
  const page = await manager.getManagedPage({ platform: "LINKEDIN" });

  assert.equal(page, defaultBlankPage);
  assert.equal(context.pageCount(), 1);
});

test("SessionManager does not reuse blank page already mapped to another platform", async () => {
  const defaultBlankPage = createFakePage("about:blank");
  const context = createFakeContext({ initialPages: [defaultBlankPage] });

  const manager = createManager(async () => context);

  const instagramPage = await manager.getManagedPage({ platform: "INSTAGRAM" });
  assert.equal(instagramPage, defaultBlankPage);

  const linkedInPage = await manager.getManagedPage({ platform: "LINKEDIN" });
  assert.notEqual(linkedInPage, instagramPage);
  assert.equal(context.pageCount(), 2);

  const linkedInPageAgain = await manager.getManagedPage({ platform: "LINKEDIN" });
  assert.equal(linkedInPageAgain, linkedInPage);
});

test("SessionManager closePlatformPage waits for active platform lease to drain", async () => {
  const context = createFakeContext();
  const manager = createManager(async () => context);
  await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });

  const lease = createDeferred();
  const leaseWork = manager.withPlatformLease({ platform: "LINKEDIN", personKey: "default" }, async () => {
    await lease.promise;
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  let closeFinished = false;
  const closePromise = manager.closePlatformPage({ platform: "LINKEDIN", personKey: "default" }).then(() => {
    closeFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(closeFinished, false);

  lease.resolve();
  await leaseWork;
  await closePromise;
  assert.equal(closeFinished, true);
});
