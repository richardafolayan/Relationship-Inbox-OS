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
//   --resign <bundle>   unsupported legacy flag; signed bundles must use the
//                       native whole-app updater
//   --no-deps           skip npm install + db setup after swapping (advanced/testing)
//   --keep-backups <n>  how many old backups to keep (default 2)
//   --json              machine-readable output for --check-only

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync, existsSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  compareVersions, isAllowedRemoteUpdateUrl, isNewer, sha256Buffer, validateLatestJson
} from "./lib/release-manifest.mjs";
import {
  acquireInstallOperation,
  acquireInstallPreparation,
  acquireInstallMaintenance,
  releaseInstallOperation,
  releaseInstallPreparation,
  releaseInstallMaintenance
} from "./lib/install-maintenance.mjs";
import {
  beginInstallTransaction,
  checkpointInstallTransaction,
  clearInstallTransaction,
  durableInstallRename,
  installScopeKey,
  readInstallTransaction,
  recoverInstallTransaction,
  rollbackInstallTransaction
} from "./lib/install-transaction.mjs";
import { resolveAppName } from "./lib/branding.mjs";
import { updateControlAncestorPids } from "./lib/update-ancestors.mjs";
import { stopExistingInstallRuntime } from "./stop-existing-install.mjs";

const APP_NAME = resolveAppName();
const PACKAGED_STORAGE_DIR_NAME = "Relationship Inbox OS";

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

const requestedAppDir = resolve(args.dir ? resolve(process.cwd(), args.dir) : DEFAULT_APP_DIR);
const APP_DIR = (() => {
  try {
    return realpathSync.native(requestedAppDir);
  } catch {
    return requestedAppDir;
  }
})();
const FEED_URL = args.url || process.env.RIOS_UPDATE_FEED_URL || "";
const RESIGN_BUNDLE = args.resign ? (() => {
  const requested = resolve(process.cwd(), args.resign);
  try {
    return realpathSync.native(requested);
  } catch {
    return requested;
  }
})() : "";
const PACKAGED_CONFIG_DIR = RESIGN_BUNDLE
  ? resolve(
      process.env.RIOS_CONFIG_DIR?.trim() ||
      join(userInfo().homedir, "Library", "Application Support", PACKAGED_STORAGE_DIR_NAME)
    )
  : "";
// Staging + backups default next to the install; a packaged app passes a dir
// outside its .app bundle. Must be on the same volume as APP_DIR (the swap is
// a rename).
const BACKUP_ROOT = args.backupRoot
  ? resolve(process.cwd(), args.backupRoot)
  : RESIGN_BUNDLE
    ? join(PACKAGED_CONFIG_DIR, "updates")
    : dirname(APP_DIR);

const PRESERVED_UPDATE_PIDS = updateControlAncestorPids();

