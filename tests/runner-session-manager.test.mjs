import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionManager } from "../apps/runner/dist/services/session-manager.js";

function createFakePage() {
  let closed = false;
  const closeListeners = [];
  return {
    isClosed: () => closed,
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

function createFakeContext() {
  const pages = [];
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
      const page = createFakePage();
      pages.push(page);
      return page;
    },
    close: async () => {
      closed = true;
      for (const page of pages) {
        await page.close();
      }
    }
  };
}

test("SessionManager recreates closed platform pages in the same context", async () => {
  const context = createFakeContext();
  let launchCount = 0;
  const manager = createSessionManager({
    profileRootDir: join(tmpdir(), `session-manager-${Date.now()}`),
    browserProfile: {
      mode: "isolated",
      fallbackBehavior: "allow_isolated",
      personalProfileSyncMode: "smart",
      personalProfileMirrorRoot: "/tmp/mirror-root",
      personalChromeUserDataDir: "/tmp/chrome-user-data",
      personalChromeProfileDirectory: "Default",
      personalChromeProfileName: "Richard",
      personalChromeProfileResolutionStrategy: "directory_exact"
    },
    getSettings: async () => ({
      scanIntervalSeconds: 30,
      amberHours: 24,
      redHours: 72,
      headless: true,
      maxMessagesPerThread: 40,
      enabledPlatforms: ["LINKEDIN", "INSTAGRAM", "TIKTOK"],
      demoMode: false,
      recentThreadSweepCount: 30
    }),
    launchPersistentContext: async () => {
      launchCount += 1;
      return context;
    }
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
  const manager = createSessionManager({
    profileRootDir: join(tmpdir(), `session-manager-reset-${Date.now()}`),
    browserProfile: {
      mode: "isolated",
      fallbackBehavior: "allow_isolated",
      personalProfileSyncMode: "smart",
      personalProfileMirrorRoot: "/tmp/mirror-root",
      personalChromeUserDataDir: "/tmp/chrome-user-data",
      personalChromeProfileDirectory: "Default",
      personalChromeProfileName: "Richard",
      personalChromeProfileResolutionStrategy: "directory_exact"
    },
    getSettings: async () => ({
      scanIntervalSeconds: 30,
      amberHours: 24,
      redHours: 72,
      headless: true,
      maxMessagesPerThread: 40,
      enabledPlatforms: ["LINKEDIN", "INSTAGRAM", "TIKTOK"],
      demoMode: false,
      recentThreadSweepCount: 30
    }),
    launchPersistentContext: async () => {
      const context = createFakeContext();
      const wrapped = {
        ...context,
        close: async () => {
          contextClosed += 1;
          await context.close();
        }
      };
      return wrapped;
    }
  });

  await manager.getManagedPage({ platform: "LINKEDIN" });
  await manager.resetPersonSession({ personKey: "default", clearProfileDir: false });
  assert.equal(contextClosed, 1);

  await manager.getManagedPage({ platform: "LINKEDIN" });
  assert.equal(contextClosed, 1);
});
