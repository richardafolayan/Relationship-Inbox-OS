#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppEnv } from "./lib/env-file.mjs";
import { packagedDashboardArgs } from "./lib/dashboard-command.mjs";
import { prismaDbPushInvocation } from "./lib/prisma-command.mjs";
import { resolveAppName } from "./lib/branding.mjs";
import {
  portConflict,
  reclaimPortConflict,
  recoverPriorRuntime,
  removeRuntimeState,
  stopChildGroups,
  writeRuntimeState
} from "./lib/process-lifecycle.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadAppEnv(APP_DIR);
const APP_NAME = resolveAppName();
const DATA_DIR = resolve(process.env.RIOS_DATA_DIR || join(APP_DIR, "data"));
const STATE_DIR = resolve(process.env.RIOS_STATE_DIR || join(DATA_DIR, "runtime"));
const STAMPS_PATH = join(DATA_DIR, "app-prepare-stamps.json");
const RUNTIME_STATE_PATH = join(STATE_DIR, "processes.json");
const STARTUP_CONFLICT_PATH = join(STATE_DIR, "startup-conflict.json");
const PACKAGED = process.env.RIOS_PACKAGED_APP === "1";
const args = new Set(process.argv.slice(2));
const PREPARE_ONLY = args.has("--prepare-only");
const FORCE_DEV = args.has("--dev") || process.env.RIOS_DEV === "1";
const FORCE_REBUILD = process.env.RIOS_REBUILD === "1";
const DASHBOARD_PORT = String(process.env.DASHBOARD_PORT || "3100");
const RUNNER_PORT = String(process.env.RUNNER_PORT || "4001");
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
const RUNNER_HEALTH_URL = `http://127.0.0.1:${RUNNER_PORT}/health`;
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

