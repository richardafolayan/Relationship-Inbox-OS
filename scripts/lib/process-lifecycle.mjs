import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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
    if (![1, 2].includes(parsed?.version) || !positivePid(parsed.parentPid)) return null;
    if (parsed.version === 2) {
      if (typeof parsed.parentIdentity !== "string" || !parsed.parentIdentity) return null;
      if (!Array.isArray(parsed.children)) return null;
      if (parsed.children.some((child) =>
        !positivePid(child?.pid) || typeof child?.identity !== "string" || !child.identity
      )) return null;
    }
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

export function processStartIdentity(pid, exec = execFileSync) {
  const normalized = positivePid(pid);
  if (!normalized) return "";
  if (process.platform === "win32") {
    try {
      return exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${normalized} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
        ],
        { encoding: "utf8" }
      ).trim();
    } catch {
      return "";
    }
  }
  try {
    return exec("ps", ["-p", String(normalized), "-o", "lstart="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function processSnapshot(pid, exec = execFileSync) {
  const normalized = positivePid(pid);
  if (!normalized) return { pid: null, cwd: "", command: "" };
  if (process.platform === "win32") {
    try {
      const output = exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter \"ProcessId = ${normalized}\" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`
        ],
        { encoding: "utf8" }
      ).trim();
      const row = output ? JSON.parse(output) : {};
      return {
        pid: normalized,
        cwd: "",
        command: [row.ExecutablePath, row.CommandLine].filter(Boolean).join(" ")
      };
    } catch {
      return { pid: normalized, cwd: "", command: "" };
    }
  }
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
  const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparableCwd = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  if (comparableCwd === comparableRoot || comparableCwd.startsWith(`${comparableRoot}${sep}`)) return true;
  const command = String(snapshot.command || "").replaceAll("\\", "/");
  const normalizedCommand = process.platform === "win32" ? command.toLowerCase() : command;
  return [...new Set([root, resolve(appDir)])].some((candidate) => {
    const normalizedCandidate = candidate.replaceAll("\\", "/");
    const path = process.platform === "win32" ? normalizedCandidate.toLowerCase() : normalizedCandidate;
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = `(?:^|[\\s\"'=(:,])`;
    return new RegExp(`${prefix}${escaped}(?:/|$)`).test(normalizedCommand) ||
      normalizedCommand.includes(`\"${path}\"`) ||
      normalizedCommand.includes(`'${path}'`);
  });
}

function productRootFromDirectory(path) {
  if (!path) return "";
  let current = canonicalPath(path);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
      if (manifest?.name === "relationship-inbox-os" && existsSync(join(current, "scripts", "start-app.mjs"))) {
        return current;
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

export function processBelongsToTovi(snapshot) {
  if (!snapshot?.pid) return false;
  if (productRootFromDirectory(snapshot.cwd)) return true;
  const command = String(snapshot.command || "").replaceAll("\\", "/").toLowerCase();
  if (command.includes("/tovi.app/contents/resources/app/")) return true;
  if (command.includes("/tovi/resources/app/")) return true;
  return command.includes("relationship-inbox-os") && [
    "/scripts/start-app.mjs",
    "/apps/dashboard/",
    "/apps/runner/"
  ].some((marker) => command.includes(marker));
}

function toviIdentity(snapshot) {
  const root = productRootFromDirectory(snapshot?.cwd);
  if (root) return canonicalPath(root);
  const command = String(snapshot?.command || "").replaceAll("\\", "/");
  const packaged = command.match(/^(.*?\/Tovi(?:\.app)?\/Contents\/Resources\/app)(?:\/|\s|$)/i)
    || command.match(/^(.*?\/Tovi\/resources\/app)(?:\/|\s|$)/i);
  return packaged?.[1] ? packaged[1].toLowerCase() : "";
}

function isToviRuntimeCommand(command) {
  const normalized = String(command || "").replaceAll("\\", "/").toLowerCase();
  return [
    "/scripts/start-app.mjs",
    "/apps/runner/",
    "/apps/dashboard/",
    "next-server",
    "tsx watch",
    "npm run start",
    "npm run dev"
  ].some((marker) => normalized.includes(marker));
}

export function listeningPids(port, exec = execFileSync) {
  if (process.platform === "win32") {
    try {
      return exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
        ],
        { encoding: "utf8" }
      )
        .split(/\s+/)
        .map(positivePid)
        .filter(Boolean);
    } catch {
      return [];
    }
  }
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
  const rootAlive = processIsAlive(pid, kill);
  if (!rootAlive && record.group && process.platform !== "win32" && record.identity && record.appDir) {
    for (const memberPid of processGroupMemberPids(pid)) {
      const identity = processStartIdentity(memberPid);
      if (!identity) continue;
      if (!processBelongsToApp(processSnapshot(memberPid), record.appDir)) continue;
      if (processStartIdentity(memberPid) !== identity) continue;
      try {
        kill(memberPid, signalName);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    return;
  }
  if (!rootAlive && !(record.group && process.platform !== "win32" && !record.identity)) return;
  if (rootAlive && record.identity && processStartIdentity(pid) !== record.identity) return;
  if (rootAlive && record.appDir && !processBelongsToApp(processSnapshot(pid), record.appDir)) return;
  if (rootAlive && record.toviOwned && !processBelongsToTovi(processSnapshot(pid))) return;
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

export async function recoverPriorRuntime({
  statePath,
  appDir,
  reclaim = false,
  graceMs = 2500,
  isAlive = processIsAlive,
  inspectProcess = processSnapshot
} = {}) {
  if (!existsSync(statePath)) return { status: "none", recovered: [] };
  const state = readRuntimeState(statePath);
  if (!state) {
    rmSync(statePath, { force: true });
    return { status: "invalid", recovered: [] };
  }

  if (state.version === 1) {
    if (!isAlive(state.parentPid)) {
      rmSync(statePath, { force: true });
      return { status: "stale", recovered: [] };
    }
    const snapshot = inspectProcess(state.parentPid);
    if (processBelongsToApp(snapshot, appDir) || (!snapshot.cwd && !snapshot.command)) {
      return { status: "already_running", recovered: ["launcher"] };
    }
    rmSync(statePath, { force: true });
    return { status: "stale", recovered: [] };
  }

  const records = [
    ...state.children.map((child) => ({ ...child, group: true, appDir })),
    {
      name: "launcher",
      pid: state.parentPid,
      identity: state.parentIdentity,
      group: false,
      appDir
    }
  ];
  const liveOwned = records.filter((record) => {
    if (!processIsAlive(record.pid)) return false;
    const identity = processStartIdentity(record.pid);
    return identity === record.identity && processBelongsToApp(processSnapshot(record.pid), appDir);
  });
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
      toviOwned: processBelongsToTovi(owner),
      command: owner.command
    }))
  };
}

