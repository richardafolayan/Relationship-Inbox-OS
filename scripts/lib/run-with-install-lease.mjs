#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acquireProcessLockLease,
  installPreparationPath,
  releaseProcessLockLease
} from "./install-maintenance.mjs";
import {
  processGroupIsAlive,
  processIsAlive,
  processStartIdentity
} from "./process-lifecycle.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function stopWindowsTree(pid) {
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch (error) {
    if (processIsAlive(pid)) throw error;
  }
}

function signalProcessGroup(pid, signalName) {
  try {
    process.kill(-pid, signalName);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopProtectedTree(pid) {
  if (process.platform === "win32") {
    stopWindowsTree(pid);
    const deadline = Date.now() + 2_000;
    while (processIsAlive(pid) && Date.now() < deadline) await delay(50);
    return !processIsAlive(pid);
  }

  if (processGroupIsAlive(pid)) signalProcessGroup(pid, "SIGTERM");
  let deadline = Date.now() + 2_000;
  while (processGroupIsAlive(pid) && Date.now() < deadline) await delay(50);
  if (processGroupIsAlive(pid)) signalProcessGroup(pid, "SIGKILL");
  deadline = Date.now() + 2_000;
  while (processGroupIsAlive(pid) && Date.now() < deadline) await delay(50);
  return !processGroupIsAlive(pid);
}

async function protectedProcessIdentity(pid) {
  const deadline = Date.now() + 2_000;
  while (processIsAlive(pid) && Date.now() < deadline) {
    const identity = processStartIdentity(pid);
    if (identity) return identity;
    await delay(25);
  }
  return "";
}

async function childGate(command, commandArgs) {
  if (!process.send || !command) throw new Error("The installation child gate requires IPC and a command");
  let started = false;
  let commandProcess = null;

  process.once("disconnect", () => {
    if (!started) {
      process.exit(1);
      return;
    }
    if (process.platform === "win32") {
      try {
        stopWindowsTree(process.pid);
      } catch {
        process.exit(1);
      }
      return;
    }
    signalProcessGroup(process.pid, "SIGTERM");
  });

  process.on("message", (message) => {
    if (message !== "run" || started) return;
    started = true;
    try {
      commandProcess = spawn(command, commandArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit"
      });
    } catch (error) {
      process.send?.({ type: "result", code: 1, error: error.message });
      return;
    }
    commandProcess.once("error", (error) => {
      process.send?.({ type: "result", code: 1, error: error.message });
    });
    commandProcess.once("exit", (code, signalName) => {
      process.send?.({ type: "result", code: signalName ? 1 : code ?? 1, signalName });
    });
  });

  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signalName, () => {
      try {
        commandProcess?.kill(signalName);
      } catch {}
      process.removeAllListeners(signalName);
      process.kill(process.pid, signalName);
    });
  }
  process.send({ type: "ready" });
  await new Promise(() => {});
}

function parseCommandLine() {
  const separator = process.argv.indexOf("--", 2);
  const options = process.argv.slice(2, separator < 0 ? undefined : separator);
  let appDir = "";
  let token = "";
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === "--app-dir") appDir = options[++index] || "";
    else if (options[index] === "--token") token = options[++index] || "";
  }
  return {
    appDir,
    token,
    command: separator >= 0 ? process.argv[separator + 1] : "",
    commandArgs: separator >= 0 ? process.argv.slice(separator + 2) : []
  };
}

async function runWithLease() {
  const { appDir, token, command, commandArgs } = parseCommandLine();
  if (!appDir || !isAbsolute(appDir) || !token || !command) {
    throw new Error(
      "Usage: run-with-install-lease.mjs --app-dir <absolute path> --token <token> -- <command> [args]"
    );
  }

  const lockPath = installPreparationPath(resolve(appDir));
  let leasePath = acquireProcessLockLease(lockPath, token);
  let protectedLeasePath = "";
  let gate = null;
  let treeStopped = false;
  try {
    gate = spawn(process.execPath, [SCRIPT_PATH, "--child-gate", command, ...commandArgs], {
      cwd: process.cwd(),
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    });
    await new Promise((resolveReady, rejectReady) => {
      gate.on("message", (message) => {
        if (message?.type === "ready") resolveReady();
      });
      gate.once("error", rejectReady);
      gate.once("exit", (code, signalName) => {
        rejectReady(new Error(`Installation child gate exited (${code ?? signalName})`));
      });
    });

    const protectedOptions = process.platform === "win32"
      ? {
          protectedPid: gate.pid,
          protectedIdentity: await protectedProcessIdentity(gate.pid)
        }
      : { protectedGroupPid: gate.pid };
    protectedLeasePath = acquireProcessLockLease(lockPath, token, protectedOptions);
    releaseProcessLockLease(leasePath);
    leasePath = "";

    const commandResult = new Promise((resolveResult, rejectResult) => {
      gate.on("message", (message) => {
        if (message?.type === "result") resolveResult(message);
      });
      gate.once("error", rejectResult);
      gate.once("exit", (code, signalName) => {
        rejectResult(new Error(`Installation child gate exited before reporting (${code ?? signalName})`));
      });
    });
    gate.send("run");
    const result = await commandResult;
    if (result.error) process.stderr.write(`${result.error}\n`);
    treeStopped = await stopProtectedTree(gate.pid);
    if (!treeStopped) throw new Error("An installation worker process did not stop");
    releaseProcessLockLease(protectedLeasePath);
    protectedLeasePath = "";
    process.exitCode = Number.isInteger(result.code) ? result.code : 1;
  } finally {
    if (gate?.pid && !treeStopped) {
      try {
        treeStopped = await stopProtectedTree(gate.pid);
      } catch {}
    }
    if (leasePath) releaseProcessLockLease(leasePath);
    if (protectedLeasePath && treeStopped) releaseProcessLockLease(protectedLeasePath);
  }
}

if (process.argv[2] === "--child-gate") {
  await childGate(process.argv[3] || "", process.argv.slice(4));
} else {
  await runWithLease();
}
