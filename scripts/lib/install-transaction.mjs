#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireInstallOperation,
  acquireInstallPreparation,
  releaseInstallOperation,
  releaseInstallPreparation
} from "./install-maintenance.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const INSTALL_IDENTITY_FILE = ".tovi-install-transaction-id";
const PHASES = new Map([
  ["staged", 0],
  ["old_moved", 1],
  ["published", 2],
  ["ready", 3],
  ["committed", 4]
]);

function fsyncDirectory(path) {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function nearestCanonical(path) {
  const absolute = resolve(path);
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
}

function pathIsWithin(root, target) {
  const path = relative(nearestCanonical(root), nearestCanonical(target));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function rootPath(rootDir) {
  const configured = rootDir || process.env.RIOS_INSTALL_TRANSACTION_DIR?.trim();
  return resolve(configured || join(userInfo().homedir, ".relationship-inbox-os", "install-transactions"));
}

function privateRoot(rootDir) {
  const root = rootPath(rootDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch {}
  return root;
}

function installKey(appDir) {
  return createHash("sha256").update(nearestCanonical(appDir)).digest("hex");
}

export function installScopeKey(appDir) {
  return installKey(appDir).slice(0, 20);
}

export function installTransactionPath(appDir, options = {}) {
  return join(privateRoot(options.rootDir), `${installKey(appDir)}.json`);
}

export function installRecoveryBootstrapPath(appDir, options = {}) {
  return join(dirname(rootPath(options.rootDir)), "install-recovery", `${installKey(appDir)}.mjs`);
}

function atomicWrite(path, text, mode = 0o600) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function writeJournal(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureInstallRecoveryBootstrap(appDir, options = {}) {
  const destination = installRecoveryBootstrapPath(appDir, options);
  for (const dependency of ["process-lifecycle.mjs", "install-maintenance.mjs"]) {
    atomicWrite(
      join(dirname(destination), dependency),
      readFileSync(join(dirname(MODULE_PATH), dependency), "utf8")
    );
  }
  atomicWrite(destination, readFileSync(MODULE_PATH, "utf8"), 0o700);
  return destination;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function captureInstallIdentity(appDir) {
  const packagePath = join(appDir, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    if (typeof pkg.version !== "string" || !pkg.version) return null;
    const releasePath = join(appDir, "release.json");
    const markerPath = join(appDir, INSTALL_IDENTITY_FILE);
    return {
      version: pkg.version,
      packageHash: hashFile(packagePath),
      releaseHash: existsSync(releasePath) ? hashFile(releasePath) : "",
      installMarker: existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : ""
    };
  } catch {
    return null;
  }
}

function identityIsValid(value) {
  return Boolean(
    value &&
    typeof value.version === "string" &&
    /^[a-f0-9]{64}$/.test(value.packageHash) &&
    (value.releaseHash === "" || /^[a-f0-9]{64}$/.test(value.releaseHash)) &&
    typeof value.installMarker === "string" &&
    value.installMarker.length >= 16
  );
}

function identitiesMatch(actual, expected) {
  return Boolean(
    actual &&
    expected &&
    actual.version === expected.version &&
    actual.packageHash === expected.packageHash &&
    actual.releaseHash === expected.releaseHash &&
    actual.installMarker === expected.installMarker
  );
}

function validateJournal(value, requestedAppDir) {
  if (!value || value.version !== 1 || typeof value.operationId !== "string" || !value.operationId) {
    throw new Error("The install transaction journal is invalid; no files were changed");
  }
  if (!PHASES.has(value.codePhase) || !isAbsolute(value.appDir) || !isAbsolute(value.backupRoot)) {
    throw new Error("The install transaction journal is invalid; no files were changed");
  }
  if (nearestCanonical(value.appDir) !== nearestCanonical(requestedAppDir)) {
    throw new Error("The install transaction journal belongs to a different app; no files were changed");
  }
  for (const path of [value.stagingRoot, value.stagedApp, value.backupDir, value.failedDir]) {
    if (!isAbsolute(path) || !pathIsWithin(value.backupRoot, path) || nearestCanonical(path) === nearestCanonical(value.appDir)) {
      throw new Error("The install transaction journal contains an unsafe path; no files were changed");
    }
  }
  if (!pathIsWithin(value.stagingRoot, value.stagedApp)) {
    throw new Error("The install transaction staging path is invalid; no files were changed");
  }
  if (
    nearestCanonical(value.stagingRoot) === nearestCanonical(value.backupRoot) ||
    pathIsWithin(value.stagingRoot, value.appDir) ||
    pathIsWithin(value.stagingRoot, value.backupDir) ||
    pathIsWithin(value.stagingRoot, value.failedDir)
  ) {
    throw new Error("The install transaction cleanup paths overlap; no files were changed");
  }
  if (value.before !== null && !identityIsValid(value.before)) {
    throw new Error("The install transaction prior identity is invalid; no files were changed");
  }
  if (!identityIsValid(value.after)) {
    throw new Error("The install transaction staged identity is invalid; no files were changed");
  }
  return value;
}

export function readInstallTransaction(appDir, options = {}) {
  const path = installTransactionPath(appDir, options);
  if (!existsSync(path)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("The install transaction journal is unreadable; no files were changed");
  }
  return validateJournal(value, appDir);
}

export function beginInstallTransaction({
  appDir,
  backupDir,
  backupRoot,
  kind,
  stagedApp,
  stagingRoot
}, options = {}) {
  if (![appDir, backupDir, backupRoot, stagedApp, stagingRoot].every(isAbsolute)) {
    throw new Error("Install transaction paths must be absolute");
  }
  if (readInstallTransaction(appDir, options)) {
    throw new Error("An unfinished install transaction must be recovered first");
  }
  const rawAfter = captureInstallIdentity(stagedApp);
  if (!rawAfter) throw new Error("The staged app identity could not be verified");
  const rawBefore = captureInstallIdentity(appDir);
  const operationId = randomUUID();
  const failedDir = nearestCanonical(join(backupRoot, `.failed-install-${operationId}`));
  const appPath = nearestCanonical(appDir);
  const backupRootPath = nearestCanonical(backupRoot);
  const stagingRootPath = nearestCanonical(stagingRoot);
  const stagedAppPath = nearestCanonical(stagedApp);
  const backupPath = nearestCanonical(backupDir);
  for (const path of [stagingRootPath, stagedAppPath, backupPath, failedDir]) {
    if (!pathIsWithin(backupRootPath, path) || path === appPath) {
      throw new Error("The install transaction contains an unsafe path; no files were changed");
    }
  }
  if (
    !pathIsWithin(stagingRootPath, stagedAppPath) ||
    stagingRootPath === backupRootPath ||
    pathIsWithin(stagingRootPath, appPath) ||
    pathIsWithin(stagingRootPath, backupPath) ||
    pathIsWithin(stagingRootPath, failedDir)
  ) {
    throw new Error("The install transaction cleanup paths overlap; no files were changed");
  }
  if (rawBefore) atomicWrite(join(appDir, INSTALL_IDENTITY_FILE), `${operationId}:before\n`);
  atomicWrite(join(stagedApp, INSTALL_IDENTITY_FILE), `${operationId}:after\n`);
  const before = rawBefore ? captureInstallIdentity(appDir) : null;
  const after = captureInstallIdentity(stagedApp);
  const value = validateJournal({
    version: 1,
    operationId,
    kind: String(kind || "install"),
    appDir: appPath,
    backupRoot: backupRootPath,
    stagingRoot: stagingRootPath,
    stagedApp: stagedAppPath,
    backupDir: backupPath,
    failedDir,
    before,
    after,
    codePhase: "staged",
    recordedAt: new Date().toISOString()
  }, appDir);
  writeJournal(installTransactionPath(appDir, options), value);
  ensureInstallRecoveryBootstrap(appDir, options);
  return value;
}

export function checkpointInstallTransaction(appDir, operationId, codePhase, options = {}) {
  const value = readInstallTransaction(appDir, options);
  if (!value || value.operationId !== operationId) {
    throw new Error("The install transaction owner changed");
  }
  if (!PHASES.has(codePhase) || PHASES.get(codePhase) < PHASES.get(value.codePhase)) {
    throw new Error("The install transaction phase cannot move backwards");
  }
  const next = { ...value, codePhase, recordedAt: new Date().toISOString() };
  writeJournal(installTransactionPath(appDir, options), next);
  return next;
}

export function moveInstallTransaction(appDir, operationId, action, options = {}) {
  const value = readInstallTransaction(appDir, options);
  if (!value || value.operationId !== operationId) {
    throw new Error("The install transaction owner changed");
  }
  if (action === "move-old") {
    if (!value.before || !identitiesMatch(captureInstallIdentity(value.appDir), value.before)) {
      throw new Error("The prior app identity changed before its backup move");
    }
    if (existsSync(value.backupDir)) throw new Error("The install backup destination already exists");
    durableInstallRename(value.appDir, value.backupDir);
    return checkpointInstallTransaction(appDir, operationId, "old_moved", options);
  }
  if (action === "publish") {
    if (captureInstallIdentity(value.appDir)) throw new Error("The app launch path is not empty");
    if (!identitiesMatch(captureInstallIdentity(value.stagedApp), value.after)) {
      throw new Error("The staged app identity changed before publication");
    }
    durableInstallRename(value.stagedApp, value.appDir);
    return checkpointInstallTransaction(appDir, operationId, "published", options);
  }
  throw new Error("Unknown install transaction move");
}

export function clearInstallTransaction(appDir, operationId = "", options = {}) {
  const path = installTransactionPath(appDir, options);
  if (!existsSync(path)) return false;
  const value = readInstallTransaction(appDir, options);
  if (operationId && value.operationId !== operationId) {
    throw new Error("The install transaction owner changed");
  }
  if (existsSync(value.stagingRoot)) {
    rmSync(value.stagingRoot, { recursive: true, force: true });
    fsyncDirectory(dirname(value.stagingRoot));
  }
  rmSync(path);
  fsyncDirectory(dirname(path));
  for (const [directory, markers] of [
    [value.appDir, [value.before?.installMarker, value.after.installMarker]],
    [value.backupDir, [value.before?.installMarker]],
    [value.failedDir, [value.after.installMarker]],
    [value.stagedApp, [value.after.installMarker]]
  ]) {
    const markerPath = join(directory, INSTALL_IDENTITY_FILE);
    try {
      const current = readFileSync(markerPath, "utf8").trim();
      if (markers.filter(Boolean).includes(current)) {
        rmSync(markerPath);
        fsyncDirectory(directory);
      }
    } catch {}
  }
  return true;
}

function removeFailedInstall(value) {
  if (!existsSync(value.failedDir)) return;
  rmSync(value.failedDir, { recursive: true, force: true });
  fsyncDirectory(dirname(value.failedDir));
}

export function durableInstallRename(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
  for (const parent of new Set([dirname(source), dirname(destination)])) fsyncDirectory(parent);
}

export function rollbackInstallTransaction(appDir, operationId, options = {}) {
  const value = readInstallTransaction(appDir, options);
  if (!value || value.operationId !== operationId || !value.before) {
    throw new Error("The install transaction cannot restore a prior app");
  }
  let current = captureInstallIdentity(value.appDir);
  if (identitiesMatch(current, value.before)) {
    removeFailedInstall(value);
    clearInstallTransaction(appDir, operationId, options);
    return { status: "kept-old", operationId };
  }
  if (identitiesMatch(current, value.after)) {
    if (existsSync(value.failedDir)) {
      throw new Error("The failed-install recovery destination is already occupied");
    }
    durableInstallRename(value.appDir, value.failedDir);
    current = null;
  }
  if (!current && identitiesMatch(captureInstallIdentity(value.backupDir), value.before)) {
    durableInstallRename(value.backupDir, value.appDir);
    removeFailedInstall(value);
    clearInstallTransaction(appDir, operationId, options);
    return { status: "restored-old", operationId };
  }
  throw new Error("The prior app could not be restored unambiguously; no files were changed");
}

export function recoverInstallTransaction(appDir, options = {}) {
  const value = readInstallTransaction(appDir, options);
  if (!value) return { status: "none" };
  const current = captureInstallIdentity(value.appDir);
  const backup = captureInstallIdentity(value.backupDir);
  const staged = captureInstallIdentity(value.stagedApp);

  if (
    identitiesMatch(current, value.after) &&
    value.before &&
    PHASES.get(value.codePhase) < PHASES.get("ready")
  ) {
    return rollbackInstallTransaction(appDir, value.operationId, options);
  }
  if (identitiesMatch(current, value.after)) {
    clearInstallTransaction(appDir, value.operationId, options);
    return { status: "kept-new", operationId: value.operationId, backupDir: value.backupDir };
  }
  if (identitiesMatch(current, value.before)) {
    removeFailedInstall(value);
    clearInstallTransaction(appDir, value.operationId, options);
    return { status: "kept-old", operationId: value.operationId };
  }
  if (!current && value.before && identitiesMatch(backup, value.before)) {
    durableInstallRename(value.backupDir, value.appDir);
    removeFailedInstall(value);
    clearInstallTransaction(appDir, value.operationId, options);
    return { status: "restored-old", operationId: value.operationId };
  }
  if (!current && value.before === null && identitiesMatch(staged, value.after)) {
    durableInstallRename(value.stagedApp, value.appDir);
    clearInstallTransaction(appDir, value.operationId, options);
    return { status: "published-new", operationId: value.operationId };
  }
  throw new Error("The unfinished install transaction is ambiguous; no files were changed");
}

export function recoverInstallTransactionSerialized(appDir, options = {}) {
  let operationToken = "";
  let preparationToken = "";
  try {
    operationToken = acquireInstallOperation(appDir);
    preparationToken = acquireInstallPreparation(appDir);
    return recoverInstallTransaction(appDir, options);
  } finally {
    if (preparationToken) releaseInstallPreparation(appDir, preparationToken);
    if (operationToken) releaseInstallOperation(appDir, operationToken);
  }
}

function parseCli(argv) {
  const [command = "", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    const value = rest[++index];
    if (name === "--app-dir") options.appDir = resolve(value || "");
    else if (name === "--backup-dir") options.backupDir = resolve(value || "");
    else if (name === "--backup-root") options.backupRoot = resolve(value || "");
    else if (name === "--kind") options.kind = value;
    else if (name === "--operation-id") options.operationId = value;
    else if (name === "--phase") options.phase = value;
    else if (name === "--staged-app") options.stagedApp = resolve(value || "");
    else if (name === "--staging-root") options.stagingRoot = resolve(value || "");
    else if (name === "--transaction-root") options.rootDir = resolve(value || "");
  }
  return options;
}

function runCli() {
  const args = parseCli(process.argv.slice(2));
  const options = { rootDir: args.rootDir };
  if (!args.appDir || !isAbsolute(args.appDir)) {
    throw new Error("Usage: install-transaction.mjs <begin|checkpoint|commit|clear|recover> --app-dir <absolute path>");
  }
  let result;
  if (args.command === "begin") {
    result = beginInstallTransaction(args, options);
  } else if (args.command === "checkpoint") {
    result = checkpointInstallTransaction(args.appDir, args.operationId, args.phase, options);
  } else if (args.command === "move-old" || args.command === "publish") {
    result = moveInstallTransaction(args.appDir, args.operationId, args.command, options);
  } else if (args.command === "rollback") {
    result = rollbackInstallTransaction(args.appDir, args.operationId, options);
  } else if (args.command === "commit") {
    result = checkpointInstallTransaction(args.appDir, args.operationId, "committed", options);
  } else if (args.command === "clear") {
    result = { cleared: clearInstallTransaction(args.appDir, args.operationId, options) };
  } else if (args.command === "recover") {
    result = recoverInstallTransaction(args.appDir, options);
  } else if (args.command === "recover-serialized") {
    result = recoverInstallTransactionSerialized(args.appDir, options);
  } else {
    throw new Error("Unknown install transaction command");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function canonical(path) {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(MODULE_PATH)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
