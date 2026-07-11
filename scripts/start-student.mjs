#!/usr/bin/env node
//
// Tovi — start (student wrapper).
//
// Starts the app and opens it in your browser, then keeps running so the app
// stays up. This is the friendly way to re-launch after the first install:
//
//   node scripts/start-student.mjs
//
// It opens the browser for you and prints plain-English status. Stop the app
// with Ctrl+C.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppEnv } from "./lib/env-file.mjs";
import { reconcileEnvWithExample } from "./lib/release-manifest.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadAppEnv(APP_DIR);
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || "3100";
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
const START_TIMEOUT_MS = 180_000;

const C = process.stdout.isTTY
  ? { bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", reset: "\x1b[0m" }
  : { bold: "", dim: "", green: "", reset: "" };

function say(msg) {
  process.stdout.write(msg + "\n");
}

async function dashboardUp() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(DASHBOARD_URL, { signal: ctrl.signal });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function openWhenReady() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await dashboardUp()) {
      spawn("open", [DASHBOARD_URL], { stdio: "ignore" }).on("error", () => {});
      say("");
      say(`  ${C.green}${C.bold}Tovi is running.${C.reset}`);
      say(`  • Open in your browser:  ${C.bold}${DASHBOARD_URL}${C.reset}`);
      say(`  • ${C.bold}Leave this window open${C.reset} — it keeps the app running.`);
      say(`  • To stop: press ${C.bold}Ctrl + C${C.reset}.`);
      say("");
      return;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  say(`  The app is taking a while to start. Try opening ${DASHBOARD_URL} yourself,`);
  say(`  or run the health check:  ${C.bold}node scripts/doctor.mjs${C.reset}`);
}

// Apply a prepared update before booting, so the running app never has to
// replace its own code.
function runUpdaterApply(feedUrl) {
  return new Promise((doneResolve) => {
    const child = spawn(
      process.execPath,
      [resolve(APP_DIR, "scripts/update-student.mjs"), "--apply", "--url", feedUrl, "--dir", APP_DIR],
      { cwd: APP_DIR, stdio: "inherit" }
    );
    child.on("error", () => doneResolve(false));
    child.on("close", (code) => doneResolve(code === 0));
  });
}

async function applyPendingUpdate() {
  const intentPath = join(APP_DIR, "data", "pending-update.json");
  if (!existsSync(intentPath)) return;
  let intent = {};
  try {
    intent = JSON.parse(readFileSync(intentPath, "utf8"));
  } catch {
    /* malformed intent — treated as no feed below */
  }
  const feedUrl = intent.feedUrl || process.env.RIOS_UPDATE_FEED_URL || "";
  // Clear the intent FIRST so a failed apply can never loop on every launch.
  try {
    rmSync(intentPath, { force: true });
  } catch {
    /* ignore */
  }
  if (!feedUrl) {
    say(`  A prepared update was found but no update link is set; skipping it.`);
    return;
  }
  say(`\n${C.bold}Applying a prepared update before starting…${C.reset}`);
  const ok = await runUpdaterApply(feedUrl);
  say(
    ok
      ? `  ${C.green}Update applied.${C.reset}`
      : `  The update could not be applied and was rolled back; starting your current version.`
  );
}

// An update keeps the existing .env untouched, so config that ships in a newer
// .env.example (the update feed link, the feedback token, the version stamp)
// would never reach an already-installed pilot. Heal that on every launch:
// fill blank/missing distribution keys and keep the version stamp current —
// never touching values the pilot set themselves. Runs AFTER a prepared update
// applies so it reads the .env.example that arrived with the new build.
function reconcileEnvFile() {
  const envPath = join(APP_DIR, ".env");
  const examplePath = join(APP_DIR, ".env.example");
  if (!existsSync(envPath) || !existsSync(examplePath)) return;
  try {
    const envText = readFileSync(envPath, "utf8");
    const { text, filled, synced } = reconcileEnvWithExample(
      envText,
      readFileSync(examplePath, "utf8")
    );
    if (text === envText) return;
    writeFileSync(envPath, text);
    const keys = [...filled, ...synced];
    if (keys.length) say(`  Updated your settings file (.env) with: ${keys.join(", ")}`);
  } catch {
    // Never block a launch on settings reconciliation.
  }
}

await applyPendingUpdate();
reconcileEnvFile();

say(`\n${C.bold}Starting Tovi…${C.reset}`);
say(`${C.dim}(the first start after an update takes a minute)${C.reset}`);

// start-app.mjs prepares the app (database client, schema, optimised
// production build of the dashboard - each step skipped when nothing
// changed) and then runs the runner + dashboard. The production build is
// what makes pages precompiled, so the app opens and navigates instantly.
const dev = spawn(process.execPath, [resolve(APP_DIR, "scripts/start-app.mjs")], {
  cwd: APP_DIR,
  stdio: "inherit"
});

dev.on("error", (err) => {
  say(`Could not start the app: ${err.message}`);
  say(`Try closing this window and starting Tovi again.`);
  process.exit(1);
});
dev.on("exit", (code) => process.exit(code ?? 0));

// Forward Ctrl+C to the dev process so the whole app stops cleanly.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    dev.kill(sig);
  });
}

openWhenReady();
