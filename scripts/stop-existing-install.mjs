#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadAppEnv } from "./lib/env-file.mjs";
import {
  processBelongsToApp,
  processIsAlive,
  processStartIdentity,
  processSnapshot,
  readRuntimeState
} from "./lib/process-lifecycle.mjs";

function positivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function runtimeCommand(command) {
  const normalized = String(command || "").replaceAll("\\", "/").toLowerCase();
  return [
    "/scripts/start-app.mjs",
    "scripts/start-app.mjs",
    "/scripts/start-student.mjs",
    "scripts/start-student.mjs",
    "/apps/runner/",
    "/apps/dashboard/",
    "next-server",
    "/next/dist/bin/next",
    "start:student"
  ].some((marker) => normalized.includes(marker));
}

function processRows(exec = execFileSync) {
  if (process.platform === "win32") {
    try {
      const output = exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
        ],
        { encoding: "utf8" }
      ).trim();
      const rows = output ? JSON.parse(output) : [];
      return (Array.isArray(rows) ? rows : [rows])
        .map((row) => ({ pid: positivePid(row.ProcessId), command: row.CommandLine || "" }))
        .filter((row) => row.pid);
    } catch {
      throw new Error("Could not inspect running processes");
    }
  }
  try {
    return exec("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((match) => ({ pid: positivePid(match[1]), command: match[2] }))
      .filter((row) => row.pid);
  } catch {
    throw new Error("Could not inspect running processes");
  }
}

function configuredPorts(appDir) {
  const env = loadAppEnv(appDir, { ...process.env });
  return [...new Set([env.DASHBOARD_PORT || "3100", env.RUNNER_PORT || "4001"]
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535))];
}

