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
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import {
  processGroupIsAlive,
  processIsAlive,
  processStartIdentity
} from "./process-lifecycle.mjs";

export const INSTALL_MAINTENANCE_FILE = ".tovi-installing";
export const INVALID_LOCK_GRACE_MS = 30_000;

function canonicalInstallPath(appDir) {
  const absolute = resolve(appDir);
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

function installLockDirectory() {
  return join(userInfo().homedir, ".relationship-inbox-os", "install-locks");
}

function installLockName(appDir, kind) {
  const target = canonicalInstallPath(appDir);
  const identity = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return `.${basename(target)}.${identity}.tovi-${kind}`;
}

export function installMaintenancePath(appDir) {
  return join(installLockDirectory(), installLockName(appDir, "maintenance"));
}

export function installOperationPath(appDir) {
  return join(installLockDirectory(), installLockName(appDir, "install-operation"));
}

export function installPreparationPath(appDir) {
  return join(installLockDirectory(), installLockName(appDir, "preparation"));
}

function readLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      ![1, 2].includes(value?.version) ||
      !Number.isInteger(Number(value.ownerPid)) ||
      Number(value.ownerPid) <= 0 ||
      typeof value.ownerIdentity !== "string" ||
      !value.ownerIdentity ||
      typeof value.token !== "string" ||
      !value.token
    ) {
      return null;
    }
    if (value.version === 2) {
      const groupPid = Number(value.protectedGroupPid || 0);
      const protectedPid = Number(value.protectedPid || 0);
      if (
        (!Number.isInteger(groupPid) || groupPid < 0) ||
        (!Number.isInteger(protectedPid) || protectedPid < 0) ||
        (protectedPid > 0 && (
          typeof value.protectedIdentity !== "string" || !value.protectedIdentity
        )) ||
        (groupPid === 0 && protectedPid === 0)
      ) {
        return null;
      }
      return { ...value, ownerPid: Number(value.ownerPid), protectedGroupPid: groupPid, protectedPid };
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

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function processLockMutationClaimPath(
  path,
  {
    ownerPid = process.pid,
    ownerIdentity = processStartIdentity(ownerPid),
    nonce = randomUUID()
  } = {}
) {
  if (!ownerIdentity) throw new Error("Could not identify the installation lock claimant");
  return `${path}.claim-${ownerPid}-${shortHash(ownerIdentity)}-${nonce}`;
}

function activeMutationClaims(path) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.claim-`;
  let entries;
  try {
    entries = readdirSync(directory).filter((entry) => entry.startsWith(prefix));
  } catch {
    return [];
  }
  const active = [];
  for (const entry of entries) {
    const claimPath = join(directory, entry);
    const match = entry.slice(prefix.length).match(/^(\d+)-([a-f0-9]{16})-/);
    if (!match) {
      try {
        if (Date.now() - statSync(claimPath).mtimeMs >= INVALID_LOCK_GRACE_MS) {
          rmSync(claimPath, { force: true });
        } else {
          active.push(claimPath);
        }
      } catch {}
      continue;
    }
    const ownerPid = Number(match[1]);
    if (!processIsAlive(ownerPid)) {
      rmSync(claimPath, { force: true });
      continue;
    }
    const identity = processStartIdentity(ownerPid);
    if (identity && shortHash(identity) !== match[2]) {
      rmSync(claimPath, { force: true });
      continue;
    }
    active.push(claimPath);
  }
  return active;
}

function activeProcessLeases(path) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.lease-`;
  let entries;
  try {
    entries = readdirSync(directory).filter((entry) => entry.startsWith(prefix));
  } catch {
    return [];
  }
  const active = [];
  for (const entry of entries) {
    const leasePath = join(directory, entry);
    const lease = readLock(leasePath);
    if (!lease) {
      try {
        if (Date.now() - statSync(leasePath).mtimeMs >= INVALID_LOCK_GRACE_MS) {
          rmSync(leasePath, { force: true });
        } else {
          active.push(leasePath);
        }
      } catch {}
      continue;
    }
    const ownerAlive = processIsAlive(lease.ownerPid);
    const ownerIdentity = ownerAlive ? processStartIdentity(lease.ownerPid) : "";
    const ownerCurrent = ownerAlive && (!ownerIdentity || ownerIdentity === lease.ownerIdentity);
    const protectedGroupAlive = lease.version === 2 && lease.protectedGroupPid > 0
      ? processGroupIsAlive(lease.protectedGroupPid)
      : false;
    const protectedAlive = lease.version === 2 && lease.protectedPid > 0 &&
      processIsAlive(lease.protectedPid);
    const protectedIdentity = protectedAlive ? processStartIdentity(lease.protectedPid) : "";
    const protectedProcessAlive = protectedAlive &&
      (!protectedIdentity || protectedIdentity === lease.protectedIdentity);
    if (!ownerCurrent && !protectedGroupAlive && !protectedProcessAlive) {
      rmSync(leasePath, { force: true });
      continue;
    }
    active.push(leasePath);
  }
  return active;
}

