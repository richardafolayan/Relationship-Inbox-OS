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
    close: async () => {
      closed = true;
      for (const page of pages) {
        await page.close();
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
