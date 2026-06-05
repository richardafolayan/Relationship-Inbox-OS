#!/usr/bin/env node
//
// Relationship Inbox OS — start (student wrapper).
//
// Starts the app and opens it in your browser, then keeps running so the app
// stays up. This is the friendly way to re-launch after the first install:
//
//   node scripts/start-student.mjs
//
// (It's the same as `npm run dev`, but it also opens the browser for you and
// prints plain-English status. Stop the app with Ctrl+C.)

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
      say(`  ${C.green}${C.bold}Relationship Inbox OS is running.${C.reset}`);
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

say(`\n${C.bold}Starting Relationship Inbox OS…${C.reset}`);
say(`${C.dim}(first start takes a minute)${C.reset}`);

const dev = spawn("npm", ["run", "dev"], { cwd: APP_DIR, stdio: "inherit" });

dev.on("error", (err) => {
  say(`Could not start the app: ${err.message}`);
  say(`Try running it manually:  cd "${APP_DIR}" && npm run dev`);
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
