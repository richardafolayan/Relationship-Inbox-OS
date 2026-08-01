import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionManager,
  resolveBrowserActivateAppBundlePath
} from "../apps/runner/dist/services/session-manager.js";

// The session manager hides every runner-initiated browser launch by default
// (off-screen launch args + minimize), and only launches visibly when an
// operator action marks the intent or the kill-switch is set. These tests
// drive the real session manager with a fake launcher and assert which launch
// args it passed - the off-screen position args are the observable signal of
// "this launch was hidden".

const defaultBrowserProfile = {
  mode: "isolated",
  fallbackBehavior: "isolated",
  personalProfileSyncMode: "off",
  personalChromeUserDataDir: "",
  personalChromeProfileDirectory: "Default",
  personalChromeProfileName: "Default",
  personalChromeProfileResolutionStrategy: "explicit"
};

const defaultSettings = { headless: false };

function makeFakePage() {
  let closed = false;
  const listeners = [];
  return {
    url: () => "about:blank",
    isClosed: () => closed,
    bringToFront: async () => {},
    // no newCDPSession -> hide/reveal no-op (we assert via launch args, not CDP)
    close: async () => {
      closed = true;
      listeners.forEach((l) => l());
    },
    on: (e, l) => {
      if (e === "close") listeners.push(l);
    }
  };
}

function makeFakeContext() {
  const pages = [makeFakePage()];
  let closed = false;
  const listeners = [];
  return {
    pages: () => {
      if (closed) throw new Error("context closed");
      return pages;
    },
    newPage: async () => {
      const p = makeFakePage();
      pages.push(p);
      return p;
    },
    on: (e, l) => {
      if (e === "close") listeners.push(l);
    },
    close: async () => {
      closed = true;
      listeners.forEach((l) => l());
    }
  };
}

function makeManager() {
  const launches = [];
  const manager = createSessionManager({
    profileRootDir: join(tmpdir(), `sm-hidden-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    browserProfile: defaultBrowserProfile,
    getSettings: async () => defaultSettings,
    launchPersistentContext: async (userDataDir, options) => {
      launches.push({ userDataDir, options });
      return makeFakeContext();
    }
  });
  return { manager, launches };
}

const hasOffscreenArg = (options) =>
  Array.isArray(options.args) && options.args.some((a) => /^--window-position=\d{5},\d{5}$/.test(a));

test("installed Chrome sessions reveal standard Chrome instead of Patchright Chrome", () => {
  assert.equal(
    resolveBrowserActivateAppBundlePath({
      hostPlatform: "darwin",
      browserProfileMode: "personal",
      preferInstalledChrome: true,
      patchrightExecutablePath:
        "/tmp/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    }),
    "/Applications/Google Chrome.app"
  );
});

test("a default (background) launch is hidden: off-screen launch args are passed", async () => {
  const { manager, launches } = makeManager();
  await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
  assert.equal(launches.length, 1);
  assert.ok(hasOffscreenArg(launches[0].options), "background launch carries off-screen window args");
});

test("an operator visible-intent launch is NOT hidden", async () => {
  const { manager, launches } = makeManager();
  const release = manager.markVisibleLaunch("LINKEDIN");
  await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
  release();
  assert.equal(launches.length, 1);
  assert.equal(hasOffscreenArg(launches[0].options), false, "visible launch has no off-screen args");
});

test("the RIOS_VISIBLE_BROWSER_LAUNCH kill-switch forces a visible launch", async () => {
  const prev = process.env.RIOS_VISIBLE_BROWSER_LAUNCH;
  process.env.RIOS_VISIBLE_BROWSER_LAUNCH = "1";
  try {
    const { manager, launches } = makeManager();
    await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
    assert.equal(hasOffscreenArg(launches[0].options), false, "kill-switch launch is visible");
  } finally {
    if (prev === undefined) delete process.env.RIOS_VISIBLE_BROWSER_LAUNCH;
    else process.env.RIOS_VISIBLE_BROWSER_LAUNCH = prev;
  }
});

test("markVisibleLaunch is refcounted: still visible until every holder releases", async () => {
  const { manager, launches } = makeManager();
  const r1 = manager.markVisibleLaunch("LINKEDIN");
  const r2 = manager.markVisibleLaunch("LINKEDIN");
  r1();
  await manager.getManagedPage({ platform: "LINKEDIN", personKey: "default" });
  assert.equal(hasOffscreenArg(launches[0].options), false, "still visible while one holder remains");
  r2();
});

test("revealWindow is a no-op when the platform has no live page", async () => {
  const { manager } = makeManager();
  await manager.revealWindow("LINKEDIN"); // must not throw
  assert.ok(true);
});