const C = process.stdout.isTTY
  ? { bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", reset: "\x1b[0m" }
  : { bold: "", dim: "", green: "", yellow: "", reset: "" };

function say(message) {
  process.stdout.write(`${message}\n`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function loadStamps() {
  return readJson(STAMPS_PATH);
}

function saveStamps(stamps) {
  try {
    mkdirSync(dirname(STAMPS_PATH), { recursive: true });
    writeFileSync(STAMPS_PATH, `${JSON.stringify(stamps, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // The next launch can safely repeat preparation when this cache cannot be saved.
  }
}

function writeStartupConflict(label, conflict) {
  mkdirSync(STATE_DIR, { recursive: true });
  const recoverable = conflict.owners.length > 0 && conflict.owners.every((owner) => owner.toviOwned);
  writeFileSync(
    STARTUP_CONFLICT_PATH,
    `${JSON.stringify({
      version: 1,
      kind: "port_conflict",
      label,
      port: conflict.port,
      recoverable,
      ownerCount: conflict.owners.length
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function hashPaths(paths) {
  const files = [];
  const walk = (path) => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (["node_modules", "dist", ".next"].includes(entry)) continue;
        walk(join(path, entry));
      }
      return;
    }
    files.push(path);
  };
  for (const path of paths) walk(path);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file.slice(APP_DIR.length));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitHead() {
  if (PACKAGED) return "packaged";
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: APP_DIR, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function canResolve(specifier) {
  try {
    createRequire(join(APP_DIR, "package.json")).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

function run(label, command, commandArgs, options = {}) {
  say(`  ${C.dim}${label}${C.reset}`);
  const result = spawnSync(command, commandArgs, { cwd: APP_DIR, stdio: "inherit", ...options });
  return result.status === 0;
}

function probeNativeModule(specifier) {
  return spawnSync(process.execPath, ["-e", `require(${JSON.stringify(specifier)})`], {
    cwd: APP_DIR,
    encoding: "utf8"
  });
}

function nativeModuleNeedsRebuild(result) {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node\.js version/i.test(text);
}

function ensureNativeModules() {
  if (!canResolve("better-sqlite3")) return true;
  const probe = probeNativeModule("better-sqlite3");
  if (probe.status === 0) return true;
  if (PACKAGED || !nativeModuleNeedsRebuild(probe)) {
    say(`  ${C.yellow}The local database driver could not be loaded. Reinstall ${APP_NAME} and try again.${C.reset}`);
    return false;
  }
  say(`  ${C.yellow}The local database driver needs to be rebuilt for Node.js.${C.reset}`);
  return run("Rebuilding the local database driver...", NPM_COMMAND, ["rebuild", "better-sqlite3"])
    && probeNativeModule("better-sqlite3").status === 0;
}

function databaseFile() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url?.startsWith("file:")) return join(DATA_DIR, "inbox-os.sqlite");
  return url.slice("file:".length).split("?", 1)[0] || join(DATA_DIR, "inbox-os.sqlite");
}

function syncDatabase() {
  mkdirSync(DATA_DIR, { recursive: true });
  process.env.DATABASE_URL ||= `file:${join(DATA_DIR, "inbox-os.sqlite")}`;
  const invocation = prismaDbPushInvocation({
    appDir: APP_DIR,
    packaged: PACKAGED,
    npmCommand: NPM_COMMAND
  });
  return run(
    "Updating the database...",
    invocation.command,
    invocation.args,
    { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL } }
  );
}

function packagedArtifactsReady() {
  const required = [
    "packages/core/dist/index.js",
    "apps/runner/dist/index.js",
    "apps/dashboard/.next/BUILD_ID"
  ];
  const missing = required.filter((path) => !existsSync(join(APP_DIR, path)));
  if (missing.length === 0) return true;
  say(`  ${C.yellow}The ${APP_NAME} installation is incomplete (${missing.join(", ")}). Reinstall it and try again.${C.reset}`);
  return false;
}

function prepare() {
  const stamps = FORCE_REBUILD ? {} : loadStamps();
  const next = { ...stamps };
  if (!ensureNativeModules()) return { ok: false };
  if (PACKAGED && !packagedArtifactsReady()) return { ok: false };

  const schemaHash = hashPaths([join(APP_DIR, "packages/core/prisma/schema.prisma")]);
  const schemaChanged = stamps.schemaHash !== schemaHash;
  if (!PACKAGED && (schemaChanged || !canResolve("@prisma/client"))) {
    if (!run("Updating the database client...", NPM_COMMAND, ["run", "db:generate"])) return { ok: false };
  }
  if (schemaChanged || !existsSync(databaseFile())) {
    if (!syncDatabase()) return { ok: false };
  }
  next.schemaHash = schemaHash;
  saveStamps(next);

  if (PACKAGED) return { ok: true, prod: true };

  const coreHash = hashPaths([
    join(APP_DIR, "packages/core/src"),
    join(APP_DIR, "packages/core/package.json"),
    join(APP_DIR, "packages/core/tsconfig.json")
  ]);
  if (stamps.coreHash !== coreHash || !existsSync(join(APP_DIR, "packages/core/dist/index.js"))) {
    if (!run("Building shared components...", NPM_COMMAND, ["run", "build", "--workspace", "@inbox-os/core"])) {
      return { ok: false };
    }
    next.coreHash = coreHash;
    saveStamps(next);
  }

  const runnerHash = hashPaths([
    join(APP_DIR, "apps/runner/src"),
    join(APP_DIR, "apps/runner/package.json"),
    join(APP_DIR, "apps/runner/tsconfig.json")
  ]);
  if (stamps.runnerHash !== runnerHash || !existsSync(join(APP_DIR, "apps/runner/dist/index.js"))) {
    if (!run("Building the local service...", NPM_COMMAND, ["run", "build", "--workspace", "@inbox-os/runner"])) {
      return { ok: false };
    }
    next.runnerHash = runnerHash;
    saveStamps(next);
  }

  if (FORCE_DEV) return { ok: true, prod: false };
  const nextPackage = readJson(join(APP_DIR, "node_modules/next/package.json"));
  const dashboardStamp = [readJson(join(APP_DIR, "package.json")).version ?? "", gitHead(), nextPackage.version ?? ""].join("|");
  const buildIdPath = join(APP_DIR, "apps/dashboard/.next/BUILD_ID");
  if (stamps.dashboardStamp === dashboardStamp && existsSync(buildIdPath)) return { ok: true, prod: true };

  say(`  ${C.bold}Optimising the app for speed (about a minute, once per update)...${C.reset}`);
  if (!run("Building the app...", NPM_COMMAND, ["run", "build", "--workspace", "@inbox-os/dashboard"])) {
    say(`  ${C.yellow}The optimised build did not complete. Starting in compatibility mode.${C.reset}`);
    return { ok: true, prod: false };
  }
  next.dashboardStamp = dashboardStamp;
  saveStamps(next);
  return { ok: true, prod: true };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function probe(url, validate = () => true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status <= 0 || response.status >= 500) return false;
    return await validate(response);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(750);
  }
  say(`${label} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`);
  return false;
}

function runnerReady() {
  return probe(RUNNER_HEALTH_URL, async (response) => {
    const body = await response.json().catch(() => null);
    return body?.application === "relationship-inbox-os";
  });
}

function dashboardReady() {
  return probe(DASHBOARD_URL);
}

async function startApp(prod) {
  const children = [];
  let shuttingDown = false;
  const state = {
    version: 1,
    appDir: APP_DIR,
    dataDir: DATA_DIR,
    parentPid: process.pid,
    startedAt: new Date().toISOString(),
    children: []
  };

  const persistState = () => {
    state.children = children.map(({ name, child }) => ({ name, pid: child.pid }));
    writeRuntimeState(RUNTIME_STATE_PATH, state);
  };

  const shutdown = async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopChildGroups(children.map(({ name, child }) => ({ name, pid: child.pid })));
    removeRuntimeState(RUNTIME_STATE_PATH);
    process.exit(code);
  };

  const launch = (name, command, commandArgs) => {
    const child = spawn(command, commandArgs, {
      cwd: APP_DIR,
      detached: process.platform !== "win32",
      stdio: "inherit"
    });
    children.push({ name, child });
    persistState();
    child.on("error", (error) => {
      say(`Could not start the ${name}: ${error.message}`);
      void shutdown(1);
    });
    child.on("exit", (code, signalName) => {
      if (shuttingDown) return;
      say(`${name} stopped unexpectedly (code=${code ?? ""} signal=${signalName ?? ""}).`);
      void shutdown(code || 1);
    });
    return child;
  };

  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signalName, () => void shutdown(0));
  }
  process.on("uncaughtException", (error) => {
    say(`Launcher error: ${error.message}`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (error) => {
    say(`Launcher error: ${error instanceof Error ? error.message : String(error)}`);
    void shutdown(1);
  });

  if (prod) {
    launch("runner", process.execPath, [join(APP_DIR, "apps", "runner", "dist", "index.js")]);
  } else {
    launch("runner", NPM_COMMAND, ["run", "dev", "--workspace", "@inbox-os/runner"]);
  }
  if (!(await waitFor("The local service", runnerReady, 120_000))) {
    await shutdown(1);
    return;
  }

  if (prod) {
    launch("dashboard", process.execPath, packagedDashboardArgs(APP_DIR, DASHBOARD_PORT));
  } else {
    launch("dashboard", NPM_COMMAND, ["run", "dev", "--workspace", "@inbox-os/dashboard"]);
  }
  if (!(await waitFor("The app window", dashboardReady, 180_000))) {
    await shutdown(1);
    return;
  }
  say(`  ${C.green}${APP_NAME} is ready.${C.reset}`);
}

async function main() {
  // Preparing binds no ports and starts no processes, so the installer can
  // run --prepare-only while an older install is still open.
  if (!PREPARE_ONLY) {
    const recovery = await recoverPriorRuntime({
      statePath: RUNTIME_STATE_PATH,
      appDir: APP_DIR,
      reclaim: process.env.RIOS_RECLAIM_EXISTING === "1"
    });
    if (recovery.status === "already_running") {
      say(`${APP_NAME} is already running.`);
      process.exit(2);
    }
    if (recovery.status === "recovered") {
      say(`  Recovered a previous partial start (${recovery.recovered.join(", ")}).`);
    }

    for (const [label, port] of [["dashboard", DASHBOARD_PORT], ["local service", RUNNER_PORT]]) {
      const conflict = portConflict(port, APP_DIR);
      if (!conflict) continue;
      if (process.env.RIOS_RECLAIM_PORT_CONFLICTS === "1") {
        const reclaimed = await reclaimPortConflict(conflict);
        if (reclaimed.status === "recovered") {
          say(`  Stopped an older ${APP_NAME} process that was using port ${port}.`);
          continue;
        }
      }
      writeStartupConflict(label, conflict);
      say(`Could not start because port ${port} for the ${label} is already in use.`);
      say(
        conflict.owners.every((owner) => owner.toviOwned)
          ? `Choose Stop old ${APP_NAME} and retry in the recovery dialog.`
          : `Close the other application using that port, then choose Retry in ${APP_NAME}.`
      );
      process.exit(1);
    }
  }

  const result = prepare();
  if (!result.ok) {
    say(`${C.yellow}Could not prepare the app. Reinstall it, then try again. The desktop log has details.${C.reset}`);
    process.exit(1);
  }
  if (PREPARE_ONLY) {
    say(`  ${C.green}The app is ready to start.${C.reset}`);
    process.exit(0);
  }
  await startApp(result.prod);
}

void main();
