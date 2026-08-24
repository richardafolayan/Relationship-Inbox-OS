import test from "node:test";
import assert from "node:assert/strict";
import {
  backgroundWindowLaunchArgs,
  hideBrowserWindow,
  isVisibleBrowserLaunchForced,
  revealBrowserWindow
} from "../apps/runner/dist/services/runner-window.js";

// Window-control helpers for the focus-steal fix. The runner keeps patchright's
// real headed launch (unchanged LinkedIn fingerprint) and instead hides the
// window via the launched browser's own CDP session. These tests pin the CDP
// commands each helper issues, and that everything degrades to a no-op on a
// mock page (no real Chrome / no permissions) so a hide failure can never
// break a launch or send.

function makeCdpPage() {
  const sends = [];
  let broughtToFront = 0;
  const session = {
    send: async (method, params) => {
      sends.push({ method, params });
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 7 };
      }
      return {};
    },
    detach: async () => {
      sends.push({ method: "__detach" });
    }
  };
  const page = {
    context: () => ({ newCDPSession: async () => session }),
    bringToFront: async () => {
      broughtToFront += 1;
    }
  };
  return { page, sends, frontCount: () => broughtToFront };
}

test("backgroundWindowLaunchArgs positions the window off every display", () => {
  const args = backgroundWindowLaunchArgs();
  assert.ok(args.some((a) => /^--window-position=\d{5},\d{5}$/.test(a)), "off-screen position arg present");
});

test("isVisibleBrowserLaunchForced reads the kill-switch env", () => {
  const prev = process.env.RIOS_VISIBLE_BROWSER_LAUNCH;
  try {
    delete process.env.RIOS_VISIBLE_BROWSER_LAUNCH;
    assert.equal(isVisibleBrowserLaunchForced(), false);
    process.env.RIOS_VISIBLE_BROWSER_LAUNCH = "1";
    assert.equal(isVisibleBrowserLaunchForced(), true);
  } finally {
    if (prev === undefined) delete process.env.RIOS_VISIBLE_BROWSER_LAUNCH;
    else process.env.RIOS_VISIBLE_BROWSER_LAUNCH = prev;
  }
});

test("hideBrowserWindow minimizes via CDP and always detaches", async () => {
  const { page, sends } = makeCdpPage();
  await hideBrowserWindow(page, null);
  const minimize = sends.find((s) => s.method === "Browser.setWindowBounds");
  assert.ok(minimize, "issued a setWindowBounds");
  assert.deepEqual(minimize.params, { windowId: 7, bounds: { windowState: "minimized" } });
  assert.ok(sends.some((s) => s.method === "__detach"), "CDP session detached");
});

test("revealBrowserWindow un-minimizes, moves on-screen, and raises the tab", async () => {
  const { page, sends, frontCount } = makeCdpPage();
  await revealBrowserWindow(page);
  const bounds = sends.filter((s) => s.method === "Browser.setWindowBounds");
  assert.equal(bounds.length, 2, "two bounds calls: normal state, then on-screen position");
  assert.deepEqual(bounds[0].params.bounds, { windowState: "normal" });
  assert.ok(typeof bounds[1].params.bounds.left === "number" && bounds[1].params.bounds.left < 5000, "on-screen left");
  assert.equal(frontCount(), 1, "tab raised");
});

test("helpers no-op cleanly on a mock page without CDP (never throw)", async () => {
  const plainPage = { context: () => ({}) };
  await hideBrowserWindow(plainPage, null); // must not throw
  await revealBrowserWindow(plainPage); // must not throw
  await hideBrowserWindow(undefined, null); // null page must not throw
  assert.ok(true);
});
