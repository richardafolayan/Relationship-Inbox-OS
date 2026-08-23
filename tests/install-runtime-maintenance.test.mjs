import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  acquireProcessLock,
  acquireInstallOperation,
  acquireInstallPreparation,
  installMaintenancePath,
  installOperationPath,
  installPreparationPath,
  inspectInstallOperation,
  inspectProcessLock,
  processLockMutationClaimPath,
  releaseInstallOperation,
  releaseInstallPreparation,
  releaseProcessLock
} from "../scripts/lib/install-maintenance.mjs";
import { processBelongsToApp, processStartIdentity } from "../scripts/lib/process-lifecycle.mjs";
import {
  updateControlAncestorPids,
  updateControlCommand
} from "../scripts/lib/update-ancestors.mjs";
import {
  discoverInstallRuntime,
  listenerOwnershipUnreadable,
  stopExistingInstallRuntime,
  windowsTreeTerminationArgs
} from "../scripts/stop-existing-install.mjs";

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

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", resolveExit));
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

    acquireProcessLock(lockPath, {
      ownerPid: 2_147_483_647,
      ownerIdentity: "stale-owner",
      token: "stale-token"
    });
    assert.equal(inspectProcessLock(lockPath).status, "stale");
    assert.equal(existsSync(lockPath), false);

    acquireProcessLock(lockPath, {
      ownerPid: process.pid,
      ownerIdentity: "identity-from-reused-pid",
      token: "reused-token"
    });
    assert.equal(inspectProcessLock(lockPath).status, "stale");
    assert.equal(existsSync(lockPath), false, "a reused owner PID must not pin the lock");

    writeFileSync(lockPath, "not-json");
    assert.equal(inspectProcessLock(lockPath).status, "invalid");
    assert.equal(existsSync(lockPath), true, "an invalid lock must fail closed");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    assert.equal(inspectProcessLock(lockPath).status, "stale");
    assert.equal(existsSync(lockPath), false, "an abandoned partial lock must self-heal");
  } finally {
    cleanup();
  }
});

