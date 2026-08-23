import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { processIsAlive } from "./process-lifecycle.mjs";

export const INSTALL_MAINTENANCE_FILE = ".tovi-installing";

export function installMaintenancePath(appDir) {
  return join(appDir, INSTALL_MAINTENANCE_FILE);
}

function readLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value?.version !== 1 ||
      !Number.isInteger(Number(value.ownerPid)) ||
      Number(value.ownerPid) <= 0 ||
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
  if (!lock) return { status: "invalid", path };
  if (token && token === lock.token) return { status: "owner", path, lock };
  if (processIsAlive(lock.ownerPid)) return { status: "active", path, lock };
  rmSync(path, { force: true });
  return { status: "stale", path, lock };
}

export function acquireProcessLock(path, { ownerPid = process.pid, token = randomUUID() } = {}) {
  const existing = inspectProcessLock(path, token);
  if (existing.status === "owner") return token;
  if (existing.status === "active" || existing.status === "invalid") {
    throw new Error("Another installation is already changing this app");
  }
  mkdirSync(dirname(path), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({ version: 1, ownerPid: Number(ownerPid), token, startedAt: new Date().toISOString() })}\n`
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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
