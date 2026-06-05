#!/usr/bin/env node
//
// Relationship Inbox OS — doctor.
//
// A plain-English health check for the student pilot. Run it any time the app
// looks wrong:
//
//   node scripts/doctor.mjs
//
// It prints PASS / WARN / FAIL for each thing the app needs, plus the exact
// next step for anything that failed. It changes nothing and needs no
// dependencies of its own, so it works even if `npm install` didn't finish.
//
// Exit code is 0 when nothing FAILed, 1 otherwise.

import { execSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isTTY = process.stdout.isTTY;
const C = isTTY
  ? {
      bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m",
      red: "\x1b[31m", cyan: "\x1b[36m", reset: "\x1b[0m"
    }
  : { bold: "", dim: "", green: "", yellow: "", red: "", cyan: "", reset: "" };

const results = [];
// add(status, label, detail, next)
const PASS = "PASS", WARN = "WARN", FAIL = "FAIL";
function add(status, label, detail, next) {
  results.push({ status, label, detail, next });
}

// ---- tiny .env reader (no dotenv dependency) ----------------------------
function readEnv() {
  const file = join(APP_DIR, ".env");
  const env = {};
  if (!existsSync(file)) return { env, exists: false };
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return { env, exists: true };
}

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

async function httpOk(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

const { env, exists: envExists } = readEnv();
const DASHBOARD_PORT = env.DASHBOARD_PORT || process.env.DASHBOARD_PORT || "3100";
const RUNNER_PORT = env.RUNNER_PORT || process.env.RUNNER_PORT || "4001";

// ---- checks --------------------------------------------------------------

function checkMacOS() {
  if (process.platform !== "darwin") {
    add(FAIL, "macOS", `This is not a Mac (${process.platform}).`,
      "Relationship Inbox OS needs a Mac for iMessage. Run it on a MacBook.");
    return;
  }
  const ver = sh("sw_vers -productVersion") || "unknown";
  const major = parseInt(ver, 10);
  if (Number.isFinite(major) && major < 13) {
    add(WARN, "macOS", `Version ${ver}.`, "macOS Ventura (13) or newer is recommended.");
  } else {
    add(PASS, "macOS", `Version ${ver}.`);
  }
}

function checkNode() {
  const major = parseInt(process.versions.node, 10);
  if (major === 22) {
    add(PASS, "Node.js", `v${process.versions.node}.`);
  } else if (major >= 26) {
    add(FAIL, "Node.js", `v${process.versions.node} — too new.`,
      "Node 26+ makes the database library compile from source (needs Xcode/Python). " +
      "Install Node 22 from the installer, or from https://nodejs.org/download/release/latest-v22.x/");
  } else if (major < 20) {
    add(FAIL, "Node.js", `v${process.versions.node} — too old.`,
      "Install Node 22 from https://nodejs.org/download/release/latest-v22.x/");
  } else {
    add(WARN, "Node.js", `v${process.versions.node}.`,
      "The app is pinned to Node 22. It may run on this version, but install Node 22 if anything misbehaves.");
  }
}

function checkNpm() {
  const v = sh("npm -v");
  if (v) add(PASS, "npm", `v${v}.`);
  else add(FAIL, "npm", "npm not found.", "Reinstall Node 22 — npm comes with it.");
}

function checkAppFolder() {
  const pkg = join(APP_DIR, "package.json");
  if (existsSync(pkg) && readFileSync(pkg, "utf8").includes('"relationship-inbox-os"')) {
    add(PASS, "App folder", APP_DIR);
  } else {
    add(FAIL, "App folder", `Doesn't look like the app: ${APP_DIR}`,
      "Run the doctor from inside the Relationship Inbox OS folder.");
  }
}

function checkNodeModules() {
  if (existsSync(join(APP_DIR, "node_modules"))) {
    add(PASS, "Dependencies", "Installed.");
  } else {
    add(FAIL, "Dependencies", "node_modules is missing.",
      `Run: cd "${APP_DIR}" && npm install --include=dev`);
  }
}

// Returns the absolute sqlite file path the runner will actually use,
// mirroring resolveDatabaseUrl in apps/runner/src/config.ts.
function resolveDbFile() {
  const fallback = join(APP_DIR, "data", "inbox-os.sqlite");
  const raw = (env.DATABASE_URL || "").trim();
  if (!raw || !raw.startsWith("file:")) return fallback;
  let p = raw.slice("file:".length);
  if (p.startsWith("/")) return p;
  p = p.replace(/^\.\//, "");
  return resolve(APP_DIR, p);
}

function checkEnv() {
  if (!envExists) {
    add(WARN, ".env settings file", "Not created yet.",
      `Run: cd "${APP_DIR}" && cp .env.example .env  (the installer does this for you)`);
    return;
  }
  add(PASS, ".env settings file", "Present.");

  const raw = (env.DATABASE_URL || "").trim();
  if (!raw) {
    add(WARN, "DATABASE_URL", "Not set — the runner falls back to its default path.",
      "Optional: set DATABASE_URL to an absolute file: path in .env.");
  } else if (raw.startsWith("file:")) {
    const p = raw.slice("file:".length);
    if (p.startsWith("/")) add(PASS, "DATABASE_URL", "Absolute path.");
    else add(WARN, "DATABASE_URL", `Relative path (${raw}).`,
      "The runner now resolves this against the app folder automatically, but an absolute file: path is clearer.");
  } else {
    add(WARN, "DATABASE_URL", `Non-file URL (${raw}).`, "The pilot uses a local SQLite file: path.");
  }
}

function nearestExistingAncestor(p) {
  let cur = p;
  while (cur && !existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

function checkDatabase() {
  const dbFile = resolveDbFile();
  const parent = dirname(dbFile);
  // The data/ folder may not exist until db:push runs; test the nearest
  // ancestor that does, so a fresh-but-writable install doesn't false-fail.
  const writableTarget = nearestExistingAncestor(parent);
  try {
    accessSync(writableTarget, constants.W_OK);
  } catch {
    add(FAIL, "Database folder", `Can't write to ${writableTarget}.`,
      "Move the app somewhere your user owns (e.g. your home folder) and reinstall.");
    return;
  }
  if (existsSync(dbFile)) {
    const kb = Math.round(statSync(dbFile).size / 1024);
    add(PASS, "Local database", `Ready (${dbFile}, ${kb} KB).`);
  } else {
    add(WARN, "Local database", "Not created yet.",
      `Run: cd "${APP_DIR}" && npm run db:push`);
  }
}

async function checkDashboard() {
  const r = await httpOk(`http://localhost:${DASHBOARD_PORT}`);
  if (r.ok || (r.status > 0 && r.status < 500)) {
    add(PASS, "Dashboard", `Responding on port ${DASHBOARD_PORT}.`);
  } else {
    add(WARN, "Dashboard", `Nothing on port ${DASHBOARD_PORT}.`,
      `Start the app: cd "${APP_DIR}" && npm run dev`);
  }
}

async function checkRunner() {
  const r = await httpOk(`http://localhost:${RUNNER_PORT}/health`);
  if (r.ok) {
    add(PASS, "Runner", `Healthy on port ${RUNNER_PORT}.`);
  } else if (r.status > 0) {
    add(WARN, "Runner", `Port ${RUNNER_PORT} answered ${r.status}.`,
      "The runner is starting or unhealthy — wait a moment, then reload the app.");
  } else {
    add(WARN, "Runner", `Nothing on port ${RUNNER_PORT}.`,
      `Start the app: cd "${APP_DIR}" && npm run dev`);
  }
}

function checkMessagesDb() {
  if (process.platform !== "darwin") return;
  const imessageOn = (env.IMESSAGE_ENABLED || "").trim().toLowerCase() === "true";
  const dbPath = (env.IMESSAGE_DB_PATH || "").trim() ||
    join(homedir(), "Library", "Messages", "chat.db");
  if (!existsSync(dbPath)) {
    add(WARN, "iMessage database", "No Messages database found.",
      "Open the Messages app and sign in, then send/receive a message so chat.db exists.");
    return;
  }
  try {
    accessSync(dbPath, constants.R_OK);
    // Can read the path — but Full Disk Access is what really matters.
    add(PASS, "iMessage database", imessageOn ? "Readable." : "Readable (iMessage is off in .env).");
  } catch {
    add(FAIL, "iMessage database", "Found but not readable.",
      "Give Terminal Full Disk Access: System Settings → Privacy & Security → Full Disk Access → turn on Terminal, then restart the app.");
  }
}

function checkLinkedInBrowser() {
  const chromiumGlob = join(homedir(), "Library", "Caches", "ms-playwright");
  const hasChromium = existsSync(chromiumGlob) &&
    sh(`ls -d "${chromiumGlob}"/chromium* 2>/dev/null | head -1`);
  if (!hasChromium) {
    add(WARN, "LinkedIn browser", "Chromium for LinkedIn isn't installed yet.",
      `Run: cd "${APP_DIR}" && npx playwright install chromium`);
  } else {
    add(PASS, "LinkedIn browser", "Chromium installed.");
  }

  const mode = (env.BROWSER_PROFILE_MODE || "personal").trim().toLowerCase();
  if (mode === "personal") {
    const userData = (env.PERSONAL_CHROME_USER_DATA_DIR || "").trim() ||
      join(homedir(), "Library", "Application Support", "Google", "Chrome");
    if (existsSync(userData)) {
      add(PASS, "LinkedIn login", "Chrome profile found — you'll use the LinkedIn you're already signed into.");
    } else {
      add(WARN, "LinkedIn login", "No Chrome profile found.",
        "Install Google Chrome and sign into LinkedIn in it, or set BROWSER_PROFILE_MODE=isolated in .env.");
    }
  } else {
    const isoProfile = join(APP_DIR, "data", "profiles", "linkedin");
    if (existsSync(isoProfile)) add(PASS, "LinkedIn login", "Isolated browser profile exists.");
    else add(WARN, "LinkedIn login", "You'll sign into LinkedIn the first time you connect it.");
  }
}

function checkAiKey() {
  const provider = (env.AI_PROVIDER || "openai").trim().toLowerCase();
  const keyByProvider = {
    openai: env.OPENAI_API_KEY, glm: env.Z_AI_API_KEY, gemini: env.GEMINI_API_KEY
  };
  const key = (keyByProvider[provider] || "").trim();
  if (key) {
    add(PASS, "AI key", `${provider} key set.`);
  } else {
    add(WARN, "AI key", `No ${provider} key in .env.`,
      "AI summaries and reply help stay off until a key is set. The app still works without it.");
  }
}

// ---- run + report --------------------------------------------------------

async function main() {
  checkMacOS();
  checkNode();
  checkNpm();
  checkAppFolder();
  checkNodeModules();
  checkEnv();
  checkDatabase();
  await checkDashboard();
  await checkRunner();
  checkMessagesDb();
  checkLinkedInBrowser();
  checkAiKey();

  const badge = (s) =>
    s === PASS ? `${C.green}PASS${C.reset}` :
    s === WARN ? `${C.yellow}WARN${C.reset}` :
    `${C.red}FAIL${C.reset}`;

  process.stdout.write(`\n${C.bold}${C.cyan}Relationship Inbox OS — health check${C.reset}\n\n`);
  for (const r of results) {
    process.stdout.write(`  [${badge(r.status)}] ${C.bold}${r.label}${C.reset} — ${r.detail || ""}\n`);
    if (r.next && r.status !== PASS) {
      process.stdout.write(`         ${C.dim}→ ${r.next}${C.reset}\n`);
    }
  }

  const fails = results.filter((r) => r.status === FAIL).length;
  const warns = results.filter((r) => r.status === WARN).length;
  process.stdout.write("\n");
  if (fails === 0 && warns === 0) {
    process.stdout.write(`  ${C.green}Everything looks good.${C.reset}\n\n`);
  } else if (fails === 0) {
    process.stdout.write(`  ${C.green}No blockers.${C.reset} ${warns} thing(s) to look at above.\n\n`);
  } else {
    process.stdout.write(`  ${C.red}${fails} thing(s) need fixing${C.reset} (and ${warns} to look at). Follow the → steps above.\n\n`);
  }
  process.exit(fails === 0 ? 0 : 1);
}

main();
