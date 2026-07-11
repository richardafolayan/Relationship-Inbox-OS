import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  portConflict,
  processBelongsToApp,
  processIsAlive,
  processSnapshot,
  readRuntimeState,
  recoverPriorRuntime,
  removeRuntimeState,
  writeRuntimeState
} from "../scripts/lib/process-lifecycle.mjs";

// The desktop app decides whether to reclaim, refuse, or clean up a prior
// launch entirely from this module, so its ownership checks are pinned here.

test("runtime state round-trips and rejects unknown shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-lifecycle-"));
  const statePath = join(dir, "processes.json");
  try {
    const state = { version: 1, parentPid: process.pid, children: [{ name: "runner", pid: 1234 }] };
    writeRuntimeState(statePath, state);
    assert.deepEqual(readRuntimeState(statePath).children, state.children);
    assert.match(readFileSync(statePath, "utf8"), /"parentPid"/);

    writeRuntimeState(statePath, { version: 2, parentPid: process.pid });
    assert.equal(readRuntimeState(statePath), null);
    writeRuntimeState(statePath, { version: 1, parentPid: "not a pid" });
    assert.equal(readRuntimeState(statePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeRuntimeState only removes state owned by the calling launcher", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-lifecycle-"));
  const statePath = join(dir, "processes.json");
  try {
    writeRuntimeState(statePath, { version: 1, parentPid: process.pid + 1, children: [] });
    assert.equal(removeRuntimeState(statePath, process.pid), false);
    assert.ok(existsSync(statePath));
    assert.equal(removeRuntimeState(statePath, process.pid + 1), true);
    assert.ok(!existsSync(statePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processIsAlive detects live pids and treats EPERM as alive", () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(-5), false);
  assert.equal(processIsAlive("junk"), false);
  const denied = () => {
    const error = new Error("kill EPERM");
    error.code = "EPERM";
    throw error;
  };
  assert.equal(processIsAlive(1234, denied), true);
});

test("processBelongsToApp requires the cwd or command to sit inside the app", () => {
  const appDir = "/opt/rios-app";
  assert.equal(processBelongsToApp({ pid: 10, cwd: "/opt/rios-app", command: "node" }, appDir), true);
  assert.equal(processBelongsToApp({ pid: 10, cwd: "/opt/rios-app/apps/runner", command: "node" }, appDir), true);
  assert.equal(processBelongsToApp({ pid: 10, cwd: "/opt/rios-application", command: "node" }, appDir), false);
  assert.equal(processBelongsToApp({ pid: 10, cwd: "", command: "node /opt/rios-app/scripts/start-app.mjs" }, appDir), true);
  assert.equal(processBelongsToApp({ pid: 10, cwd: "/elsewhere", command: "node server.js" }, appDir), false);
  assert.equal(processBelongsToApp(null, appDir), false);
});

test("recoverPriorRuntime cleans stale state and reclaims owned processes", async () => {
  const appDir = mkdtempSync(join(tmpdir(), "rios-appdir-"));
  const statePath = join(appDir, "processes.json");
  try {
    // No state file at all.
    assert.equal((await recoverPriorRuntime({ statePath, appDir })).status, "none");

    // A dead pid is stale state, removed without touching anything.
    writeRuntimeState(statePath, { version: 1, parentPid: 999999, children: [] });
    assert.equal((await recoverPriorRuntime({ statePath, appDir })).status, "stale");
    assert.ok(!existsSync(statePath));

    // A live process owned by the app dir: refused without reclaim, then
    // stopped with reclaim so a fresh launch can proceed.
    const child = spawn("sleep", ["30"], { cwd: appDir, stdio: "ignore" });
    await new Promise((resolveSpawn) => child.once("spawn", resolveSpawn));
    writeRuntimeState(statePath, { version: 1, parentPid: child.pid, children: [] });

    const refused = await recoverPriorRuntime({ statePath, appDir, reclaim: false });
    assert.equal(refused.status, "already_running");
    assert.ok(existsSync(statePath));

    const reclaimed = await recoverPriorRuntime({ statePath, appDir, reclaim: true, graceMs: 200 });
    assert.equal(reclaimed.status, "recovered");
    assert.deepEqual(reclaimed.recovered, ["launcher"]);
    assert.ok(!existsSync(statePath));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.equal(processIsAlive(child.pid), false);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("recoverPriorRuntime does not reclaim a foreign process with a recycled pid", async () => {
  const appDir = mkdtempSync(join(tmpdir(), "rios-appdir-"));
  const foreignDir = mkdtempSync(join(tmpdir(), "rios-foreign-"));
  const statePath = join(appDir, "processes.json");
  const child = spawn("sleep", ["30"], { cwd: foreignDir, stdio: "ignore" });
  try {
    await new Promise((resolveSpawn) => child.once("spawn", resolveSpawn));
    writeRuntimeState(statePath, { version: 1, parentPid: child.pid, children: [] });
    const result = await recoverPriorRuntime({ statePath, appDir, reclaim: true, graceMs: 100 });
    // The pid is alive but belongs to another program, so it is treated as
    // stale bookkeeping, never killed.
    assert.equal(result.status, "stale");
    assert.equal(processIsAlive(child.pid), true);
  } finally {
    child.kill("SIGKILL");
    rmSync(appDir, { recursive: true, force: true });
    rmSync(foreignDir, { recursive: true, force: true });
  }
});

test("processSnapshot and portConflict tolerate missing tools and processes", () => {
  const snapshot = processSnapshot(999999, () => {
    throw new Error("lsof unavailable");
  });
  assert.deepEqual(snapshot, { pid: 999999, cwd: "", command: "" });
  assert.equal(processSnapshot("junk").pid, null);
  // An unused high port has no owners.
  assert.equal(portConflict(64999, "/nonexistent"), null);
});