function processParentPid(pid, exec = execFileSync) {
  if (process.platform === "win32") {
    try {
      return positivePid(exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter \"ProcessId = ${positivePid(pid)}\" | Select-Object -ExpandProperty ParentProcessId`
        ],
        { encoding: "utf8" }
      ).trim());
    } catch {
      return null;
    }
  }
  try {
    return positivePid(exec("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

export function runtimeRootIsOrphaned(pid, {
  platform = process.platform,
  parentPidFor = processParentPid,
  isAlive = processIsAlive
} = {}) {
  const parentPid = parentPidFor(pid);
  if (!parentPid) return false;
  if (platform !== "win32" && parentPid === 1) return true;
  return !isAlive(parentPid);
}

function processTreePids(rootPid, exec = execFileSync) {
  if (process.platform === "win32") return [rootPid];
  let rows;
  try {
    rows = exec("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [rootPid];
  }
  const children = new Map();
  for (const line of rows.split("\n")) {
    const [pid, parentPid] = line.trim().split(/\s+/).map(positivePid);
    if (!pid || !parentPid) continue;
    const siblings = children.get(parentPid) || [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const ordered = [];
  const visit = (pid) => {
    for (const childPid of children.get(pid) || []) visit(childPid);
    ordered.push(pid);
  };
  visit(rootPid);
  return ordered;
}

export function processGroupMemberPids(groupId, exec = execFileSync) {
  const normalized = positivePid(groupId);
  if (!normalized || process.platform === "win32") return [];
  try {
    return exec("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(positivePid))
      .filter(([pid, pgid]) => pid && pgid === normalized)
      .map(([pid]) => pid);
  } catch {
    return [];
  }
}

export function processGroupIsAlive(groupId, exec = execFileSync) {
  const normalized = positivePid(groupId);
  if (!normalized || process.platform === "win32") return false;
  try {
    return exec("ps", ["-axo", "pgid="], { encoding: "utf8" })
      .split(/\s+/)
      .map(positivePid)
      .some((pid) => pid === normalized);
  } catch {
    return true;
  }
}

function toviProcessRoot(pid) {
  let current = positivePid(pid);
  const identity = toviIdentity(processSnapshot(current));
  if (!identity) return null;
  let root = current;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parentPid = processParentPid(current);
    if (!parentPid) break;
    const parent = processSnapshot(parentPid);
    if (toviIdentity(parent) !== identity || !isToviRuntimeCommand(parent.command)) break;
    root = parentPid;
    current = parentPid;
  }
  return root;
}

export function portConflictIsStaleTovi(conflict) {
  if (!conflict?.owners?.length || conflict.owners.some((owner) => !owner.toviOwned)) return false;
  const roots = [...new Set(conflict.owners.map((owner) => toviProcessRoot(owner.pid)).filter(Boolean))];
  if (roots.length === 0) return listeningPids(conflict.port).length === 0;
  return roots.every((pid) => runtimeRootIsOrphaned(pid));
}

export async function reclaimPortConflict(conflict, { graceMs = 2500 } = {}) {
  if (!conflict?.owners?.length || conflict.owners.some((owner) => !owner.toviOwned)) {
    return { status: "refused", stopped: [] };
  }
  const roots = [...new Set(conflict.owners.map((owner) => toviProcessRoot(owner.pid)).filter(Boolean))];
  if (roots.length === 0) {
    return listeningPids(conflict.port).length === 0
      ? { status: "recovered", stopped: [] }
      : { status: "refused", stopped: [] };
  }

  const rootRecords = roots.map((pid) => ({
    pid,
    identity: processStartIdentity(pid),
    toviOwned: true
  })).filter((record) => record.identity && processBelongsToTovi(processSnapshot(record.pid)));

  if (process.platform === "win32") {
    for (const record of rootRecords) {
      if (processStartIdentity(record.pid) !== record.identity) continue;
      if (!processBelongsToTovi(processSnapshot(record.pid))) continue;
      try {
        execFileSync("taskkill.exe", ["/PID", String(record.pid), "/T"], { stdio: "ignore" });
      } catch {
        // A process can finish while the recovery action is running.
      }
    }
  } else {
    const records = [...new Set(roots.flatMap((pid) => processTreePids(pid)))].map((pid) => ({
      pid,
      identity: processStartIdentity(pid),
      group: false,
      toviOwned: true
    })).filter((record) => record.identity && processBelongsToTovi(processSnapshot(record.pid)));
    for (const record of records) signal(record, "SIGTERM");
    await delay(graceMs);
    for (const record of records) {
      if (processIsAlive(record.pid)) signal(record, "SIGKILL");
    }
  }

  await delay(100);
  return listeningPids(conflict.port).length === 0
    ? { status: "recovered", stopped: roots }
    : { status: "failed", stopped: roots };
}

export async function stopChildGroups(children, { graceMs = 4000 } = {}) {
  const records = children.filter((child) => positivePid(child?.pid)).map((child) => ({ ...child, group: true }));
  for (const record of records) signal(record, "SIGTERM");
  await delay(graceMs);
  for (const record of records) {
    if (process.platform !== "win32" || processIsAlive(record.pid)) signal(record, "SIGKILL");
  }
}
