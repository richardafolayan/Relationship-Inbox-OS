import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  portConflict,
  processBelongsToApp,
  processBelongsToTovi,
  processIsAlive,
  processSnapshot,
  reclaimPortConflict,
  readRuntimeState,
  recoverPriorRuntime,
  removeRuntimeState,
  stopChildGroups,
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

test("processBelongsToTovi recognizes product checkouts without trusting unrelated node processes", () => {
  const appDir = mkdtempSync(join(tmpdir(), "rios-product-"));
  try {
    mkdirSync(join(appDir, "scripts"));
    mkdirSync(join(appDir, "apps", "dashboard"), { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os" }));
    writeFileSync(join(appDir, "scripts", "start-app.mjs"), "");
    assert.equal(processBelongsToTovi({ pid: 10, cwd: join(appDir, "apps", "dashboard"), command: "node" }), true);
    assert.equal(processBelongsToTovi({ pid: 10, cwd: "/tmp", command: "node server.js" }), false);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
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

test("reclaimPortConflict stops only a verified Tovi process tree", async () => {
  const appDir = mkdtempSync(join(tmpdir(), "rios-product-"));
  mkdirSync(join(appDir, "scripts"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os" }));
  writeFileSync(join(appDir, "scripts", "start-app.mjs"), "");
  const child = spawn(process.execPath, ["-e", "const s=require('node:http').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "ignore"]
  });
  try {
    const port = await new Promise((resolvePort) => child.stdout.once("data", (chunk) => resolvePort(chunk.toString().trim())));
    const conflict = portConflict(port, "/another/tovi/install");
    assert.equal(conflict.owners.every((owner) => owner.toviOwned), true);
    const result = await reclaimPortConflict(conflict, { graceMs: 100 });
    assert.equal(result.status, "recovered");
    assert.equal(processIsAlive(child.pid), false);
  } finally {
    if (processIsAlive(child.pid)) child.kill("SIGKILL");
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("reclaimPortConflict refuses unverified owners", async () => {
  const result = await reclaimPortConflict({
    port: "3100",
    owners: [{ pid: process.pid, toviOwned: false }]
  });
  assert.equal(result.status, "refused");
  assert.equal(processIsAlive(process.pid), true);
});

test("reclaimPortConflict accepts a verified owner that exited during recovery", async () => {
  const result = await reclaimPortConflict({
    port: "64999",
    owners: [{ pid: 999999, toviOwned: true }]
  });
  assert.deepEqual(result, { status: "recovered", stopped: [] });
});

test("stopChildGroups kills descendants after their group leader exits", {
  skip: process.platform === "win32"
}, async () => {
  const descendantScript = [
    "process.on('SIGTERM', () => {})",
    "process.stdout.write(String(process.pid))",
    "setInterval(() => {}, 1000)"
  ].join(";");
  const leaderScript = [
    'const { spawn } = require("node:child_process")',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "inherit", "ignore"] })`,
    'process.on("SIGTERM", () => process.exit(0))',
    "setInterval(() => {}, 1000)"
  ].join(";");
  const leader = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
  let descendantPid;
  try {
    descendantPid = Number(await new Promise((resolvePid) => {
      leader.stdout.once("data", (chunk) => resolvePid(chunk.toString()));
    }));
    assert.equal(processIsAlive(descendantPid), true);
    await stopChildGroups([{ name: "service", pid: leader.pid }], { graceMs: 100 });
    const deadline = Date.now() + 1000;
    while (processIsAlive(descendantPid) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.equal(processIsAlive(descendantPid), false);
  } finally {
    if (processIsAlive(leader.pid)) process.kill(-leader.pid, "SIGKILL");
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  }
});