function assertNoActiveMutationClaims(path) {
  if (activeMutationClaims(path).length > 0) {
    throw new Error("Another installation is already changing this app");
  }
}

function assertNoActiveProcessLeases(path) {
  if (activeProcessLeases(path).length > 0) {
    throw new Error("Another installation is already changing this app");
  }
}

function claimCurrentLock(path) {
  const claimPath = processLockMutationClaimPath(path);
  try {
    linkSync(path, claimPath);
    return claimPath;
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
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
  const claimPath = claimCurrentLock(path);
  if (!claimPath) return true;
  try {
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
  if (!existsSync(path)) {
    return activeProcessLeases(path).length > 0
      ? { status: "active", path }
      : { status: "none", path };
  }
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
    assertNoActiveMutationClaims(path);
    assertNoActiveProcessLeases(path);
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

export function acquireProcessLockLease(
  path,
  token,
  {
    ownerPid = process.pid,
    ownerIdentity = processStartIdentity(ownerPid),
    nonce = randomUUID(),
    protectedGroupPid = 0,
    protectedPid = 0,
    protectedIdentity = protectedPid ? processStartIdentity(protectedPid) : ""
  } = {}
) {
  if (!token || !ownerIdentity) throw new Error("Could not identify the installation lock lease owner");
  if (protectedPid && !protectedIdentity) {
    throw new Error("Could not identify the protected installation worker");
  }
  const claimPath = claimCurrentLock(path);
  if (!claimPath) throw new Error("The installation lock owner stopped before its child was ready");
  const leasePath = `${path}.lease-${ownerPid}-${shortHash(ownerIdentity)}-${shortHash(token)}-${nonce}`;
  try {
    const current = readLock(claimPath);
    if (!current || current.token !== token) {
      throw new Error("The installation lock belongs to another process");
    }
    writeExclusiveJson(leasePath, {
      version: protectedGroupPid || protectedPid ? 2 : 1,
      ownerPid: Number(ownerPid),
      ownerIdentity,
      token,
      startedAt: new Date().toISOString(),
      ...(protectedGroupPid ? { protectedGroupPid: Number(protectedGroupPid) } : {}),
      ...(protectedPid ? { protectedPid: Number(protectedPid), protectedIdentity } : {})
    });
    return leasePath;
  } finally {
    rmSync(claimPath, { force: true });
  }
}

export function releaseProcessLockLease(path) {
  rmSync(path, { force: true });
}

export function releaseProcessLock(path, token) {
  const claimPath = claimCurrentLock(path);
  if (!claimPath) return true;
  try {
    const current = readLock(claimPath);
    if (!current || current.token !== token || !sameFile(path, claimPath)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    rmSync(claimPath, { force: true });
  }
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

export function inspectInstallPreparation(appDir, token = "") {
  return inspectProcessLock(installPreparationPath(appDir), token);
}

export function acquireInstallPreparation(appDir, options = {}) {
  return acquireProcessLock(installPreparationPath(appDir), options);
}

export function releaseInstallPreparation(appDir, token) {
  return releaseProcessLock(installPreparationPath(appDir), token);
}
