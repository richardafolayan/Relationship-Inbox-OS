import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Keeping the runner's automation browser out of the operator's face.
//
// The runner drives a real, headed Chrome (patchright) so LinkedIn sees a
// genuine browser fingerprint - going headless would change that fingerprint
// on the most ban-sensitive surface (automated send), so it is off the table.
// But a headed cold launch ACTIVATES Chrome on macOS: it becomes the
// foreground app and, if its window lands on another Space, macOS animates
// the operator onto that desktop mid-task. That is what Richard sees when a
// send (or scan) fires while LinkedIn isn't already open.
//
// Fix without touching the fingerprint: launch exactly as before, but
//   1. position the window off every display (so it is never visible), and
//   2. the instant the context is up, minimize the window via the launched
//      browser's OWN CDP session (patchright's CDP, NOT an external attach -
//      so the fingerprint is unchanged) and hand focus back to whatever the
//      operator had in front.
// Operator-initiated "show me the browser" actions (Connect login, open a
// thread / profile in the runner's Chrome) call revealBrowserWindow to undo
// this. Everything else - send, scan, boot, scheduled send, reconnect - stays
// hidden. RIOS_VISIBLE_BROWSER_LAUNCH=1 restores the old always-visible path.
//
// Every function here is best-effort: a failure must never break a launch,
// a send, or a scan. They no-op cleanly off macOS and on mock pages (tests).

// Far enough off any plausible multi-monitor arrangement that the window is
// never visible even for the instant before it is minimized.
const OFFSCREEN_LEFT = 24000;
const OFFSCREEN_TOP = 24000;

// Where a revealed window lands when we bring it back on-screen.
const ONSCREEN_BOUNDS = { left: 80, top: 80, width: 1280, height: 880 };

let activateAppBundlePath: string | null = null;

/** One-time hint (the Chrome.app bundle path) so reveal can foreground the app. */
export function setBrowserActivateHint(appBundlePath: string | null): void {
  activateAppBundlePath = appBundlePath && appBundlePath.trim() ? appBundlePath : null;
}

export function isVisibleBrowserLaunchForced(): boolean {
  return process.env.RIOS_VISIBLE_BROWSER_LAUNCH === "1";
}

/** Launch args that place the first window off every display. Cheap, no perms. */
export function backgroundWindowLaunchArgs(): string[] {
  return [`--window-position=${OFFSCREEN_LEFT},${OFFSCREEN_TOP}`, "--window-size=480,360"];
}

/**
 * Best-effort name of the frontmost macOS app, captured BEFORE a launch so we
 * can hand focus back after the browser self-activates. Null off macOS, on a
 * missing/denied automation permission, or on any error - all of which just
 * mean "skip the refocus" (the window is still hidden either way).
 */
export async function captureFrontmostMacApp(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 2000 }
    );
    const name = stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

interface CdpCapablePage {
  context(): {
    newCDPSession?: (page: unknown) => Promise<CdpSession>;
  };
  bringToFront?: () => Promise<void>;
}

interface CdpSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  detach?: () => Promise<void>;
}

async function withWindowCdp<T>(page: unknown, fn: (session: CdpSession, windowId: number) => Promise<T>): Promise<T | null> {
  const candidate = page as CdpCapablePage | null;
  const newCDPSession = candidate?.context?.().newCDPSession;
  if (typeof newCDPSession !== "function") {
    // Mock page (tests) or an environment without CDP - nothing to do.
    return null;
  }
  let session: CdpSession | null = null;
  try {
    session = await newCDPSession.call(candidate!.context(), candidate);
    const target = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
    return await fn(session, target.windowId);
  } catch {
    return null;
  } finally {
    if (session?.detach) {
      await session.detach().catch(() => undefined);
    }
  }
}

async function refocusMacApp(appName: string | null): Promise<void> {
  if (process.platform !== "darwin" || !appName) {
    return;
  }
  // `open -a <name>` reactivates the operator's previous app. Best-effort and
  // non-blocking; a wrong/closed name simply does nothing.
  try {
    await execFileAsync("open", ["-a", appName], { timeout: 2000 });
  } catch {
    // ignore - focus simply stays where the OS left it
  }
}

/**
 * Minimize the just-launched window and return focus to the operator's app.
 * The window was launched off-screen, so the operator never sees it; this
 * also removes it from the window list so a later Space switch can't surface
 * it. No-op on mock pages / off macOS / without CDP.
 */
export async function hideBrowserWindow(page: unknown, previousFrontmostApp: string | null): Promise<void> {
  await withWindowCdp(page, async (session, windowId) => {
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    return null;
  });
  await refocusMacApp(previousFrontmostApp);
}

/**
 * Bring a (possibly hidden/minimized) runner window back on-screen and to the
 * front - the operator explicitly asked to see it (Connect login, open thread
 * / profile). Restores normal state + on-screen bounds, raises the tab, and
 * foregrounds the app when we know its bundle path.
 */
export async function revealBrowserWindow(page: unknown): Promise<void> {
  await withWindowCdp(page, async (session, windowId) => {
    // Un-minimize first; some Chrome builds reject a bounds change made in the
    // same call as a state change, so split them.
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await session.send("Browser.setWindowBounds", { windowId, bounds: ONSCREEN_BOUNDS });
    return null;
  });
  const candidate = page as CdpCapablePage | null;
  if (typeof candidate?.bringToFront === "function") {
    await candidate.bringToFront().catch(() => undefined);
  }
  if (process.platform === "darwin" && activateAppBundlePath) {
    try {
      await execFileAsync("open", ["-a", activateAppBundlePath], { timeout: 2000 });
    } catch {
      // ignore - the window is already normal + on-screen + raised
    }
  }
}