test("concurrent lock contenders leave exactly one live owner", async () => {
  const { directory, cleanup } = fixture("tovi-process-lock-race-");
  const appDir = join(directory, "Tovi");
  const helper = resolve("scripts/install-maintenance.mjs");
  mkdirSync(appDir);
  try {
    const contenders = Array.from({ length: 12 }, (_, index) => new Promise((resolveResult) => {
      const token = `contender-${index}`;
      const child = spawn(process.execPath, [
        helper,
        "acquire-operation",
        "--app-dir",
        appDir,
        "--owner-pid",
        String(process.pid),
        "--token",
        token
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolveResult({ code, stdout, stderr, token }));
    }));
    const results = await Promise.all(contenders);
    const winners = results.filter(({ code }) => code === 0);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(winners[0].stdout.trim(), winners[0].token);
    assert.equal(inspectInstallOperation(appDir).status, "active");
    assert.equal(releaseInstallOperation(appDir, winners[0].token), true);
    assert.equal(existsSync(installOperationPath(appDir)), false);
  } finally {
    cleanup();
  }
});

test("stale-lock contenders cannot delete a newly published winner", async () => {
  const { directory, cleanup } = fixture("tovi-stale-process-lock-race-");
  const appDir = join(directory, "Tovi");
  const helper = resolve("scripts/install-maintenance.mjs");
  mkdirSync(appDir);
  try {
    acquireInstallOperation(appDir, {
      ownerPid: 2_147_483_647,
      ownerIdentity: "stale-owner",
      token: "stale-token"
    });
    const contenders = Array.from({ length: 12 }, (_, index) => new Promise((resolveResult) => {
      const token = `stale-contender-${index}`;
      const child = spawn(process.execPath, [
        helper,
        "acquire-operation",
        "--app-dir",
        appDir,
        "--owner-pid",
        String(process.pid),
        "--token",
        token
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolveResult({ code, stdout, stderr, token }));
    }));
    const results = await Promise.all(contenders);
    const winners = results.filter(({ code }) => code === 0);
    assert.ok(winners.length <= 1, JSON.stringify(results));
    const winnerToken = winners[0]?.token || acquireInstallOperation(appDir, { token: "retry-winner" });
    assert.equal(inspectInstallOperation(appDir, winnerToken).status, "owner");
    assert.equal(releaseInstallOperation(appDir, winnerToken), true);
  } finally {
    cleanup();
  }
});

test("an in-flight unlink claim blocks publication until every late unlink is finished", () => {
  const { directory, cleanup } = fixture("tovi-process-lock-unlink-claim-");
  const lockPath = join(directory, "maintenance.lock");
  try {
    const oldToken = acquireProcessLock(lockPath, { token: "old-owner" });
    const delayedClaim = processLockMutationClaimPath(lockPath, { nonce: "delayed-reclaimer" });
    linkSync(lockPath, delayedClaim);

    assert.equal(releaseProcessLock(lockPath, oldToken), true);
    assert.equal(existsSync(lockPath), false);
    assert.throws(
      () => acquireProcessLock(lockPath, { token: "too-early" }),
      /already changing/i
    );

    rmSync(lockPath, { force: true });
    rmSync(delayedClaim, { force: true });
    const winner = acquireProcessLock(lockPath, { token: "new-winner" });
    assert.equal(inspectProcessLock(lockPath, winner).status, "owner");
    assert.equal(releaseProcessLock(lockPath, winner), true);
  } finally {
    cleanup();
  }
});

test("packaged install locks are always outside the signed app bundle", () => {
  const { directory, cleanup } = fixture("tovi-packaged-lock-path-");
  try {
    const bundle = join(directory, "Tovi.app");
    const appDir = join(bundle, "Contents", "Resources", "app");
    const configDir = join(directory, "Application Support", "Tovi");
    const defaultMaintenance = installMaintenancePath(appDir, {});
    const configuredMaintenance = installMaintenancePath(appDir, { RIOS_CONFIG_DIR: configDir });
    const configuredOperation = installOperationPath(appDir, { RIOS_CONFIG_DIR: configDir });

    assert.ok(!defaultMaintenance.startsWith(`${bundle}/`));
    assert.equal(configuredMaintenance, defaultMaintenance);
    assert.ok(!configuredOperation.startsWith(`${bundle}/`));
    assert.notEqual(configuredMaintenance, configuredOperation);
  } finally {
    cleanup();
  }
});

test("packaged preparation locks remain writable when the bundle parent is read-only", () => {
  const { directory, cleanup } = fixture("tovi-readonly-bundle-lock-");
  const bundle = join(directory, "Applications", "Tovi.app");
  const appDir = join(bundle, "Contents", "Resources", "app");
  mkdirSync(appDir, { recursive: true });
  chmodSync(join(directory, "Applications"), 0o555);
  let token = "";
  try {
    assert.ok(!installPreparationPath(appDir).startsWith(`${bundle}/`));
    assert.ok(!installPreparationPath(appDir).startsWith(`${join(directory, "Applications")}/`));
    token = acquireInstallPreparation(appDir);
    assert.equal(releaseInstallPreparation(appDir, token), true);
    token = "";
  } finally {
    if (token) releaseInstallPreparation(appDir, token);
    chmodSync(join(directory, "Applications"), 0o755);
    cleanup();
  }
});

test("install locks are identical across environment and symlink aliases", () => {
  const { directory, cleanup } = fixture("tovi-lock-alias-");
  const appDir = join(directory, "Tovi");
  const aliasDir = join(directory, "Tovi-link");
  const helper = resolve("scripts/install-maintenance.mjs");
  mkdirSync(appDir);
  symlinkSync(appDir, aliasDir, "dir");
  let token = "";
  try {
    assert.equal(installOperationPath(aliasDir), installOperationPath(appDir));
    token = execFileSync(process.execPath, [
      helper,
      "acquire-operation",
      "--app-dir",
      aliasDir,
      "--owner-pid",
      String(process.pid),
      "--token",
      "environment-owner"
    ], {
      encoding: "utf8",
      env: { ...process.env, RIOS_CONFIG_DIR: join(directory, "config-a") }
    }).trim();
    assert.equal(token, "environment-owner");
    assert.throws(
      () => execFileSync(process.execPath, [
        helper,
        "acquire-operation",
        "--app-dir",
        appDir,
        "--owner-pid",
        String(process.pid),
        "--token",
        "second-owner"
      ], {
        encoding: "utf8",
        env: { ...process.env, RIOS_CONFIG_DIR: join(directory, "config-b") },
        stdio: "pipe"
      }),
      /already changing/i
    );
  } finally {
    if (token) assert.equal(releaseInstallOperation(appDir, token), true);
    cleanup();
  }
});

test("a missing target keeps the same lock identity after creation under a symlinked parent", () => {
  const { directory, cleanup } = fixture("tovi-missing-lock-alias-");
  const realParent = join(directory, "real-parent");
  const aliasParent = join(directory, "alias-parent");
  const target = join(aliasParent, "Tovi");
  mkdirSync(realParent);
  symlinkSync(realParent, aliasParent, "dir");
  try {
    const before = installOperationPath(target);
    mkdirSync(join(realParent, "Tovi"));
    assert.equal(installOperationPath(target), before);
    assert.equal(installOperationPath(join(realParent, "Tovi")), before);
  } finally {
    cleanup();
  }
});

test("a live inherited preparation lease survives parent death", async () => {
  const { directory, cleanup } = fixture("tovi-preparation-lease-");
  const appDir = join(directory, "Tovi");
  mkdirSync(appDir);
  const parent = spawn("sleep", ["30"], { stdio: "ignore" });
  await new Promise((resolveSpawn) => parent.once("spawn", resolveSpawn));
  const token = acquireInstallPreparation(appDir, { ownerPid: parent.pid, token: "parent-preparation" });
  const moduleUrl = pathToFileURL(resolve("scripts/lib/install-maintenance.mjs")).href;
  const leaseHolder = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import {
       acquireProcessLockLease,
       installPreparationPath,
       releaseProcessLockLease
     } from ${JSON.stringify(moduleUrl)};
     const lease = acquireProcessLockLease(installPreparationPath(${JSON.stringify(appDir)}), ${JSON.stringify(token)});
     process.send({ ready: true });
     setTimeout(() => {
       releaseProcessLockLease(lease);
       process.exit(0);
     }, 700);`
  ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  try {
    await new Promise((resolveReady, reject) => {
      leaseHolder.once("message", resolveReady);
      leaseHolder.once("error", reject);
    });
    parent.kill("SIGKILL");
    await waitForChildExit(parent);
    assert.throws(() => acquireInstallPreparation(appDir), /already changing/i);
    await waitForChildExit(leaseHolder);
    const next = acquireInstallPreparation(appDir, { token: "next-preparation" });
    assert.equal(releaseInstallPreparation(appDir, next), true);
  } finally {
    try { parent.kill("SIGKILL"); } catch {}
    try { leaseHolder.kill("SIGKILL"); } catch {}
    cleanup();
  }
});

test("a killed lease wrapper cannot expose a surviving grandchild to install mutation", async () => {
  if (process.platform === "win32") return;
  const { directory, cleanup } = fixture("tovi-preparation-tree-lease-");
  const appDir = join(directory, "Tovi");
  const pidPath = join(directory, "grandchild.pid");
  const commandPath = join(directory, "spawn-worker.mjs");
  const wrapperPath = resolve("scripts/lib/run-with-install-lease.mjs");
  mkdirSync(appDir);
  writeFileSync(commandPath, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
writeFileSync(${JSON.stringify(pidPath)}, String(grandchild.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  const token = acquireInstallPreparation(appDir, { token: "tree-owner" });
  const wrapper = spawn(process.execPath, [
    wrapperPath,
    "--app-dir",
    appDir,
    "--token",
    token,
    "--",
    process.execPath,
    commandPath
  ], { stdio: "ignore" });
  let grandchildPid = 0;
  let groupId = 0;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.ok(existsSync(pidPath), "the protected grandchild did not start");
    grandchildPid = Number(readFileSync(pidPath, "utf8"));
    groupId = Number(execFileSync("ps", ["-p", String(grandchildPid), "-o", "pgid="], {
      encoding: "utf8"
    }).trim());
    wrapper.kill("SIGKILL");
    await waitForChildExit(wrapper);
    assert.equal(releaseInstallPreparation(appDir, token), true);
    assert.throws(() => acquireInstallPreparation(appDir), /already changing/i);

    process.kill(-groupId, "SIGKILL");
    const stopDeadline = Date.now() + 5_000;
    while (Date.now() < stopDeadline) {
      try {
        process.kill(grandchildPid, 0);
      } catch {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    const next = acquireInstallPreparation(appDir, { token: "after-tree" });
    assert.equal(releaseInstallPreparation(appDir, next), true);
  } finally {
    try { wrapper.kill("SIGKILL"); } catch {}
    if (groupId) {
      try { process.kill(-groupId, "SIGKILL"); } catch {}
    } else if (grandchildPid) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
    }
    cleanup();
  }
});

test("the install-operation lock stays stable while the app directory is renamed", () => {
  const { directory, cleanup } = fixture("tovi-operation-lock-");
  const appDir = join(directory, "Tovi");
  const movedDir = join(directory, "Tovi.previous");
  mkdirSync(appDir);
  const token = acquireInstallOperation(appDir);
  try {
    assert.equal(inspectInstallOperation(appDir).status, "active");
    renameSync(appDir, movedDir);
    assert.equal(inspectInstallOperation(appDir).status, "active");
    assert.throws(() => acquireInstallOperation(appDir), /already changing/i);
  } finally {
    assert.equal(releaseInstallOperation(appDir, token), true);
    cleanup();
  }
});

test("runtime discovery finds the real pre-bind start-student launcher", () => {
  const command = "/usr/bin/node /Applications/Tovi-test/scripts/start-student.mjs";
  const fakeExec = (executable, args) => {
    if (executable === "ps" && commandMatches(args, "pid=,command=")) return `4244 ${command}\n`;
    if (executable === "lsof" && commandMatches(args, "-iTCP:")) return "";
    if (executable === "ps" && commandMatches(args, "stat=")) return "S\n";
    if (executable === "lsof" && commandMatches(args, "cwd")) return "n/Applications/Tovi-test\n";
    if (executable === "ps" && commandMatches(args, "command=")) return `${command}\n`;
    if (executable === "ps" && commandMatches(args, "lstart=")) return "launcher-identity\n";
    throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
  };

  const discovered = discoverInstallRuntime({
    appDir: "/Applications/Tovi-test",
    statePath: "/nonexistent/processes.json",
    ports: [43106],
    exec: fakeExec
  });
  assert.deepEqual(discovered.map(({ pid }) => pid), [4244]);

  const preserved = discoverInstallRuntime({
    appDir: "/Applications/Tovi-test",
    statePath: "/nonexistent/processes.json",
    ports: [43106],
    preservePids: [4244],
    exec: fakeExec
  });
  assert.deepEqual(preserved, []);
});

test("updater ancestry preserves control wrappers but not app runtimes", () => {
  const commands = new Map([
    [4303, "4302 /usr/bin/node /Applications/Tovi/scripts/start-student.mjs"],
    [4302, "4301 npm run start:student"],
    [4301, "4300 /usr/bin/node /Applications/Tovi/scripts/start-app.mjs"],
    [4300, "1 /usr/bin/node /Applications/Tovi/apps/runner/dist/index.js"]
  ]);
  const fakeExec = (command, args) => {
    assert.equal(command, "ps");
    const pid = Number(args[1]);
    return `${commands.get(pid) || ""}\n`;
  };

  assert.equal(updateControlCommand("node C:\\Tovi\\scripts\\apply-update-and-restart.mjs"), true);
  assert.equal(updateControlCommand("node C:\\Tovi\\scripts\\start-app.mjs"), false);
  assert.deepEqual(
    updateControlAncestorPids({ startPid: 4303, platform: "darwin", exec: fakeExec }),
    [4303, 4302]
  );
});

test("command ownership uses path-component boundaries", () => {
  assert.equal(
    processBelongsToApp(
      { pid: 4245, cwd: "", command: "/usr/bin/node /private/tmp/Tovi-old/scripts/start-app.mjs" },
      "/private/tmp/Tovi"
    ),
    false
  );
  assert.equal(
    processBelongsToApp(
      { pid: 4246, cwd: "", command: "/usr/bin/node /private/tmp/Tovi/scripts/start-app.mjs" },
      "/private/tmp/Tovi"
    ),
    true
  );
  for (const copiedName of ["Tovi.app old", "Tovi.app (copy)"]) {
    assert.equal(
      processBelongsToApp(
        { pid: 4247, cwd: "", command: `/usr/bin/node \"/Applications/${copiedName}/Contents/Resources/app/apps/runner/dist/index.js\"` },
        "/Applications/Tovi.app"
      ),
      false,
      `${copiedName} must not be treated as the target app`
    );
  }
});

