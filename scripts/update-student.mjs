#!/usr/bin/env node
//
// Relationship Inbox OS — student updater.
//
// Checks whether a newer pilot build exists and, on request, applies it while
// preserving the pilot's personal data. Safe by design: it verifies a sha256
// before touching anything, backs up the current app, and rolls back if any
// step fails.
//
//   node scripts/update-student.mjs --check-only
//   node scripts/update-student.mjs --apply
//
// The update feed (the latest.json URL) comes from RIOS_UPDATE_FEED_URL or
// --url. Nothing is hard-coded; Richard sets the Dropbox raw/dl=1 link.
//
// What is preserved across an update (never replaced):
//   .env, .env.bak, data/ (the SQLite database, browser profiles, screenshots),
//   logs/, and any *.local config. Only app code and dependencies are replaced.
//
// Safe relaunch architecture (see docs/pilot/releasing-student-builds.md):
//   The running app should NOT replace its own code mid-flight. The intended
//   path (wired up in a later PR) is: the dashboard writes a pending-update
//   intent, and the start wrapper runs this updater BEFORE booting the app on
//   the next launch. This script is that engine and can be run directly too.
//
// Flags:
//   --check-only        report current/latest and whether an update exists (default)
//   --apply             download + apply the update (with backup + rollback)
//   --dry-run           print exactly what --apply would do; change nothing
//   --url <latest-url>  the latest.json URL (else RIOS_UPDATE_FEED_URL)
//   --dir <app-dir>     the install to update (default: this app folder)
//   --no-deps           skip npm install + db setup after swapping (advanced/testing)
//   --keep-backups <n>  how many old backups to keep (default 2)
//   --json              machine-readable output for --check-only

import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions, isAllowedRemoteUpdateUrl, isNewer, sha256Buffer, validateLatestJson
} from "./lib/release-manifest.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_DIR = resolve(SCRIPT_DIR, "..");

// Items in the current install that must survive an update.
const PRESERVE = [".env", ".env.bak", "data", "logs"];

function parseArgs(argv) {
  const out = { keepBackups: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--check-only") out.checkOnly = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--url") out.url = next();
    else if (a === "--dir") out.dir = next();
    else if (a === "--no-deps") out.noDeps = true;
    else if (a === "--keep-backups") out.keepBackups = Number(next());
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
  process.exit(0);
}

const APP_DIR = resolve(args.dir ? resolve(process.cwd(), args.dir) : DEFAULT_APP_DIR);
const FEED_URL = args.url || process.env.RIOS_UPDATE_FEED_URL || "";

