import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  acquireProcessLock,
  inspectProcessLock,
  releaseProcessLock
} from "../scripts/lib/install-maintenance.mjs";
import { stopExistingInstallRuntime } from "../scripts/stop-existing-install.mjs";

function fixture(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    directory,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function commandMatches(args, value) {
  return args.some((arg) => String(arg).includes(value));
}

test("process locks are exclusive, token-owned, and self-clean stale owners", () => {
  const { directory, cleanup } = fixture("tovi-process-lock-");
  try {
    const lockPath = join(directory, "maintenance.lock");
    const token = acquireProcessLock(lockPath, { ownerPid: process.pid, token: "owner-token" });
    assert.equal(token, "owner-token");
    assert.equal(inspectProcessLock(lockPath).status, "active");
    assert.throws(() => acquireProcessLock(lockPath), /already changing/i);
    assert.equal(releaseProcessLock(lockPath, "wrong-token"), false);
    assert.equal(releaseProcessLock(lockPath, token), true);
    assert.equal(existsSync(lockPath), false);

    acquireProcessLock(lockPath, { ownerPid: 2_147_483_647, token: "stale-token" });
    assert.equal(inspectProcessLock(lockPath).status, "stale");
    assert.equal(existsSync(lockPath), false);

    writeFileSync(lockPath, "not-json");
    assert.equal(inspectProcessLock(lockPath).status, "invalid");
    assert.equal(existsSync(lockPath), true, "an invalid lock must fail closed");
  } finally {
    cleanup();
  }
});

test("shutdown fails closed without signalling when listener ownership is unreadable", async () => {
  const signalled = [];
  const fakeExec = (command, args) => {
    if (command === "ps" && commandMatches(args, "pid=,command=")) return "";
    if (command === "lsof" && commandMatches(args, "-iTCP:43101")) return "4242\n";
    if (command === "ps" && commandMatches(args, "stat=")) return "S\n";
    if (command === "lsof" && commandMatches(args, "cwd")) {
      const error = new Error("permission denied");
      error.status = 1;
      throw error;
    }
    if (command === "ps" && commandMatches(args, "command=")) return "/usr/bin/foreign-service\n";
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  await assert.rejects(
    stopExistingInstallRuntime({
      appDir: "/Applications/Tovi-test",
      statePath: "/nonexistent/processes.json",
      ports: [43101],
      graceMs: 0,
      forceMs: 0,
      exec: fakeExec,
      kill(pid, signal) {
        signalled.push([pid, signal]);
      }
    }),
    /Could not inspect listener process 4242/
  );
  assert.deepEqual(signalled, []);
});

test("shutdown revalidates process identity before every signal", async () => {
  const signalled = [];
  let processListReads = 0;
  let identityReads = 0;
  const fakeExec = (command, args) => {
    if (command === "ps" && commandMatches(args, "pid=,command=")) {
      processListReads += 1;
      return processListReads === 1
        ? "4243 /usr/bin/node /Applications/Tovi-test/scripts/start-app.mjs\n"
        : "";
    }
    if (command === "lsof" && commandMatches(args, "-iTCP:")) return "";
    if (command === "ps" && commandMatches(args, "stat=")) return "S\n";
    if (command === "lsof" && commandMatches(args, "cwd")) return "n/Applications/Tovi-test\n";
    if (command === "ps" && commandMatches(args, "command=")) {
      return "/usr/bin/node /Applications/Tovi-test/scripts/start-app.mjs\n";
    }
    if (command === "ps" && commandMatches(args, "lstart=")) {
      identityReads += 1;
      return identityReads === 1 ? "identity-before\n" : "identity-after-reuse\n";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  await stopExistingInstallRuntime({
    appDir: "/Applications/Tovi-test",
    statePath: "/nonexistent/processes.json",
    ports: [43102],
    graceMs: 0,
    forceMs: 0,
    exec: fakeExec,
    kill(pid, signal) {
      signalled.push([pid, signal]);
    }
  });
  assert.deepEqual(signalled, [], "a reused PID must never receive either signal");
});

test("shutdown waits for and force-stops a surviving detached group member", { skip: process.platform === "win32" }, async () => {
  const { directory, cleanup } = fixture("tovi-runtime-group-");
  let launcher;
  let grandchildPid;
  try {
    launcher = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
           cwd: process.cwd(), stdio: "ignore"
         });
         process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25));
         process.send(child.pid);
         setInterval(() => {}, 1000);`
      ],
      { cwd: directory, detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] }
    );
    grandchildPid = await new Promise((resolvePid, reject) => {
      launcher.once("message", resolvePid);
      launcher.once("error", reject);
      launcher.once("exit", (code, signal) => reject(new Error(`launcher exited early (${code ?? signal})`)));
    });
    const stateDir = join(directory, "runtime");
    const statePath = join(stateDir, "processes.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        parentPid: launcher.pid,
        children: [{ name: "runner", pid: launcher.pid }]
      }),
      { flush: true }
    );

    await stopExistingInstallRuntime({
      appDir: directory,
      statePath,
      ports: [43105],
      graceMs: 150,
      forceMs: 1_000
    });

    const state = (() => {
      try {
        return execFileSync("ps", ["-p", String(grandchildPid), "-o", "stat="], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
    assert.ok(!state || state.startsWith("Z"), `surviving group member is still active (${state})`);
  } finally {
    if (launcher?.pid) {
      try {
        process.kill(-launcher.pid, "SIGKILL");
      } catch {}
    }
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {}
    }
    cleanup();
  }
});

test("database-only preparation refuses a pre-bind runtime", { skip: process.platform === "win32" }, async () => {
  const { directory, cleanup } = fixture("tovi-database-only-runtime-");
  const sourceAppDir = resolve(".");
  const appDir = join(directory, "app");
  let runtime;
  try {
    cpSync(join(sourceAppDir, "scripts"), join(appDir, "scripts"), { recursive: true });
    mkdirSync(join(appDir, "apps", "desktop"), { recursive: true });
    cpSync(
      join(sourceAppDir, "apps", "desktop", "phone-access.cjs"),
      join(appDir, "apps", "desktop", "phone-access.cjs")
    );
    cpSync(join(sourceAppDir, "package.json"), join(appDir, "package.json"));
    runtime = spawn(
      process.execPath,
      [
        "-e",
        "if (process.send) process.send('ready'); setInterval(() => {}, 1000)",
        join(appDir, "scripts", "start-app.mjs")
      ],
      { cwd: appDir, stdio: ["ignore", "ignore", "inherit", "ipc"] }
    );
    await new Promise((resolveReady, reject) => {
      runtime.once("message", resolveReady);
      runtime.once("error", reject);
      runtime.once("exit", (code, signal) => reject(new Error(`runtime exited early (${code ?? signal})`)));
    });

    const databasePath = join(directory, "inbox-os.sqlite");
    const result = await new Promise((resolveResult) => {
      const child = spawn(process.execPath, [join(appDir, "scripts", "start-app.mjs"), "--database-only"], {
        cwd: appDir,
        env: {
          ...process.env,
          DASHBOARD_PORT: "43103",
          RUNNER_PORT: "43104",
          DATABASE_URL: `file:${databasePath}`,
          RIOS_DATA_DIR: directory,
          RIOS_STATE_DIR: join(directory, "runtime")
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /still running|already running/i);
    assert.equal(existsSync(databasePath), false, "preparation must not touch the database");
  } finally {
    if (runtime?.pid) {
      try {
        process.kill(runtime.pid, "SIGKILL");
      } catch {}
    }
    cleanup();
  }
});
