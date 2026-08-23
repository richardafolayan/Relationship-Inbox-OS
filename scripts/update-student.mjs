#!/usr/bin/env node
//
// Tovi — student updater.
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
//   --backup-root <dir> where staging + backups live (default: the app folder's
//                       parent). Packaged installs pass a dir OUTSIDE the .app
//                       bundle so old copies never bloat the signed bundle.
//   --resign <bundle>   after a successful apply, ad-hoc re-sign this mac .app
//                       bundle (packaged installs; restores the codesign seal
//                       the in-place swap breaks, same as a rebuild would)
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
import { resolveAppName } from "./lib/branding.mjs";

const APP_NAME = resolveAppName();

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
    else if (a === "--backup-root") out.backupRoot = next();
    else if (a === "--resign") out.resign = next();
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
// Staging + backups default next to the install; a packaged app passes a dir
// outside its .app bundle. Must be on the same volume as APP_DIR (the swap is
// a rename).
const BACKUP_ROOT = args.backupRoot ? resolve(process.cwd(), args.backupRoot) : dirname(APP_DIR);
const RESIGN_BUNDLE = args.resign ? resolve(process.cwd(), args.resign) : "";

const C = process.stdout.isTTY
  ? { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", reset: "\x1b[0m" }
  : { b: "", d: "", g: "", y: "", r: "", reset: "" };

function say(m) { process.stdout.write(m + "\n"); }
function die(m) { process.stderr.write(`\n  ${C.r}✗ ${m}${C.reset}\n\n`); process.exit(1); }

function macAppBundleDir() {
  return process.env.RIOS_APP_BUNDLE_DIR || join(process.env.HOME || "", "Applications");
}

function macAppBundlePath() {
  const out = macAppBundleDir();
  return out ? join(out, `${APP_NAME}.app`) : "";
}

function refreshMacAppBundle() {
  const script = join(APP_DIR, "scripts", "create-macos-app-bundle.mjs");
  if (!existsSync(script)) return;
  const out = macAppBundleDir();
  const nodeDir = process.env.RIOS_NODE_DIR || join(process.env.HOME || "", ".rios-node");
  if (!out) return;
  if (existsSync(macAppBundlePath())) return;
  try {
    execFileSync(process.execPath, [script, "--app-dir", APP_DIR, "--out", out, "--node-dir", nodeDir], {
      cwd: APP_DIR,
      stdio: "ignore"
    });
    say(`  Created the ${APP_NAME} Mac app.`);
  } catch {
    say(`  ${C.y}Could not refresh the Mac app. The Terminal start command still works.${C.reset}`);
  }
}

function currentVersion(dir) {
  for (const file of ["release.json", "package.json"]) {
    try {
      const v = JSON.parse(readFileSync(join(dir, file), "utf8")).version;
      if (v) return v;
    } catch { /* try next */ }
  }
  return "0.0.0";
}

function currentChannel(dir) {
  try {
    const channel = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")).channel;
    if (typeof channel === "string" && channel.trim()) return channel.trim();
  } catch { /* no release.json = dev checkout or very old install */ }
  return "";
}

// A dev install must never apply a student feed (or vice versa): the versions
// are not comparable across channels and the wrong code would land. Older
// manifests carry no channel, so only enforce when BOTH sides declare one.
function enforceChannelMatch(installedChannel, manifest) {
  const feedChannel = typeof manifest.channel === "string" ? manifest.channel.trim() : "";
  if (!installedChannel || !feedChannel || installedChannel === feedChannel) return;
  die(
    `This install is on the "${installedChannel}" channel but the update feed serves "${feedChannel}".\n` +
    `  Check RIOS_UPDATE_FEED_URL (or the baked release.json feed) before updating.`
  );
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
  say(`\n  ${C.b}${APP_NAME} — update check${C.reset}`);
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

function enforceMinimumInstallerVersion(current, manifest) {
  if (compareVersions(current, manifest.minimumInstallerVersion) >= 0) return;
  die(
    `This update requires installer ${manifest.minimumInstallerVersion} or newer, but this install is ${current}.\n` +
    `  Ask Richard for the latest installer before applying ${manifest.version}.`
  );
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
  // Pilot release zips never contain .git (the build forbids it), so a .git
  // here means a development checkout. Swapping that for a zip would move the
  // repo (.git, worktrees, branches) into the backup folder — refuse and
  // point at git instead. Applies to --dry-run too: the plan would never run.
  if (existsSync(join(APP_DIR, ".git"))) {
    die(`This looks like a development checkout (it has .git): ${APP_DIR}\n` +
      `  The zip updater would replace the working copy, so it refuses to run here.\n` +
      `  Update a checkout with git instead (e.g. git pull).`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingRoot = join(BACKUP_ROOT, `.rios-update-${stamp}`);
  const appNew = join(stagingRoot, "relationship-inbox-os");
  const backupDir = join(BACKUP_ROOT, `.rios-backup-${stamp}`);
  const zipPath = join(stagingRoot, "download.zip");

  if (args.dryRun) {
    say(`\n  ${C.b}[dry run] would update ${current} → ${manifest.version}${C.reset}`);
    say(`  1. download ${manifest.zipUrl}`);
    say(`  2. verify sha256 ${manifest.sha256.slice(0, 12)}…`);
    say(`  3. back up ${APP_DIR} → ${backupDir}`);
    say(`  4. preserve into the new copy: ${PRESERVE.join(", ")}`);
    say(`  5. swap in the new app code`);
    say(`  6. ${args.noDeps ? "skip deps (--no-deps)" : "npm install --include=dev, then db setup"}`);
    if (RESIGN_BUNDLE) say(`  6b. ad-hoc re-sign ${RESIGN_BUNDLE}`);
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
    // Packaged installs (RESIGN_BUNDLE set) run these WITHOUT the packaged
    // flag: packaged start-app refuses to build anything ("reinstall from the
    // DMG"), but the freshly swapped-in zip is source-only, so the core /
    // runner / dashboard artifacts must be rebuilt right here.
    const childEnv = { ...process.env };
    if (RESIGN_BUNDLE) delete childEnv.RIOS_PACKAGED_APP;
    const opts = { cwd: APP_DIR, stdio: "inherit", env: childEnv };
    try {
      say(`  Installing dependencies (a few minutes)…`);
      execFileSync("npm", ["install", "--include=dev"], opts);
      execFileSync("npm", ["run", "db:generate"], opts);
      execFileSync("node", ["scripts/start-app.mjs", "--database-only"], opts);
      if (RESIGN_BUNDLE) {
        // Fatal for packaged installs: without these artifacts the packaged
        // launcher cannot boot (it never builds), so a failed build must roll
        // back rather than leave a dead app.
        say(`  Building the app (a few minutes)…`);
        execFileSync("node", ["scripts/start-app.mjs", "--prepare-only"], opts);
        const missing = [
          "packages/core/dist/index.js",
          "apps/runner/dist/index.js",
          "apps/dashboard/.next/BUILD_ID"
        ].filter((p) => !existsSync(join(APP_DIR, p)));
        if (missing.length) {
          throw new Error(`packaged build artifacts missing after prepare: ${missing.join(", ")}`);
        }
      }
    } catch (err) {
      say(`  ${C.y}Dependency step failed — rolling back.${C.reset}`);
      rollback(APP_DIR, backupDir);
      die(`Update rolled back to ${current}. Your data is safe.\n  ${err.message}`);
    }
    if (!RESIGN_BUNDLE) {
      // Pre-build the optimised dashboard so the relaunch is instant.
      // Non-fatal: the launcher rebuilds (or falls back to dev mode) itself.
      try {
        say(`  Optimising the app for speed (about a minute)…`);
        execFileSync("node", ["scripts/start-app.mjs", "--prepare-only"], opts);
      } catch {
        say(`  ${C.y}Pre-build didn't finish — the next launch will do it instead.${C.reset}`);
      }
    }
  }

  if (RESIGN_BUNDLE) {
    // The in-place swap broke the bundle's codesign seal; an ad-hoc re-sign
    // restores it, exactly like rebuilding the DMG would. Best-effort: the
    // packaged app is not quarantined, so a failed re-sign still launches.
    try {
      say(`  Re-signing ${RESIGN_BUNDLE}…`);
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", RESIGN_BUNDLE], { stdio: "ignore" });
    } catch {
      say(`  ${C.y}Could not re-sign the app bundle. It should still open normally.${C.reset}`);
    }
  } else {
    refreshMacAppBundle();
  }
  pruneBackups(BACKUP_ROOT, Math.max(0, args.keepBackups));
  say(`\n  ${C.g}${C.b}Updated to ${manifest.version}.${C.reset}`);
  if (RESIGN_BUNDLE) {
    say(`  Start the app again:  ${C.b}open "${RESIGN_BUNDLE}"${C.reset}`);
  } else {
    const bundlePath = macAppBundlePath();
    if (bundlePath) say(`  Start the app again:  ${C.b}open "${bundlePath}"${C.reset}`);
    say(`  Terminal fallback:  ${C.b}npm run start:student${C.reset}`);
  }
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
  enforceChannelMatch(currentChannel(APP_DIR), manifest);
  // The minimum-installer gate only applies when we're about to CHANGE the
  // install. --check-only (used by the in-app "App updates" card) must always
  // report, never die — otherwise every install older than the release's floor
  // would see a hard error instead of "update available" and in-app updates
  // would self-block.
  const available = report(current, manifest);

  if (args.apply) {
    if (!available && !args.dryRun) {
      say(`  Nothing to do — already on the latest version.\n`);
      return;
    }
    enforceMinimumInstallerVersion(current, manifest);
    await applyUpdate(current, manifest);
  } else if (args.dryRun) {
    enforceMinimumInstallerVersion(current, manifest);
    await applyUpdate(current, manifest);
  }
}

main().catch((err) => die(err?.message || String(err)));
