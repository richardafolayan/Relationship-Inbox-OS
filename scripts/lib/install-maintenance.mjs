import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
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

export function installMaintenancePath(appDir) {
  return join(appDir, INSTALL_MAINTENANCE_FILE);
}

export function installOperationPath(appDir) {
  const target = resolve(appDir);
  return join(dirname(target), `.${basename(target)}.tovi-install-operation`);
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

export function inspectProcessLock(path, token = "") {
  if (!existsSync(path)) return { status: "none", path };
  const lock = readLock(path);
  if (!lock) {
    try {
      if (Date.now() - statSync(path).mtimeMs >= INVALID_LOCK_GRACE_MS) {
        rmSync(path, { force: true });
        return { status: "stale", path };
      }
    } catch {
      if (!existsSync(path)) return { status: "none", path };
    }
    return { status: "invalid", path };
  }
  if (token && token === lock.token) return { status: "owner", path, lock };
  if (processIsAlive(lock.ownerPid)) {
    const identity = processStartIdentity(lock.ownerPid);
    if (!identity) return { status: "invalid", path, lock };
    if (identity === lock.ownerIdentity) return { status: "active", path, lock };
  }
  rmSync(path, { force: true });
  return { status: "stale", path, lock };
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
  let descriptor;
  let writeError;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        version: 1,
        ownerPid: Number(ownerPid),
        ownerIdentity,
        token,
        startedAt: new Date().toISOString()
      })}\n`
    );
  } catch (error) {
    writeError = error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (writeError) {
    rmSync(path, { force: true });
    throw writeError;
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
