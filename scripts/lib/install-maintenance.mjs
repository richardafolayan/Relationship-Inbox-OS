import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { processIsAlive, processStartIdentity } from "./process-lifecycle.mjs";

export const INSTALL_MAINTENANCE_FILE = ".tovi-installing";
export const INVALID_LOCK_GRACE_MS = 30_000;

function containingAppBundle(appDir) {
  let current = resolve(appDir);
  while (true) {
    if (basename(current).toLowerCase().endsWith(".app")) return current;
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function installLockDirectory(appDir, environment = process.env) {
  const configured = String(environment.RIOS_CONFIG_DIR || "").trim();
  if (configured) return join(resolve(configured), "install-locks");
  const bundle = containingAppBundle(appDir);
  return bundle ? dirname(bundle) : dirname(resolve(appDir));
}

function installLockName(appDir, kind) {
  const target = resolve(appDir);
  const identity = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return `.${basename(target)}.${identity}.tovi-${kind}`;
}

export function installMaintenancePath(appDir, environment = process.env) {
  return join(installLockDirectory(appDir, environment), installLockName(appDir, "maintenance"));
}

export function installOperationPath(appDir, environment = process.env) {
  return join(installLockDirectory(appDir, environment), installLockName(appDir, "install-operation"));
}

function readLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value?.version !== 1 ||
      !Number.isInteger(Number(value.ownerPid)) ||
      Number(value.ownerPid) <= 0 ||
      typeof value.ownerIdentity !== "string" ||
      !value.ownerIdentity ||
      typeof value.token !== "string" ||
      !value.token
    ) {
      return null;
    }
    return { ...value, ownerPid: Number(value.ownerPid) };
  } catch {
    return null;
  }
}

function sameFile(left, right) {
  try {
    const a = lstatSync(left);
    const b = lstatSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function writeExclusiveJson(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function reclaimStaleLock(path, expectedLock = null) {
  const claimPath = `${path}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    try {
      linkSync(path, claimPath);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    const current = readLock(claimPath);
    if (expectedLock) {
      if (!current || current.token !== expectedLock.token) return false;
      const identity = processIsAlive(current.ownerPid)
        ? processStartIdentity(current.ownerPid)
        : "";
      if (identity && identity === current.ownerIdentity) return false;
    } else {
      if (current) return false;
      try {
        if (Date.now() - statSync(claimPath).mtimeMs < INVALID_LOCK_GRACE_MS) return false;
      } catch {
        return false;
      }
    }
    if (!sameFile(path, claimPath)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    rmSync(claimPath, { force: true });
  }
}

export function inspectProcessLock(path, token = "") {
  if (!existsSync(path)) return { status: "none", path };
  const lock = readLock(path);
  if (!lock) {
    if (reclaimStaleLock(path)) return { status: "stale", path };
    if (!existsSync(path)) return { status: "none", path };
    return { status: "invalid", path };
  }
  if (token && token === lock.token) return { status: "owner", path, lock };
  if (processIsAlive(lock.ownerPid)) {
    const identity = processStartIdentity(lock.ownerPid);
    if (!identity) return { status: "invalid", path, lock };
    if (identity === lock.ownerIdentity) return { status: "active", path, lock };
  }
  if (reclaimStaleLock(path, lock)) return { status: "stale", path, lock };
  return existsSync(path) ? { status: "invalid", path, lock } : { status: "stale", path, lock };
}

export function acquireProcessLock(
  path,
  { ownerPid = process.pid, ownerIdentity = processStartIdentity(ownerPid), token = randomUUID() } = {}
) {
  if (!ownerIdentity) throw new Error("Could not identify the installation lock owner");
  const existing = inspectProcessLock(path, token);
  if (existing.status === "owner") return token;
  if (existing.status === "active" || existing.status === "invalid") {
    throw new Error("Another installation is already changing this app");
  }
  mkdirSync(dirname(path), { recursive: true });
  const candidatePath = `${path}.candidate-${process.pid}-${randomUUID()}`;
  try {
    writeExclusiveJson(candidatePath, {
      version: 1,
      ownerPid: Number(ownerPid),
      ownerIdentity,
      token,
      startedAt: new Date().toISOString()
    });
    linkSync(candidatePath, path);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another installation is already changing this app");
    }
    throw error;
  } finally {
    rmSync(candidatePath, { force: true });
  }
  return token;
}

export function releaseProcessLock(path, token) {
  const state = inspectProcessLock(path, token);
  if (state.status === "none" || state.status === "stale") return true;
  if (state.status !== "owner") return false;
  rmSync(state.path, { force: true });
  return true;
}

export function inspectInstallMaintenance(appDir, token = "") {
  return inspectProcessLock(installMaintenancePath(appDir), token);
}

export function acquireInstallMaintenance(appDir, options = {}) {
  return acquireProcessLock(installMaintenancePath(appDir), options);
}

export function releaseInstallMaintenance(appDir, token) {
  return releaseProcessLock(installMaintenancePath(appDir), token);
}

export function inspectInstallOperation(appDir, token = "") {
  return inspectProcessLock(installOperationPath(appDir), token);
}

export function acquireInstallOperation(appDir, options = {}) {
  return acquireProcessLock(installOperationPath(appDir), options);
}

export function releaseInstallOperation(appDir, token) {
  return releaseProcessLock(installOperationPath(appDir), token);
}