function listeningPids(ports, exec = execFileSync) {
  if (process.platform === "win32") {
    try {
      const portList = ports.join(",");
      const output = exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ports = @(${portList}); Get-NetTCPConnection -State Listen -ErrorAction Stop | ` +
            "Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique"
        ],
        { encoding: "utf8" }
      );
      return output.split(/\s+/).map(positivePid).filter(Boolean);
    } catch {
      throw new Error("Could not inspect listening processes");
    }
  }
  const found = new Set();
  for (const port of ports) {
    try {
      const output = exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
      for (const pid of output.split(/\s+/).map(positivePid).filter(Boolean)) found.add(pid);
    } catch (error) {
      if (error?.status === 1 && !String(error?.stdout || "").trim()) continue;
      throw new Error("Could not inspect listening processes");
    }
  }
  return [...found];
}

function processState(pid, exec = execFileSync) {
  if (process.platform === "win32") return processIsAlive(pid) ? "R" : "";
  try {
    return exec("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
  } catch {
    return processIsAlive(pid) ? "?" : "";
  }
}

function processIsActive(pid, exec = execFileSync) {
  const state = processState(pid, exec);
  return Boolean(state) && !state.startsWith("Z");
}

function processGroupPids(groupId, exec = execFileSync) {
  if (process.platform === "win32") return [];
  try {
    return exec("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(positivePid))
      .filter(([pid, pgid]) => pid && pgid === groupId)
      .map(([pid]) => pid);
  } catch {
    throw new Error(`Could not inspect runtime process group ${groupId}`);
  }
}

function configuredStatePath(appDir) {
  const env = loadAppEnv(appDir, { ...process.env });
  const dataDir = resolve(appDir, env.RIOS_DATA_DIR || "data");
  return resolve(appDir, env.RIOS_STATE_DIR || join(dataDir, "runtime"), "processes.json");
}

export function listenerOwnershipUnreadable(snapshot, platform = process.platform) {
  return platform === "win32" ? !snapshot.command : !snapshot.cwd;
}

export function discoverInstallRuntime({
  appDir,
  statePath,
  ports = configuredPorts(appDir),
  preservePids = [],
  exec = execFileSync
} = {}) {
  const candidates = new Map();
  const preserved = new Set(preservePids.map(positivePid).filter(Boolean));
  const add = (pid, reason, group = false) => {
    if (!pid || pid === process.pid || preserved.has(pid)) return;
    const record = candidates.get(pid) || { pid, reasons: new Set(), group: false };
    record.reasons.add(reason);
    record.group ||= group;
    candidates.set(pid, record);
  };

  const state = existsSync(statePath) ? readRuntimeState(statePath) : null;
  for (const child of Array.isArray(state?.children) ? state.children : []) {
    add(positivePid(child.pid), "runtime-state", true);
  }
  add(positivePid(state?.parentPid), "runtime-state", false);

  for (const row of processRows(exec)) {
    if (runtimeCommand(row.command)) add(row.pid, "runtime-command", false);
  }
  for (const pid of listeningPids(ports, exec)) add(pid, "listener", false);

  const owned = [];
  for (const record of candidates.values()) {
    if (!processIsActive(record.pid, exec)) continue;
    const snapshot = processSnapshot(record.pid, exec);
    if (
      record.reasons.has("listener") &&
      listenerOwnershipUnreadable(snapshot)
    ) {
      if (!processIsActive(record.pid, exec)) continue;
      throw new Error(`Could not inspect listener process ${record.pid}`);
    }
    if (processBelongsToApp(snapshot, appDir)) {
      const identity = processStartIdentity(record.pid, exec);
      if (!identity && processIsActive(record.pid, exec)) {
        throw new Error(`Could not identify runtime process ${record.pid}`);
      }
      owned.push({ pid: record.pid, group: record.group, identity, appDir });
      continue;
    }
    if (
      record.reasons.has("runtime-state") &&
      !snapshot.cwd &&
      !snapshot.command &&
      processIsActive(record.pid, exec)
    ) {
      throw new Error(`Could not verify saved runtime process ${record.pid}`);
    }
    if (
      record.reasons.has("runtime-command") &&
      !snapshot.cwd &&
      runtimeCommand(snapshot.command) &&
      processIsActive(record.pid, exec)
    ) {
      throw new Error(`Could not verify runtime process ${record.pid}`);
    }
  }
  return owned;
}

function currentOwnedProcesses(record, exec = execFileSync) {
  const rootActive = processIsActive(record.pid, exec);
  if (rootActive) {
    if (!record.identity || processStartIdentity(record.pid, exec) !== record.identity) return [];
    if (!processBelongsToApp(processSnapshot(record.pid, exec), record.appDir)) return [];
  }
  const pids = new Set(rootActive ? [record.pid] : []);
  if (record.group) {
    for (const pid of processGroupPids(record.pid, exec)) pids.add(pid);
  }
  const current = [];
  for (const pid of pids) {
    if (!processIsActive(pid, exec)) continue;
    const snapshot = processSnapshot(pid, exec);
    if (!processBelongsToApp(snapshot, record.appDir)) {
      if (!processIsActive(pid, exec)) continue;
      throw new Error(`Could not verify runtime process ${pid} in group ${record.pid}`);
    }
    const identity = processStartIdentity(pid, exec);
    if (!identity) {
      if (!processIsActive(pid, exec)) continue;
      throw new Error(`Could not identify runtime process ${pid}`);
    }
    if (pid === record.pid && identity !== record.identity) return [];
    current.push({ pid, identity, appDir: record.appDir });
  }
  return current;
}

function processRecordIsCurrent(record, exec = execFileSync) {
  return currentOwnedProcesses(record, exec).length > 0;
}

function signal(record, signalName, kill = process.kill, exec = execFileSync) {
  const current = currentOwnedProcesses(record, exec);
  if (current.length === 0) return;
  if (process.platform === "win32") {
    for (const member of current) {
      if (processStartIdentity(member.pid, exec) !== member.identity) continue;
      const args = windowsTreeTerminationArgs(member.pid, signalName);
      try {
        exec("taskkill.exe", args, { stdio: "ignore" });
      } catch (error) {
        if (processIsActive(member.pid, exec)) throw error;
      }
    }
    return;
  }
  if (record.group && process.platform !== "win32" && current.some(({ pid }) => pid === record.pid)) {
    try {
      kill(-record.pid, signalName);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return;
  }
  for (const member of current) {
    if (!processIsActive(member.pid, exec)) continue;
    if (processStartIdentity(member.pid, exec) !== member.identity) continue;
    if (!processBelongsToApp(processSnapshot(member.pid, exec), member.appDir)) continue;
    try {
      kill(member.pid, signalName);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

export function windowsTreeTerminationArgs(pid, signalName) {
  const args = ["/PID", String(pid), "/T"];
  if (signalName === "SIGKILL") args.push("/F");
  return args;
}

async function waitUntilExited(records, timeoutMs, exec) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (records.every((record) => !processRecordIsCurrent(record, exec))) return true;
    await delay(100);
  }
  return records.every((record) => !processRecordIsCurrent(record, exec));
}

export async function stopExistingInstallRuntime({
  appDir,
  statePath = configuredStatePath(appDir),
  graceMs = 5_000,
  forceMs = 2_000,
  ports = configuredPorts(appDir),
  preservePids = [],
  exec = execFileSync,
  kill = process.kill
} = {}) {
  for (let pass = 0; pass < 3; pass += 1) {
    const records = discoverInstallRuntime({ appDir, statePath, ports, preservePids, exec });
    if (records.length === 0) {
      await delay(100);
      if (discoverInstallRuntime({ appDir, statePath, ports, preservePids, exec }).length === 0) return [];
      continue;
    }

    for (const record of records) signal(record, "SIGTERM", kill, exec);
    await waitUntilExited(records, graceMs, exec);
    const remaining = records.filter((record) => processRecordIsCurrent(record, exec));
    for (const record of remaining) signal(record, "SIGKILL", kill, exec);
    if (!(await waitUntilExited(remaining, forceMs, exec))) {
      throw new Error("The existing app runtime did not stop");
    }
  }
  throw new Error("The existing app runtime restarted during installation");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--app-dir") options.appDir = argv[++index];
    else if (argv[index] === "--grace-ms") options.graceMs = Number(argv[++index]);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.appDir || !isAbsolute(options.appDir)) {
    throw new Error("Usage: stop-existing-install.mjs --app-dir <absolute path>");
  }
  await stopExistingInstallRuntime({ appDir: resolve(options.appDir), graceMs: options.graceMs });
}

function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