test("Windows shutdown targets the complete process tree", () => {
  assert.deepEqual(windowsTreeTerminationArgs(4247, "SIGTERM"), ["/PID", "4247", "/T"]);
  assert.deepEqual(windowsTreeTerminationArgs(4247, "SIGKILL"), ["/PID", "4247", "/T", "/F"]);
});

test("listener ownership uses command inspection on Windows", () => {
  assert.equal(
    listenerOwnershipUnreadable({ cwd: "", command: "node C:\\Tovi\\scripts\\start-app.mjs" }, "win32"),
    false
  );
  assert.equal(listenerOwnershipUnreadable({ cwd: "", command: "" }, "win32"), true);
  assert.equal(listenerOwnershipUnreadable({ cwd: "", command: "node /Applications/Tovi/app" }, "darwin"), true);
});

test("packaged desktop shells are part of the owned install runtime", () => {
  const appDir = "/Applications/Tovi.app/Contents/Resources/app";
  const fakeExec = (command, args) => {
    if (command === "ps" && commandMatches(args, "pid=,command=")) {
      return "4246 /Applications/Tovi.app/Contents/MacOS/Tovi\n";
    }
    if (command === "lsof" && commandMatches(args, "-iTCP:")) return "";
    if (command === "ps" && commandMatches(args, "stat=")) return "S\n";
    if (command === "lsof" && commandMatches(args, "cwd")) return "n/\n";
    if (command === "ps" && commandMatches(args, "command=")) {
      return "/Applications/Tovi.app/Contents/MacOS/Tovi\n";
    }
    if (command === "ps" && commandMatches(args, "lstart=")) return "desktop-shell-identity\n";
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  assert.deepEqual(
    discoverInstallRuntime({
      appDir,
      statePath: "/nonexistent/processes.json",
      ports: [43106],
      exec: fakeExec
    }),
    [{ pid: 4246, group: false, identity: "desktop-shell-identity", appDir }]
  );
});

test("desktop backend-only shutdown preserves Electron and ShipIt while stopping owned backends", async () => {
  const appDir = "/Applications/Tovi.app/Contents/Resources/app";
  const alive = new Set([4246, 4247, 4248, 4249]);
  const signalled = [];
  const commandFor = (pid) => ({
    4246: "/Applications/Tovi.app/Contents/MacOS/Tovi",
    4247: "/usr/bin/node /Applications/Tovi.app/Contents/Resources/app/scripts/start-app.mjs",
    4248: "/Applications/Tovi.app/Contents/Frameworks/Tovi Helper (Renderer).app/Contents/MacOS/Tovi Helper (Renderer)",
    4249: "/Applications/Tovi.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt"
  })[pid];
  const fakeExec = (command, args) => {
    if (command === "ps" && commandMatches(args, "pid=,command=")) {
      return [...alive].map((pid) => `${pid} ${commandFor(pid)}`).join("\n");
    }
    if (command === "lsof" && commandMatches(args, "-iTCP:")) return "";
    const pidIndex = args.indexOf("-p");
    const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
    if (command === "ps" && commandMatches(args, "stat=")) return alive.has(pid) ? "S\n" : "";
    if (command === "lsof" && commandMatches(args, "cwd")) {
      return alive.has(pid) ? `n${appDir}\n` : "";
    }
    if (command === "ps" && commandMatches(args, "command=")) {
      return alive.has(pid) ? `${commandFor(pid)}\n` : "";
    }
    if (command === "ps" && commandMatches(args, "lstart=")) {
      return alive.has(pid) ? `identity-${pid}\n` : "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  await stopExistingInstallRuntime({
    appDir,
    statePath: "/nonexistent/processes.json",
    ports: [43108],
    preservePids: [4246],
    includePackagedContainer: false,
    graceMs: 0,
    forceMs: 0,
    exec: fakeExec,
    kill(pid, signal) {
      signalled.push([pid, signal]);
      alive.delete(pid);
    }
  });

  assert.deepEqual(signalled, [[4247, "SIGTERM"]]);
  assert.equal(alive.has(4246), true);
  assert.equal(alive.has(4247), false);
  assert.equal(alive.has(4248), true);
  assert.equal(alive.has(4249), true);
});

test("stopper CLI carries preserve-pid through to runtime discovery", { skip: process.platform === "win32" }, async () => {
  const { directory, cleanup } = fixture("tovi-stopper-cli-preserve-");
  const appDir = join(directory, "app");
  let runtime;
  try {
    mkdirSync(join(appDir, "scripts"), { recursive: true });
    runtime = spawn(
      process.execPath,
      ["-e", "if (process.send) process.send('ready'); setInterval(() => {}, 1000)", join(appDir, "scripts", "start-app.mjs")],
      { cwd: appDir, stdio: ["ignore", "ignore", "inherit", "ipc"] }
    );
    await new Promise((resolveReady, reject) => {
      runtime.once("message", resolveReady);
      runtime.once("error", reject);
      runtime.once("exit", (code, signal) => reject(new Error(`runtime exited early (${code ?? signal})`)));
    });

    const stopper = resolve("scripts/stop-existing-install.mjs");
    const preserved = spawnSync(process.execPath, [
      stopper,
      "--app-dir",
      appDir,
      "--preserve-pid",
      String(runtime.pid),
      "--grace-ms",
      "100"
    ], { encoding: "utf8" });
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.notEqual(processStartIdentity(runtime.pid), "");

    const stopped = spawnSync(process.execPath, [
      stopper,
      "--app-dir",
      appDir,
      "--grace-ms",
      "100"
    ], { encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stderr);
    await waitForChildExit(runtime);
    assert.equal(processStartIdentity(runtime.pid), "");
  } finally {
    if (runtime?.pid) {
      try { process.kill(runtime.pid, "SIGKILL"); } catch {}
    }
    cleanup();
  }
});

test("stopping an owned desktop shell prevents its delayed child relaunch", { skip: process.platform === "win32" }, async () => {
  const { directory, cleanup } = fixture("tovi-desktop-relaunch-");
  const appDir = join(directory, "app");
  const desktopScript = join(appDir, "apps", "desktop", "main.cjs");
  let desktop;
  let firstChildPid = 0;
  try {
    mkdirSync(join(appDir, "apps", "desktop"), { recursive: true });
    mkdirSync(join(appDir, "scripts"), { recursive: true });
    writeFileSync(desktopScript, `
      const { spawn } = require("node:child_process");
      const path = require("node:path");
      const appDir = ${JSON.stringify(appDir)};
      let child;
      function launch() {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(appDir, "scripts", "start-app.mjs")], {
          cwd: appDir,
          stdio: "ignore"
        });
        if (process.send) process.send(child.pid);
        child.once("exit", () => setTimeout(launch, 1200));
      }
      process.on("SIGTERM", () => process.exit(0));
      launch();
      setInterval(() => {}, 1000);
    `);
    desktop = spawn(process.execPath, [desktopScript], {
      cwd: appDir,
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    firstChildPid = await new Promise((resolvePid, reject) => {
      desktop.once("message", resolvePid);
      desktop.once("error", reject);
      desktop.once("exit", (code, signal) => reject(new Error(`desktop exited early (${code ?? signal})`)));
    });

    await stopExistingInstallRuntime({
      appDir,
      statePath: join(directory, "missing-processes.json"),
      ports: [43107],
      graceMs: 1_000,
      forceMs: 1_000
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));

    assert.equal(desktop.exitCode !== null || desktop.signalCode !== null, true);
    assert.equal(processStartIdentity(firstChildPid), "");
    assert.deepEqual(discoverInstallRuntime({
      appDir,
      statePath: join(directory, "missing-processes.json"),
      ports: [43107]
    }), []);
  } finally {
    if (desktop?.pid) {
      try { process.kill(desktop.pid, "SIGKILL"); } catch {}
    }
    if (firstChildPid) {
      try { process.kill(firstChildPid, "SIGKILL"); } catch {}
    }
    cleanup();
  }
});

test("verified desktop quit stops a launcher and its listening backend child", async () => {
  const { directory, cleanup } = fixture("tovi-desktop-quit-tree-");
  const appDir = join(directory, "app");
  const launcherScript = join(appDir, "scripts", "start-app.mjs");
  const listenerScript = join(appDir, "apps", "runner", "dist", "index.js");
  let launcher;
  let listenerPid = 0;
  try {
    mkdirSync(join(appDir, "scripts"), { recursive: true });
    mkdirSync(join(appDir, "apps", "runner", "dist"), { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os" }));
    writeFileSync(listenerScript, `
      const http = require("node:http");
      const server = http.createServer((_request, response) => response.end("ok"));
      server.listen(0, "127.0.0.1", () => process.send?.({ port: server.address().port }));
      setInterval(() => {}, 1000);
    `);
    writeFileSync(launcherScript, `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(listenerScript)}], {
        cwd: ${JSON.stringify(appDir)},
        stdio: ["ignore", "ignore", "inherit", "ipc"]
      });
      child.on("message", (message) => process.send?.({ ...message, pid: child.pid }));
      setInterval(() => {}, 1000);
    `);
    launcher = spawn(process.execPath, [launcherScript], {
      cwd: appDir,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    const ready = await new Promise((resolveReady, reject) => {
      launcher.once("message", resolveReady);
      launcher.once("error", reject);
      launcher.once("exit", (code, signal) => reject(new Error(`launcher exited early (${code ?? signal})`)));
    });
    listenerPid = ready.pid;

    await stopExistingInstallRuntime({
      appDir,
      statePath: join(directory, "missing-processes.json"),
      ports: [ready.port],
      graceMs: 1_000,
      forceMs: 1_000
    });
    await waitForChildExit(launcher);

    assert.equal(processStartIdentity(launcher.pid), "");
    assert.equal(processStartIdentity(listenerPid), "");
    assert.deepEqual(discoverInstallRuntime({
      appDir,
      statePath: join(directory, "missing-processes.json"),
      ports: [ready.port]
    }), []);
  } finally {
    if (launcher?.pid) {
      try {
        if (process.platform === "win32") launcher.kill("SIGKILL");
        else process.kill(-launcher.pid, "SIGKILL");
      } catch {}
    }
    if (listenerPid) {
      try { process.kill(listenerPid, "SIGKILL"); } catch {}
    }
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
        version: 2,
        parentPid: launcher.pid,
        parentIdentity: processStartIdentity(launcher.pid),
        children: [{ name: "runner", pid: launcher.pid, identity: processStartIdentity(launcher.pid) }]
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