const C = process.stdout.isTTY
  ? { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", reset: "\x1b[0m" }
  : { b: "", d: "", g: "", y: "", r: "", reset: "" };

function say(m) { process.stdout.write(m + "\n"); }
function die(m) { process.stderr.write(`\n  ${C.r}✗ ${m}${C.reset}\n\n`); process.exit(1); }

function currentVersion(dir) {
  for (const file of ["release.json", "package.json"]) {
    try {
      const v = JSON.parse(readFileSync(join(dir, file), "utf8")).version;
      if (v) return v;
    } catch { /* try next */ }
  }
  return "0.0.0";
}

function looksLikeHtml(buf) {
  const head = buf.slice(0, 200).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

async function fetchBuffer(url) {
  // Updates auto-install (post-swap npm scripts run), and the manifest's sha256
  // is self-referential — it only guards against corruption, NOT tampering. So
  // require https for BOTH the feed and the zip: over http (or a downgraded
  // redirect) a network MITM could swap in an attacker zip + matching sha256.
  // (Defence-in-depth only; a signed manifest is the real fix — see #553.)
  if (!isAllowedRemoteUpdateUrl(url)) {
    throw new Error(`refusing to fetch an update over a non-https URL (must be https): ${url}`);
  }
  // Global fetch follows redirects by default, which Dropbox dl=1/raw=1 links need.
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch failed (${res.status} ${res.statusText}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadManifest(url) {
  if (!url) {
    die("No update feed set. Pass --url <latest.json link> or set RIOS_UPDATE_FEED_URL.\n" +
      "  (Ask Richard for the latest.json link; on Dropbox it must end in raw=1 or dl=1.)");
  }
  let buf;
  try { buf = await fetchBuffer(url); }
  catch (err) { die(`Could not reach the update feed.\n  ${err.message}`); }
  if (looksLikeHtml(buf)) {
    die("The update feed returned a web page, not JSON.\n" +
      "  A Dropbox link needs raw=1 or dl=1 (not dl=0). Check the latest.json link.");
  }
  let manifest;
  try { manifest = JSON.parse(buf.toString("utf8")); }
  catch { die("The update feed wasn't valid JSON. Check the latest.json link."); }
  const { ok, errors } = validateLatestJson(manifest);
  if (!ok) die(`The update info (latest.json) is malformed, so I won't act on it:\n  - ${errors.join("\n  - ")}`);
  return manifest;
}

function report(current, manifest) {
  const available = isNewer(manifest.version, current);
  if (args.json) {
    say(JSON.stringify({
      currentVersion: current, latestVersion: manifest.version,
      updateAvailable: available, releaseNotes: manifest.releaseNotes
    }, null, 2));
    return available;
  }
  say(`\n  ${C.b}Relationship Inbox OS — update check${C.reset}`);
  say(`  Installed:  ${current}`);
  say(`  Latest:     ${manifest.version}`);
  if (available) {
    say(`\n  ${C.g}An update is available.${C.reset}`);
    if (manifest.releaseNotes?.length) {
      say(`  What's new:`);
      for (const n of manifest.releaseNotes) say(`    • ${n}`);
    }
    say(`\n  Apply it with:  ${C.b}node scripts/update-student.mjs --apply${C.reset}\n`);
  } else {
    say(`\n  ${C.g}You're up to date.${C.reset}\n`);
  }
  return available;
}

function stopAppProcesses(dir) {
  // Best-effort: stop a dev server still serving THIS install so files aren't
  // held open during the swap. Only kills processes whose cwd is under `dir`.
  const ports = [process.env.DASHBOARD_PORT || "3100", process.env.RUNNER_PORT || "4001"];
  for (const port of ports) {
    let pids = "";
    try { pids = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" }); } catch { continue; }
    for (const pid of pids.split("\n").map((p) => p.trim()).filter(Boolean)) {
      let cwd = "";
      try {
        cwd = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" })
          .split("\n").find((l) => l.startsWith("n"))?.slice(1) || "";
      } catch { /* ignore */ }
      if (cwd === dir || cwd.startsWith(dir + "/")) {
        try { process.kill(Number(pid)); say(`  Stopped the running app (pid ${pid}).`); } catch { /* ignore */ }
      }
    }
  }
}

function pruneBackups(parent, keep) {
  const backups = readdirSync(parent)
    .filter((n) => n.startsWith(".rios-backup-"))
    .sort();
  while (backups.length > keep) {
    const old = backups.shift();
    try { rmSync(join(parent, old), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function applyUpdate(current, manifest) {
  const parent = dirname(APP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingRoot = join(parent, `.rios-update-${stamp}`);
  const appNew = join(stagingRoot, "relationship-inbox-os");
  const backupDir = join(parent, `.rios-backup-${stamp}`);
  const zipPath = join(stagingRoot, "download.zip");

  if (args.dryRun) {
    say(`\n  ${C.b}[dry run] would update ${current} → ${manifest.version}${C.reset}`);
    say(`  1. download ${manifest.zipUrl}`);
    say(`  2. verify sha256 ${manifest.sha256.slice(0, 12)}…`);
    say(`  3. back up ${APP_DIR} → ${backupDir}`);
    say(`  4. preserve into the new copy: ${PRESERVE.join(", ")}`);
    say(`  5. swap in the new app code`);
    say(`  6. ${args.noDeps ? "skip deps (--no-deps)" : "npm install --include=dev, then db setup"}`);
    say(`  7. roll back automatically if any step fails\n`);
    return;
  }

  say(`\n  Updating ${current} → ${manifest.version}…`);
  execFileSync("mkdir", ["-p", stagingRoot]);

  // 1. Download.
  say(`  Downloading…`);
  let zipBuf;
  try { zipBuf = await fetchBuffer(manifest.zipUrl); }
  catch (err) { cleanup(stagingRoot); die(`Download failed.\n  ${err.message}`); }
  if (looksLikeHtml(zipBuf)) {
    cleanup(stagingRoot);
    die("The download was a web page, not a zip. The zip link needs dl=1 (not dl=0).");
  }
  writeFileSync(zipPath, zipBuf);

  // 2. Verify checksum BEFORE touching the install.
  const got = sha256Buffer(zipBuf);
  if (got !== manifest.sha256.toLowerCase()) {
    cleanup(stagingRoot);
    die(`Checksum mismatch — refusing to install a corrupted or wrong file.\n` +
      `  expected ${manifest.sha256}\n  got      ${got}`);
  }
  say(`  Checksum verified.`);

  // 3. Extract.
  try { execFileSync("unzip", ["-q", zipPath, "-d", stagingRoot]); }
  catch (err) { cleanup(stagingRoot); die(`Could not unzip the update.\n  ${err.message}`); }
  if (!existsSync(join(appNew, "package.json"))) {
    cleanup(stagingRoot);
    die("The downloaded update didn't contain the app. Aborted with nothing changed.");
  }

  // 4. Stop the app FIRST — before copying data/. The preserved data/ dir holds
  //    the live SQLite DB (main file + -wal/-shm). A non-atomic cpSync while the
  //    runner is mid-write/checkpoint can produce a copy whose WAL is
  //    inconsistent with the main file, and the pilot then boots on that
  //    torn/corrupt DB (rollback only fires on a deps-step throw, not on a
  //    silently-corrupt-but-openable DB). Stopping first closes the DB handles.
  stopAppProcesses(APP_DIR);

  // 5. Preserve personal data into the new copy.
  for (const item of PRESERVE) {
    const from = join(APP_DIR, item);
    if (existsSync(from)) {
      rmSync(join(appNew, item), { recursive: true, force: true });
      cpSync(from, join(appNew, item), { recursive: true });
    }
  }

  // 6. Swap (rename within the same parent = atomic-ish).
  try {
    renameSync(APP_DIR, backupDir);
  } catch (err) {
    cleanup(stagingRoot);
    die(`Could not back up the current app (nothing changed).\n  ${err.message}`);
  }
  try {
    renameSync(appNew, APP_DIR);
  } catch (err) {
    // Roll back the backup immediately.
    try { renameSync(backupDir, APP_DIR); } catch { /* leave backup for manual restore */ }
    cleanup(stagingRoot);
    die(`Could not put the new app in place — rolled back.\n  ${err.message}`);
  }
  cleanup(stagingRoot);
  say(`  New app code is in place. Backup: ${backupDir}`);

  // 6. Dependencies + database. On failure, roll back to the backup.
  if (!args.noDeps) {
    try {
      say(`  Installing dependencies (a few minutes)…`);
      execFileSync("npm", ["install", "--include=dev"], { cwd: APP_DIR, stdio: "inherit" });
      execFileSync("npm", ["run", "db:generate"], { cwd: APP_DIR, stdio: "inherit" });
      execFileSync("npm", ["run", "db:push"], { cwd: APP_DIR, stdio: "inherit" });
    } catch (err) {
      say(`  ${C.y}Dependency step failed — rolling back.${C.reset}`);
      rollback(APP_DIR, backupDir);
      die(`Update rolled back to ${current}. Your data is safe.\n  ${err.message}`);
    }
  }

  pruneBackups(parent, Math.max(0, args.keepBackups));
  say(`\n  ${C.g}${C.b}Updated to ${manifest.version}.${C.reset}`);
  say(`  Start the app again:  ${C.b}npm run dev${C.reset}  (or node scripts/start-student.mjs)`);
  say(`  Previous version kept at: ${backupDir}\n`);
}

function rollback(appDir, backupDir) {
  const failedDir = `${appDir}.failed-update`;
  try {
    if (existsSync(appDir)) renameSync(appDir, failedDir);
    renameSync(backupDir, appDir);
  } catch {
    say(`  ${C.r}Automatic rollback hit a snag.${C.reset} Your previous app is at ${backupDir}.`);
    return;
  }
  // Restore succeeded — drop the broken copy.
  try { if (existsSync(failedDir)) rmSync(failedDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main() {
  if (!existsSync(join(APP_DIR, "package.json"))) {
    die(`That doesn't look like the app folder: ${APP_DIR}`);
  }
  const current = currentVersion(APP_DIR);
  const manifest = await loadManifest(FEED_URL);
  const available = report(current, manifest);

  if (args.apply) {
    if (!available && !args.dryRun) {
      say(`  Nothing to do — already on the latest version.\n`);
      return;
    }
    await applyUpdate(current, manifest);
  } else if (args.dryRun) {
    await applyUpdate(current, manifest);
  }
}

main().catch((err) => die(err?.message || String(err)));
