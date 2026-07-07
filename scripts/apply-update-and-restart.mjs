#!/usr/bin/env node

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppEnv } from "./lib/env-file.mjs";

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
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APP_DIR = resolve(args.dir ? resolve(process.cwd(), args.dir) : DEFAULT_APP_DIR);
const FEED_URL = args.url || process.env.RIOS_UPDATE_FEED_URL || "";

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
    rmSync(join(APP_DIR, "data", "pending-update.json"), { force: true });
  } catch {
    // A stale pending intent only affects the next manual launch; ignore.
  }
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
    say(`Started Relationship Inbox OS again (pid ${child.pid ?? "unknown"}).`);
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
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [join(APP_DIR, "scripts/update-student.mjs"), "--apply", "--url", FEED_URL, "--dir", APP_DIR],
      { cwd: APP_DIR, stdio: "inherit" }
    );
    child.on("error", (error) => {
      say(`Could not start updater: ${error.message}`);
      resolveRun(false);
    });
    child.on("close", (code) => resolveRun(code === 0));
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
  const ok = await runUpdater();
  if (ok) {
    removePendingIntent();
  } else {
    say("Updater failed or rolled back. Checking whether the app is still running.");
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
