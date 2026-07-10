#!/usr/bin/env node
//
// Relationship Inbox OS - fast app launcher.
//
// Prepares the app once (Prisma client, database schema, core build, and an
// optimised production build of the dashboard), skipping every step whose
// inputs have not changed since the last launch, then starts the runner and
// the dashboard together. The dashboard runs as a production build
// (`next start`) instead of the dev compiler, so pages are precompiled and
// open instantly; previously every launch ran `next dev`, which compiles
// each page the first time it is visited.
//
// If the production build fails for any reason the launcher falls back to
// dev mode so the app always starts.
//
// Flags:
//   --prepare-only   run the prepare steps and exit (used by the installer
//                    so the first real launch is already fast)
//   --dev            skip the production build and start in dev mode
//
// Env:
//   RIOS_DEV=1       same as --dev
//   RIOS_REBUILD=1   ignore the saved stamps and run every prepare step
//
// Developers: `npm run dev` is unchanged and remains the right way to work
// on the app (watch mode, hot reload). This launcher is the pilot path; it
// stamps builds by app version + git commit, so uncommitted local edits are
// NOT picked up here - use `npm run dev` for that.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMPS_PATH = join(APP_DIR, "data", "app-prepare-stamps.json");
const args = new Set(process.argv.slice(2));
const PREPARE_ONLY = args.has("--prepare-only");
const FORCE_DEV = args.has("--dev") || process.env.RIOS_DEV === "1";
const FORCE_REBUILD = process.env.RIOS_REBUILD === "1";

const C = process.stdout.isTTY
  ? { bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", reset: "\x1b[0m" }
  : { bold: "", dim: "", green: "", yellow: "", reset: "" };

function say(msg) {
  process.stdout.write(msg + "\n");
}

// --- stamps -----------------------------------------------------------------

function loadStamps() {
  try {
    return JSON.parse(readFileSync(STAMPS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveStamps(stamps) {
  try {
    mkdirSync(dirname(STAMPS_PATH), { recursive: true });
    writeFileSync(STAMPS_PATH, JSON.stringify(stamps, null, 2) + "\n");
  } catch {
    // Stamps are an optimisation; failing to save just means the next
    // launch re-runs the prepare steps.
  }
}

/** Stable content hash over a list of files/directories (recursive). */
function hashPaths(paths) {
  const files = [];
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p).sort()) {
        if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
        walk(join(p, entry));
      }
    } else {
      files.push(p);
    }
  };
  for (const p of paths) walk(p);
  const h = createHash("sha256");
  for (const f of files.sort()) {
    h.update(f.slice(APP_DIR.length));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

function gitHead() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: APP_DIR, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function canResolve(specifier) {
  try {
    createRequire(join(APP_DIR, "package.json")).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

// --- steps ------------------------------------------------------------------

function run(label, cmd, cmdArgs, opts = {}) {
  say(`  ${C.dim}${label}${C.reset}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: APP_DIR, stdio: "inherit", ...opts });
  return r.status === 0;
}

function prepare() {
  const stamps = FORCE_REBUILD ? {} : loadStamps();
  const next = { ...stamps };

  const schemaHash = hashPaths([join(APP_DIR, "packages/core/prisma/schema.prisma")]);
  const schemaChanged = stamps.schemaHash !== schemaHash;

  // 1. Prisma client - regenerate when the schema changed or the generated
  //    client is missing entirely (fresh install).
  if (schemaChanged || !canResolve("@prisma/client")) {
    if (!run("Updating the database client...", "npm", ["run", "db:generate"])) {
      return { ok: false };
    }
  }

  // 2. Database schema - sync when the schema changed or the database file
  //    does not exist yet. Additive changes (new tables/indexes) apply
  //    in place without touching data.
  if (schemaChanged || !existsSync(join(APP_DIR, "data/inbox-os.sqlite"))) {
    if (!run("Updating the database...", "npm", ["run", "db:push"])) {
      return { ok: false };
    }
  }
  next.schemaHash = schemaHash;
  saveStamps(next);

  // 3. Core package build - the runner and dashboard both import it.
  const coreHash = hashPaths([
    join(APP_DIR, "packages/core/src"),
    join(APP_DIR, "packages/core/package.json"),
    join(APP_DIR, "packages/core/tsconfig.json")
  ]);
  if (stamps.coreHash !== coreHash || !existsSync(join(APP_DIR, "packages/core/dist/index.js"))) {
    if (!run("Building shared components...", "npm", ["run", "build", "--workspace", "@inbox-os/core"])) {
      return { ok: false };
    }
    next.coreHash = coreHash;
    saveStamps(next);
  }

  // 4. Dashboard production build - once per app version (updates bump the
  //    version; repo checkouts also stamp the git commit). This is the step
  //    that makes pages open instantly at runtime.
  if (FORCE_DEV) {
    return { ok: true, prod: false };
  }
  const nextPkg = readJson(join(APP_DIR, "node_modules/next/package.json"));
  const dashStamp = [
    readJson(join(APP_DIR, "package.json")).version ?? "",
    gitHead(),
    nextPkg.version ?? ""
  ].join("|");
  const buildIdPath = join(APP_DIR, "apps/dashboard/.next/BUILD_ID");
  if (stamps.dashStamp === dashStamp && existsSync(buildIdPath)) {
    return { ok: true, prod: true };
  }
  say(`  ${C.bold}Optimising the app for speed (about a minute, once per update)...${C.reset}`);
  if (!run("Building the app...", "npm", ["run", "build", "--workspace", "@inbox-os/dashboard"])) {
    say(`  ${C.yellow}The optimised build did not complete; starting in compatibility mode.${C.reset}`);
    return { ok: true, prod: false };
  }
  next.dashStamp = dashStamp;
  saveStamps(next);
  return { ok: true, prod: true };
}

// --- start ------------------------------------------------------------------

function startApp(prod) {
  const children = [];
  let shuttingDown = false;

  const launch = (name, scriptArgs) => {
    const child = spawn("npm", scriptArgs, { cwd: APP_DIR, stdio: "inherit" });
    child.on("error", (err) => {
      say(`Could not start the ${name}: ${err.message}`);
      shutdown(1);
    });
    child.on("exit", (code) => {
      if (!shuttingDown) shutdown(code ?? 0);
    });
    children.push(child);
  };

  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    // Give children a moment to close cleanly before exiting.
    setTimeout(() => process.exit(code), 500).unref();
  };

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => shutdown(0));
  }

  launch("runner", ["run", "dev", "--workspace", "@inbox-os/runner"]);
  launch(
    "dashboard",
    prod
      ? ["run", "start", "--workspace", "@inbox-os/dashboard"]
      : ["run", "dev", "--workspace", "@inbox-os/dashboard"]
  );
}

// --- main -------------------------------------------------------------------

const result = prepare();
if (!result.ok) {
  say(`${C.yellow}Could not prepare the app. Try: cd "${APP_DIR}" && npm run doctor${C.reset}`);
  process.exit(1);
}
if (PREPARE_ONLY) {
  say(`  ${C.green}The app is ready to start.${C.reset}`);
  process.exit(0);
}
startApp(result.prod);
