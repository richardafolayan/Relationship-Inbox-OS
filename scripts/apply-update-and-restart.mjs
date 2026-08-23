#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppEnv } from "./lib/env-file.mjs";
import { resolveAppName } from "./lib/branding.mjs";

const APP_NAME = resolveAppName();

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_DIR = resolve(SCRIPT_DIR, "..");
loadAppEnv(DEFAULT_APP_DIR);
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || "3100";
const RUNNER_PORT = process.env.RUNNER_PORT || "4001";
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") out.url = argv[++i];
    else if (arg === "--dir") out.dir = argv[++i];
    else if (arg === "--bundle") out.bundle = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APP_DIR = resolve(args.dir ? resolve(process.cwd(), args.dir) : DEFAULT_APP_DIR);
const FEED_URL = args.url || process.env.RIOS_UPDATE_FEED_URL || "";
// Packaged mode (dev-channel Tovi.app): quit the app, swap the code inside the
// bundle, re-sign it, and relaunch it with `open` instead of the start wrapper.
const APP_BUNDLE = args.bundle ? resolve(process.cwd(), args.bundle) : "";

function say(message) {
  process.stdout.write(`${message}\n`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function probe(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function dashboardUp() {
  return probe(DASHBOARD_URL);
}

async function runnerUp() {
  return probe(`http://localhost:${RUNNER_PORT}/health`);
}

function removePendingIntent() {
  try {
    // Packaged installs keep data in Application Support (RIOS_DATA_DIR);
    // zip installs keep it under the app folder.
    const dataDir = process.env.RIOS_DATA_DIR?.trim() || join(APP_DIR, "data");
    rmSync(join(dataDir, "pending-update.json"), { force: true });
  } catch {
    // A stale pending intent only affects the next manual launch; ignore.
  }
}

function bundleId() {
  try {
    return execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print CFBundleIdentifier", join(APP_BUNDLE, "Contents", "Info.plist")],
      { encoding: "utf8" }
    ).trim();
  } catch {
    // The shipped bundle id (kept stable for macOS TCC grants).
    return "com.relationshipinboxos.desktop";
  }
}

function bundleProcessRunning() {
  try {
    execFileSync("pgrep", ["-f", join(APP_BUNDLE, "Contents", "MacOS")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Quit the packaged app before touching its code. Graceful AppleScript quit
 * (Electron runs its normal shutdown, stopping the runner + dashboard), then
 * wait for the ports and the process to go away. Returns false if the app is
 * still running at the deadline; the caller must NOT swap code under it.
 */
async function packagedAppGone() {
  return !(await dashboardUp()) && !(await runnerUp()) && !bundleProcessRunning();
}

async function waitUntilGone(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await packagedAppGone()) return true;
    await delay(1500);
  }
  return packagedAppGone();
}

async function quitPackagedApp() {
  const id = bundleId();
  say(`Asking ${id} to quit before updating.`);
  try {
    // Graceful first: Electron runs its normal shutdown (stops runner +
    // dashboard cleanly). May be denied by Automation permissions for a
    // headless node process, hence the SIGTERM fallback below.
    execFileSync("osascript", ["-e", `quit app id "${id}"`], { stdio: "ignore", timeout: 10_000 });
  } catch {
    say("Quit request failed; falling back to a direct terminate.");
  }
  if (await waitUntilGone(15_000)) return true;
  try {
    say("Still running; sending SIGTERM to the app processes.");
    execFileSync("pkill", ["-TERM", "-f", join(APP_BUNDLE, "Contents", "MacOS")], { stdio: "ignore" });
  } catch {
    // pkill exits non-zero when nothing matched; the wait below settles it.
  }
  return waitUntilGone(30_000);
}

function relaunchBundle() {
  spawn("open", [APP_BUNDLE], { stdio: "ignore", detached: true }).on("error", (error) => {
    say(`Could not reopen the app: ${error.message}`);
  });
}

function launchApp() {
  const logsDir = join(APP_DIR, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "app-restart.log");
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [join(APP_DIR, "scripts/start-app.mjs")], {
      cwd: APP_DIR,
      detached: true,
      stdio: ["ignore", fd, fd]
    });
    child.on("error", (error) => {
      say(`Could not restart the app: ${error.message}`);
    });
    child.unref();
    say(`Started ${APP_NAME} again (pid ${child.pid ?? "unknown"}).`);
  } finally {
    closeSync(fd);
  }
}

async function openWhenReady() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await dashboardUp()) {
      spawn("open", [DASHBOARD_URL], { stdio: "ignore" }).on("error", () => {});
      return;
    }
    await delay(2500);
  }
  say(`Dashboard did not come back within the startup window: ${DASHBOARD_URL}`);
}

function runUpdater() {
  const updaterArgs = [
    join(APP_DIR, "scripts/update-student.mjs"),
    "--apply", "--url", FEED_URL, "--dir", APP_DIR
  ];
  if (APP_BUNDLE) {
    // Keep staging + backups OUTSIDE the .app bundle, and hold only one old
    // copy (each backup carries a full node_modules).
    const backupRoot = process.env.RIOS_CONFIG_DIR?.trim()
      ? join(process.env.RIOS_CONFIG_DIR.trim(), "updates")
      : join(tmpdir(), "rios-updates");
    mkdirSync(backupRoot, { recursive: true });
    updaterArgs.push("--backup-root", backupRoot, "--resign", APP_BUNDLE, "--keep-backups", "1");
  }
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      updaterArgs,
      { cwd: APP_DIR, stdio: "inherit" }
    );
    child.on("error", (error) => {
      say(`Could not start updater: ${error.message}`);
      resolveRun(null);
    });
    child.on("close", (code) => resolveRun(code));
  });
}

async function main() {
  if (!existsSync(join(APP_DIR, "package.json"))) {
    throw new Error(`That does not look like the app folder: ${APP_DIR}`);
  }
  if (!FEED_URL) {
    throw new Error("No update feed URL was provided.");
  }

  say(`=== update restart at ${new Date().toISOString()} ===`);
  await delay(800);

  if (APP_BUNDLE) {
    if (!(await quitPackagedApp())) {
      say("The app is still running, so the in-place update was NOT applied. Try again from Settings.");
      process.exit(1);
    }
    const code = await runUpdater();
    if (code === 0 || code === 42) removePendingIntent();
    if (code === 42) {
      say("Database recovery is required. The new recovery-capable version was kept and will reopen with recovery guidance.");
    } else if (code !== 0) {
      say("The update did not complete. Reopening the installed app so it can report its current state.");
    }
    relaunchBundle();
    return;
  }

  const code = await runUpdater();
  if (code === 0 || code === 42) {
    removePendingIntent();
  }
  if (code === 42) {
    say("Database recovery is required. The new recovery-capable version was kept; starting it to continue recovery.");
  } else if (code !== 0) {
    say("The update did not complete. Checking the installed app's current state.");
  }

  if (!(await dashboardUp()) && !(await runnerUp())) {
    launchApp();
    await openWhenReady();
  } else {
    say("An app process is already running, so no duplicate launch was started.");
  }
}

main().catch((error) => {
  say(error?.message || String(error));
  process.exit(1);
});