const C = process.stdout.isTTY
  ? { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", reset: "\x1b[0m" }
  : { b: "", d: "", g: "", y: "", r: "", reset: "" };

function say(m) { process.stdout.write(m + "\n"); }
function die(m, code = 1) { process.stderr.write(`\n  ${C.r}✗ ${m}${C.reset}\n\n`); process.exit(code); }

function pathIsWithin(root, target) {
  const canonicalNearestExisting = (value) => {
    const absolute = resolve(value);
    const missing = [];
    let current = absolute;
    while (true) {
      try {
        return join(realpathSync.native(current), ...missing);
      } catch {
        const parent = dirname(current);
        if (parent === current) return absolute;
        missing.unshift(basename(current));
        current = parent;
      }
    }
  };
  const path = relative(canonicalNearestExisting(root), canonicalNearestExisting(target));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function configurePackagedPaths() {
  if (!RESIGN_BUNDLE) return;
  const expectedAppDir = join(RESIGN_BUNDLE, "Contents", "Resources", "app");
  if (APP_DIR !== expectedAppDir) {
    die(`The --resign bundle does not contain this app directory. Expected ${expectedAppDir}, got ${APP_DIR}.`);
  }
  const dataDir = resolve(process.env.RIOS_DATA_DIR?.trim() || join(PACKAGED_CONFIG_DIR, "data"));
  const stateDir = resolve(process.env.RIOS_STATE_DIR?.trim() || join(PACKAGED_CONFIG_DIR, "state"));
  for (const [label, path] of [
    ["configuration", PACKAGED_CONFIG_DIR],
    ["data", dataDir],
    ["state", stateDir],
    ["update backup", BACKUP_ROOT]
  ]) {
    if (pathIsWithin(RESIGN_BUNDLE, path)) {
      die(`The packaged ${label} path must be outside the signed app bundle: ${path}`);
    }
  }
  process.env.RIOS_CONFIG_DIR = PACKAGED_CONFIG_DIR;
  process.env.RIOS_DATA_DIR = dataDir;
  process.env.RIOS_STATE_DIR = stateDir;
  process.env.DATABASE_URL = `file:${join(dataDir, "inbox-os.sqlite")}`;
}

let activeOperationToken = "";
let activePreparationToken = "";
let activeTransactionId = "";
function clearActiveTransaction() {
  if (!activeTransactionId) return;
  clearInstallTransaction(APP_DIR, activeTransactionId);
  activeTransactionId = "";
}
function releaseUpdateOperation() {
  if (!activeOperationToken) return;
  releaseInstallOperation(APP_DIR, activeOperationToken);
  activeOperationToken = "";
  delete process.env.RIOS_INSTALL_OPERATION_TOKEN;
}

function releaseUpdatePreparation() {
  if (!activePreparationToken) return;
  releaseInstallPreparation(APP_DIR, activePreparationToken);
  activePreparationToken = "";
  delete process.env.RIOS_INSTALL_PREPARATION_TOKEN;
}

async function acquireUpdatePreparation() {
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      activePreparationToken = acquireInstallPreparation(APP_DIR);
      process.env.RIOS_INSTALL_PREPARATION_TOKEN = activePreparationToken;
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

async function recoverUnfinishedUpdate() {
  if (!readInstallTransaction(APP_DIR)) return;
  try {
    activeOperationToken = acquireInstallOperation(APP_DIR);
    process.env.RIOS_INSTALL_OPERATION_TOKEN = activeOperationToken;
    await acquireUpdatePreparation();
    if (existsSync(join(APP_DIR, "package.json"))) {
      await stopExistingInstallRuntime({ appDir: APP_DIR, preservePids: PRESERVED_UPDATE_PIDS });
    }
    const recovered = recoverInstallTransaction(APP_DIR);
    say(`  Recovered an interrupted update (${recovered.status}).`);
  } finally {
    releaseUpdatePreparation();
    releaseUpdateOperation();
  }
}

function execWithPreparationLease(command, commandArgs, options = {}) {
  if (!activePreparationToken) throw new Error("The app preparation lease is not active");
  return execFileSync(process.execPath, [
    join(APP_DIR, "scripts", "lib", "run-with-install-lease.mjs"),
    "--app-dir",
    APP_DIR,
    "--token",
    activePreparationToken,
    "--",
    command,
    ...commandArgs
  ], options);
}

process.on("exit", () => {
  releaseUpdatePreparation();
  releaseUpdateOperation();
});

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

function channelsMatch(installedChannel, manifest) {
  const feedChannel = typeof manifest.channel === "string" ? manifest.channel.trim() : "";
  return !installedChannel || !feedChannel || installedChannel === feedChannel;
}

function stagedChannelMatches(stagedChannel, manifest) {
  const feedChannel = typeof manifest.channel === "string" ? manifest.channel.trim() : "";
  return !feedChannel || stagedChannel === feedChannel;
}

// A dev install must never apply a student feed (or vice versa): the versions
// are not comparable across channels and the wrong code would land. Older
// manifests carry no channel, so only enforce when BOTH sides declare one.
function enforceChannelMatch(installedChannel, manifest) {
  const feedChannel = typeof manifest.channel === "string" ? manifest.channel.trim() : "";
  if (channelsMatch(installedChannel, manifest)) return;
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
  let current = url;
  for (let hop = 0; hop <= 10; hop += 1) {
    if (!isAllowedRemoteUpdateUrl(current)) {
      throw new Error(`refusing to fetch an update over a non-https URL (must be https): ${current}`);
    }
    const res = await fetch(current, { redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`update redirect ${res.status} had no Location header`);
      const next = new URL(location, current).href;
      if (!isAllowedRemoteUpdateUrl(next)) {
        throw new Error(`refusing an update redirect to a non-https URL: ${next}`);
      }
      current = next;
      continue;
    }
    if (!isAllowedRemoteUpdateUrl(res.url)) {
      throw new Error(`refusing an update response from a non-https URL: ${res.url}`);
    }
    if (!res.ok) throw new Error(`fetch failed (${res.status} ${res.statusText}) for ${current}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("update redirect limit exceeded");
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

function pruneBackups(parent, prefix, keep, protectedBackup = "") {
  const protectedName = protectedBackup ? basename(protectedBackup) : "";
  const backups = readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .sort();
  while (backups.length > keep) {
    const removableIndex = backups.findIndex((name) => name !== protectedName);
    if (removableIndex < 0) break;
    const [old] = backups.splice(removableIndex, 1);
    try { rmSync(join(parent, old), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function ensurePackagedBundleSignature() {
  if (!RESIGN_BUNDLE) return;
  const codesign = process.platform === "darwin" ? "/usr/bin/codesign" : "codesign";
  say(`  Re-signing and verifying ${RESIGN_BUNDLE}…`);
  execWithPreparationLease(codesign, ["--force", "--deep", "--sign", "-", RESIGN_BUNDLE], { stdio: "ignore" });
  execWithPreparationLease(codesign, ["--verify", "--deep", "--strict", RESIGN_BUNDLE], { stdio: "ignore" });
}

function verifyRolledBackBundle(error) {
  if (!RESIGN_BUNDLE) return;
  try {
    ensurePackagedBundleSignature();
  } catch (signatureError) {
    die(
      `The previous code was restored, but the app signature could not be verified. Reinstall the signed app before opening it.\n` +
      `  Update error: ${error.message}\n  Signature error: ${signatureError.message}`
    );
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
  const operationId = `${stamp}-${process.pid}-${randomUUID()}`;
  const installScope = installScopeKey(APP_DIR);
  const stagingRoot = join(BACKUP_ROOT, `.rios-update-${installScope}-${operationId}`);
  const appNew = join(stagingRoot, "relationship-inbox-os");
  const backupPrefix = `.rios-backup-${installScope}-`;
  const backupDir = join(BACKUP_ROOT, `${backupPrefix}${operationId}`);
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
  const stagedVersion = currentVersion(appNew);
  if (stagedVersion !== manifest.version) {
    cleanup(stagingRoot);
    die(`The downloaded app is version ${stagedVersion}, but the update feed promised ${manifest.version}. Nothing was changed.`);
  }
  if (!stagedChannelMatches(currentChannel(appNew), manifest)) {
    cleanup(stagingRoot);
    die("The downloaded app belongs to a different update channel. Nothing was changed.");
  }

  try {
    activeOperationToken = acquireInstallOperation(APP_DIR);
    process.env.RIOS_INSTALL_OPERATION_TOKEN = activeOperationToken;
  } catch (err) {
    cleanup(stagingRoot);
    die(`Another installation or update is already changing this app.\n  ${err.message}`);
  }

  try {
    await acquireUpdatePreparation();
  } catch (err) {
    cleanup(stagingRoot);
    releaseUpdateOperation();
    die(`The app is still preparing data for launch. Wait for it to finish, then try the update again.\n  ${err.message}`);
  }

  const priorRecovery = recoverInstallTransaction(APP_DIR);
  if (priorRecovery.status !== "none") {
    say(`  Recovered an interrupted update (${priorRecovery.status}).`);
  }

  const lockedCurrent = currentVersion(APP_DIR);
  const lockedChannel = currentChannel(APP_DIR);
  if (!channelsMatch(lockedChannel, manifest)) {
    cleanup(stagingRoot);
    releaseUpdatePreparation();
    releaseUpdateOperation();
    enforceChannelMatch(lockedChannel, manifest);
  }
  if (!isNewer(manifest.version, lockedCurrent)) {
    cleanup(stagingRoot);
    releaseUpdatePreparation();
    releaseUpdateOperation();
    say(`  Another installation already updated this app to ${lockedCurrent}. The downloaded ${manifest.version} package was not applied.`);
    return;
  }
  if (compareVersions(lockedCurrent, manifest.minimumInstallerVersion) < 0) {
    cleanup(stagingRoot);
    releaseUpdatePreparation();
    releaseUpdateOperation();
    enforceMinimumInstallerVersion(lockedCurrent, manifest);
  }
  current = lockedCurrent;

  const transaction = beginInstallTransaction({
    appDir: APP_DIR,
    backupDir,
    backupRoot: BACKUP_ROOT,
    kind: "student-update",
    stagedApp: appNew,
    stagingRoot
  });
  activeTransactionId = transaction.operationId;

  // 4. Stop the full owned runtime, then atomically remove the old app from
  // its launch path. A second pass under the backup path closes the narrow
  // stop-to-rename race before SQLite/WAL/profile data is copied.
  try {
    await stopExistingInstallRuntime({ appDir: APP_DIR, preservePids: PRESERVED_UPDATE_PIDS });
  } catch (err) {
    clearActiveTransaction();
    cleanup(stagingRoot);
    die(`Could not stop the running app safely.\n  ${err.message}`);
  }
  try {
    durableInstallRename(APP_DIR, backupDir);
    checkpointInstallTransaction(APP_DIR, activeTransactionId, "old_moved");
  } catch (err) {
    try {
      recoverInstallTransaction(APP_DIR);
      activeTransactionId = "";
      cleanup(stagingRoot);
      die(`Could not back up the current app. The previous version was restored.\n  ${err.message}`);
    } catch (recoveryError) {
      die(`Could not finish or recover the app backup. Do not delete the update backup.\n  ${err.message}\n  ${recoveryError.message}`);
    }
  }
  let maintenanceToken = "";
  try {
    await stopExistingInstallRuntime({ appDir: backupDir, preservePids: PRESERVED_UPDATE_PIDS });
    for (const item of PRESERVE) {
      const from = join(backupDir, item);
      if (existsSync(from)) {
        rmSync(join(appNew, item), { recursive: true, force: true });
        cpSync(from, join(appNew, item), { recursive: true });
      }
    }
    maintenanceToken = acquireInstallMaintenance(APP_DIR);
    process.env.RIOS_INSTALL_MAINTENANCE_TOKEN = maintenanceToken;
    durableInstallRename(appNew, APP_DIR);
    checkpointInstallTransaction(APP_DIR, activeTransactionId, "published");
  } catch (err) {
    if (maintenanceToken) releaseInstallMaintenance(APP_DIR, maintenanceToken);
    cleanup(stagingRoot);
    if (!rollback(APP_DIR, backupDir)) {
      die(`Could not put the new app in place or restore it automatically. The previous version remains at ${backupDir}; do not delete it.\n  ${err.message}`);
    }
    clearActiveTransaction();
    die(`Could not put the new app in place. The previous version was restored.\n  ${err.message}`);
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
    let runningDatabaseStep = false;
    try {
      say(`  Installing dependencies (a few minutes)…`);
      execWithPreparationLease("npm", ["install", "--include=dev"], opts);
      execWithPreparationLease("npm", ["run", "db:generate"], opts);
      if (RESIGN_BUNDLE) {
        // Build before changing the external Application Support database.
        // The code directory can be rolled back here; the database cannot be
        // restored by rollback(APP_DIR, backupDir), so schema work must be the
        // final fallible preparation step.
        say(`  Building the app (a few minutes)…`);
        execWithPreparationLease("node", ["scripts/start-app.mjs", "--build-only"], opts);
        const missing = [
          "packages/core/dist/index.js",
          "apps/runner/dist/index.js",
          "apps/dashboard/.next/BUILD_ID"
        ].filter((p) => !existsSync(join(APP_DIR, p)));
        if (missing.length) {
          throw new Error(`packaged build artifacts missing after prepare: ${missing.join(", ")}`);
        }
        ensurePackagedBundleSignature();
      }
      checkpointInstallTransaction(APP_DIR, activeTransactionId, "ready");
      runningDatabaseStep = true;
      const databaseOpts = RESIGN_BUNDLE
        ? { ...opts, env: { ...process.env, RIOS_PACKAGED_APP: "1" } }
        : opts;
      execWithPreparationLease("node", ["scripts/start-app.mjs", "--database-only"], databaseOpts);
      runningDatabaseStep = false;
    } catch (err) {
      if (runningDatabaseStep && err?.status !== 43) {
        releaseInstallMaintenance(APP_DIR, maintenanceToken);
        delete process.env.RIOS_INSTALL_MAINTENANCE_TOKEN;
        releaseUpdatePreparation();
        die(
          `The database step stopped without a verified restoration. The new recovery-capable app and private database backups were kept. ` +
          `Do not replace or delete data/backups; free disk space, then run the installer again.\n  ${err.message}`,
          42
        );
      }
      releaseInstallMaintenance(APP_DIR, maintenanceToken);
      delete process.env.RIOS_INSTALL_MAINTENANCE_TOKEN;
      say(`  ${C.y}Dependency step failed — rolling back.${C.reset}`);
      if (!rollback(APP_DIR, backupDir)) {
        die(
          `Automatic rollback did not complete. The previous version remains at ${backupDir}; do not delete it.\n  ${err.message}`
        );
      }
      clearActiveTransaction();
      verifyRolledBackBundle(err);
      die(
        runningDatabaseStep
          ? `Update rolled back to ${current} after the database backup was verified as restored.\n  ${err.message}`
          : `Update rolled back to ${current}. The database step was not run.\n  ${err.message}`
      );
    }
    if (!RESIGN_BUNDLE) {
      // Pre-build the optimised dashboard so the relaunch is instant.
      // Non-fatal: the launcher rebuilds (or falls back to dev mode) itself.
      try {
        say(`  Optimising the app for speed (about a minute)…`);
        execWithPreparationLease("node", ["scripts/start-app.mjs", "--prepare-only"], opts);
      } catch {
        say(`  ${C.y}Pre-build didn't finish — the next launch will do it instead.${C.reset}`);
      }
    }
  }

  if (args.noDeps && RESIGN_BUNDLE) {
    try {
      ensurePackagedBundleSignature();
    } catch (err) {
      releaseInstallMaintenance(APP_DIR, maintenanceToken);
      delete process.env.RIOS_INSTALL_MAINTENANCE_TOKEN;
      say(`  ${C.y}App signature verification failed. Restoring the previous version.${C.reset}`);
      if (!rollback(APP_DIR, backupDir)) {
        die(
          `Automatic rollback did not complete. The previous version remains at ${backupDir}; do not delete it.\n  ${err.message}`
        );
      }
      clearActiveTransaction();
      verifyRolledBackBundle(err);
      die(`Update rolled back to ${current} because the signed app could not be verified.\n  ${err.message}`);
    }
  }
  if (!RESIGN_BUNDLE) {
    refreshMacAppBundle();
  }
  releaseInstallMaintenance(APP_DIR, maintenanceToken);
  delete process.env.RIOS_INSTALL_MAINTENANCE_TOKEN;
  checkpointInstallTransaction(APP_DIR, activeTransactionId, "committed");
  const keepBackups = Math.max(0, args.keepBackups);
  pruneBackups(BACKUP_ROOT, backupPrefix, keepBackups, keepBackups > 0 ? backupDir : "");
  const backupKept = existsSync(backupDir);
  clearActiveTransaction();
  releaseUpdatePreparation();
  releaseUpdateOperation();
  say(`\n  ${C.g}${C.b}Updated to ${manifest.version}.${C.reset}`);
  if (RESIGN_BUNDLE) {
    say(`  Start the app again:  ${C.b}open "${RESIGN_BUNDLE}"${C.reset}`);
  } else {
    const bundlePath = macAppBundlePath();
    if (bundlePath) say(`  Start the app again:  ${C.b}open "${bundlePath}"${C.reset}`);
    say(`  Terminal fallback:  ${C.b}npm run start:student${C.reset}`);
  }
  say(backupKept ? `  Previous version kept at: ${backupDir}\n` : `  No previous-version backup was retained.\n`);
}

function rollback(appDir, backupDir) {
  try {
    rollbackInstallTransaction(appDir, activeTransactionId);
    activeTransactionId = "";
  } catch {
    say(`  ${C.r}Automatic rollback hit a snag.${C.reset} Your previous app is at ${backupDir}.`);
    return false;
  }
  return true;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main() {
  configurePackagedPaths();
  if (RESIGN_BUNDLE) {
    die("Signed app bundles must be updated through the native whole-app updater. In-place source replacement and re-signing are disabled.");
  }
  if (args.apply) await recoverUnfinishedUpdate();
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
