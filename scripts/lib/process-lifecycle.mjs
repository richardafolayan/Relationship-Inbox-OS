import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function positivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function readRuntimeState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || !positivePid(parsed.parentPid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRuntimeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
}

export function removeRuntimeState(path, parentPid = process.pid) {
  const state = readRuntimeState(path);
  if (state && state.parentPid !== parentPid) return false;
  rmSync(path, { force: true });
  return true;
}

export function processIsAlive(pid, kill = process.kill) {
  const normalized = positivePid(pid);
  if (!normalized) return false;
  try {
    kill(normalized, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function processSnapshot(pid, exec = execFileSync) {
  const normalized = positivePid(pid);
  if (!normalized) return { pid: null, cwd: "", command: "" };
  let cwd = "";
  let command = "";
  try {
    cwd = exec("lsof", ["-a", "-p", String(normalized), "-d", "cwd", "-Fn"], { encoding: "utf8" })
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1) || "";
  } catch {
    // ps still gives us a second ownership signal when lsof is unavailable.
  }
  try {
    command = exec("ps", ["-p", String(normalized), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    // A process can exit between the liveness check and this read.
  }
  return { pid: normalized, cwd, command };
}

export function processBelongsToApp(snapshot, appDir) {
  if (!snapshot?.pid) return false;
  // lsof reports symlink-resolved paths (/var -> /private/var), so both
  // sides must be canonicalized before comparing.
  const root = canonicalPath(appDir);
  const cwd = snapshot.cwd ? canonicalPath(snapshot.cwd) : "";
  if (cwd === root || cwd.startsWith(`${root}${sep}`)) return true;
  return snapshot.command.includes(root) || snapshot.command.includes(resolve(appDir));
}

export function listeningPids(port, exec = execFileSync) {
  try {
    return exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split(/\s+/)
      .map(positivePid)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function signal(record, signalName, kill = process.kill) {
  const pid = positivePid(record?.pid);
  if (!pid) return;
  const target = record.group && process.platform !== "win32" ? -pid : pid;
  try {
    kill(target, signalName);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function recoverPriorRuntime({ statePath, appDir, reclaim = false, graceMs = 2500 } = {}) {
  if (!existsSync(statePath)) return { status: "none", recovered: [] };
  const state = readRuntimeState(statePath);
  if (!state) {
    rmSync(statePath, { force: true });
    return { status: "invalid", recovered: [] };
  }

  const records = [
    ...(Array.isArray(state.children) ? state.children.map((child) => ({ ...child, group: true })) : []),
    { name: "launcher", pid: state.parentPid, group: false }
  ];
  const liveOwned = records.filter((record) =>
    processIsAlive(record.pid) && processBelongsToApp(processSnapshot(record.pid), appDir)
  );
  if (liveOwned.length === 0) {
    rmSync(statePath, { force: true });
    return { status: "stale", recovered: [] };
  }
  if (!reclaim) {
    return { status: "already_running", recovered: liveOwned.map((record) => record.name) };
  }

  for (const record of liveOwned) signal(record, "SIGTERM");
  await delay(graceMs);
  for (const record of liveOwned) {
    if (processIsAlive(record.pid)) signal(record, "SIGKILL");
  }
  rmSync(statePath, { force: true });
  return { status: "recovered", recovered: liveOwned.map((record) => record.name) };
}

export function portConflict(port, appDir) {
  const owners = listeningPids(port).map((pid) => processSnapshot(pid));
  if (owners.length === 0) return null;
  return {
    port: String(port),
    owners: owners.map((owner) => ({
      pid: owner.pid,
      owned: processBelongsToApp(owner, appDir),
      command: owner.command
    }))
  };
}

export async function stopChildGroups(children, { graceMs = 4000 } = {}) {
  const records = children.filter((child) => positivePid(child?.pid)).map((child) => ({ ...child, group: true }));
  for (const record of records) signal(record, "SIGTERM");
  await delay(graceMs);
  for (const record of records) {
    if (processIsAlive(record.pid)) signal(record, "SIGKILL");
  }
}
