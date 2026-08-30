// Verifies the student installer's relocate behaviour:
//   1. The ZIP / in-folder route installs into ~/RelationshipInboxOS (here an
//      overridable RIOS_INSTALL_DIR), not wherever it was unzipped.
//   2. Re-running over an existing install refreshes the code but KEEPS the
//      user's .env and data/ (never deletes user data).
//
// The installer is macOS-only (it `die`s on non-Darwin), so these run on macOS
// and skip elsewhere (e.g. Linux CI). We use --skip-deps so no Node install,
// npm install, database setup, or app launch happens — only the file
// operations under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireInstallOperation,
  installMaintenancePath,
  installOperationPath,
  releaseInstallOperation
} from "../scripts/lib/install-maintenance.mjs";
import { processIsAlive } from "../scripts/lib/process-lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install-student-macos.sh");

const MACOS = process.platform === "darwin";
const skip = MACOS ? false : "installer is macOS-only";

function read(p) {
  return fs.readFileSync(p, "utf8");
}

// Build a fake "unzipped app" source folder that looks like the real repo to
// the installer (package.json names the app; the real installer script lives
// in scripts/ so BASH_SOURCE resolves to an app root).
function makeSource(root, codeVersion) {
  const src = path.join(root, "download", "relationship-inbox-os");
  fs.mkdirSync(path.join(src, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-test" }, null, 2),
  );
  fs.writeFileSync(path.join(src, ".env.example"), "NEXT_PUBLIC_APP_VERSION=0.0.0-test\nAI_PROVIDER=openai\n");
  fs.writeFileSync(path.join(src, "CODE_VERSION.txt"), codeVersion);
  fs.copyFileSync(INSTALLER, path.join(src, "scripts", "install-student-macos.sh"));
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "stop-existing-install.mjs"),
    path.join(src, "scripts", "stop-existing-install.mjs"),
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "install-maintenance.mjs"),
    path.join(src, "scripts", "install-maintenance.mjs"),
  );
  for (const file of [
    "env-file.mjs",
    "install-maintenance.mjs",
    "install-transaction.mjs",
    "process-lifecycle.mjs",
    "run-with-install-lease.mjs"
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "lib", file), path.join(src, "scripts", "lib", file));
  }
  return src;
}

function runInstaller(src, installDir, home) {
  return spawnSync("bash", [path.join(src, "scripts", "install-student-macos.sh"), "--skip-deps"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      RIOS_INSTALL_DIR: installDir,
      RIOS_INSTALL_TRANSACTION_DIR: path.join(home, ".install-transactions"),
      RIOS_NO_START: "1"
    },
  });
}

function startOwnedListener(installDir, databasePath) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       const net = require("node:net");
       const server = net.createServer();
       process.on("SIGTERM", () => {
         fs.appendFileSync(${JSON.stringify(databasePath)}, "\\nSTOPPED-BEFORE-COPY");
         server.close(() => process.exit(0));
       });
       server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));`,
    ],
    { cwd: installDir, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`listener exited early (${code ?? signal})`)));
    child.once("message", ({ port }) => resolve({ child, port }));
  });
}

function startUnboundRuntime(installDir, markerPath) {
  const runtimeScript = path.join(installDir, "scripts", "start-student.mjs");
  fs.mkdirSync(path.dirname(runtimeScript), { recursive: true });
  fs.writeFileSync(
    runtimeScript,
    `import fs from "node:fs";
     process.on("SIGTERM", () => {
       fs.writeFileSync(${JSON.stringify(markerPath)}, "STOPPED-BEFORE-COPY");
       process.exit(0);
     });
     process.send({ ready: true });
     setInterval(() => {}, 1000);`,
  );
  const child = spawn(process.execPath, [runtimeScript], {
    cwd: installDir,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`runtime exited early (${code ?? signal})`)));
    child.once("message", () => resolve(child));
  });
}

function startSchemaPreparation(installDir, databasePath) {
  const runtimeScript = path.join(installDir, "scripts", "start-app.mjs");
  const maintenanceModule = pathToFileURL(
    path.join(REPO_ROOT, "scripts", "lib", "install-maintenance.mjs")
  ).href;
  fs.mkdirSync(path.dirname(runtimeScript), { recursive: true });
  fs.writeFileSync(
    runtimeScript,
    `import fs from "node:fs";
     import { acquireInstallPreparation, releaseInstallPreparation } from ${JSON.stringify(maintenanceModule)};
     const appDir = ${JSON.stringify(installDir)};
     const token = acquireInstallPreparation(appDir);
     process.send({ ready: true });
     setTimeout(() => {
       fs.appendFileSync(${JSON.stringify(databasePath)}, "\\nSCHEMA-PREPARATION-COMPLETE");
       releaseInstallPreparation(appDir, token);
       process.exit(0);
     }, 700);`
  );
  const child = spawn(process.execPath, [runtimeScript], {
    cwd: installDir,
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`preparation exited early (${code ?? signal})`)));
    child.once("message", () => resolve(child));
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForCondition(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(message);
}

test("fresh ZIP install lands in the install dir, leaves the source in place", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-fresh-"));
  try {
    const installDir = path.join(home, "RelationshipInboxOS");
    const src = makeSource(home, "v1-fresh");

    const r = runInstaller(src, installDir, home);
    assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);

    // Code landed in the predictable install dir.
    assert.ok(fs.existsSync(installDir), "install dir was created");
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v1-fresh", "app code copied in");
    assert.ok(fs.existsSync(path.join(installDir, "package.json")), "package.json copied in");
    assert.equal(fs.existsSync(path.join(installDir, ".tovi-installing")), false, "install lock released");
    assert.equal(fs.existsSync(installMaintenancePath(installDir)), false, "maintenance lock released");
    assert.equal(fs.existsSync(installOperationPath(installDir)), false, "operation lock released");
    assert.equal(
      fs.readdirSync(home).some((name) => name.endsWith(".tovi-maintenance")),
      false,
      "no staging maintenance lock leaked"
    );

    // The source (e.g. Downloads) is only read, never moved/deleted.
    assert.ok(fs.existsSync(path.join(src, "CODE_VERSION.txt")), "source folder left intact");

    // .env created from the template with an absolute DATABASE_URL under the install dir.
    const env = read(path.join(installDir, ".env"));
    assert.match(env, /^DATABASE_URL=file:.+\/data\/inbox-os\.sqlite$/m, "DATABASE_URL pinned absolute");
    assert.match(env, /^BROWSER_PROFILE_MODE=personal$/m, "personal browser mode set");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an active install operation blocks a concurrent installer before swap", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-serialized-"));
  const installDir = path.join(home, "RelationshipInboxOS");
  fs.mkdirSync(path.join(installDir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" }),
  );
  fs.writeFileSync(path.join(installDir, "CODE_VERSION.txt"), "v1-old");
  const source = makeSource(home, "v2-new");
  const token = acquireInstallOperation(installDir);
  try {
    const result = runInstaller(source, installDir, home);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /another installer|already changing/i);
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v1-old");
  } finally {
    assert.equal(releaseInstallOperation(installDir, token), true);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-install over an existing install keeps .env and data, refreshes code", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-update-"));
  try {
    const installDir = path.join(home, "RelationshipInboxOS");

    // Pre-existing install with USER data we must not lose.
    fs.mkdirSync(path.join(installDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" }, null, 2),
    );
    fs.writeFileSync(path.join(installDir, ".env"), "MY_SECRET=keepme\nOPENAI_API_KEY=sk-existing\n");
    fs.writeFileSync(path.join(installDir, "data", "inbox-os.sqlite"), "DBDATA-PRESERVE-ME");
    fs.writeFileSync(path.join(installDir, "CODE_VERSION.txt"), "v1-old");

    const src = makeSource(home, "v2-new");
    const r = runInstaller(src, installDir, home);
    assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);

    // Code refreshed...
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v2-new", "code was updated");
    // ...but the user's settings and database survived.
    assert.match(read(path.join(installDir, ".env")), /^MY_SECRET=keepme$/m, ".env preserved");
    assert.equal(
      read(path.join(installDir, "data", "inbox-os.sqlite")),
      "DBDATA-PRESERVE-ME",
      "database preserved byte-for-byte",
    );
    assert.equal(fs.existsSync(installMaintenancePath(installDir)), false, "maintenance lock released");
    assert.equal(
      fs.readdirSync(home).some((name) => name.endsWith(".tovi-maintenance")),
      false,
      "no staging maintenance lock leaked"
    );

    // No staging/backup leftovers beside the install dir.
    const siblings = fs.readdirSync(home);
    assert.ok(
      !siblings.some((n) =>
        n.startsWith("RelationshipInboxOS.new-") ||
        n.startsWith("RelationshipInboxOS.previous-") ||
        n.startsWith("RelationshipInboxOS.failed-install-")
      ),
      `temp install artefacts left behind: ${siblings.join(", ")}`,
    );

    // Source still intact (never the live copy).
    assert.ok(fs.existsSync(path.join(src, "CODE_VERSION.txt")), "source folder left intact");
    assert.equal(fs.existsSync(path.join(installDir, ".tovi-installing")), false, "update lock released");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("database preparation failure restores the previous installation and user data", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-rollback-"));
  try {
    const installDir = path.join(home, "RelationshipInboxOS");
    fs.mkdirSync(path.join(installDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" }),
    );
    fs.writeFileSync(path.join(installDir, "CODE_VERSION.txt"), "v1-old");
    fs.writeFileSync(path.join(installDir, ".env"), "MY_SECRET=keepme\n");
    fs.writeFileSync(path.join(installDir, "data", "inbox-os.sqlite"), "ORIGINAL-DATABASE");
    const source = makeSource(home, "v2-new");
    const fakeBin = path.join(home, "fake-bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "node"),
      `#!/bin/sh
if [ "$1" = "-v" ]; then echo v22.20.0; exit 0; fi
case " $* " in
  *" scripts/start-app.mjs --database-only "*) exit 43 ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`,
    );
    fs.chmodSync(path.join(fakeBin, "node"), 0o755);
    fs.writeFileSync(path.join(fakeBin, "npm"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(fakeBin, "npm"), 0o755);

    const result = spawnSync("bash", [path.join(source, "scripts", "install-student-macos.sh"), "--no-start"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        RIOS_INSTALL_DIR: installDir,
        RIOS_INSTALL_TRANSACTION_DIR: path.join(home, ".install-transactions"),
        RIOS_NO_START: "1"
      }
    });

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v1-old");
    assert.equal(read(path.join(installDir, "data", "inbox-os.sqlite")), "ORIGINAL-DATABASE");
    assert.match(read(path.join(installDir, ".env")), /MY_SECRET=keepme/);
    assert.match(`${result.stdout}\n${result.stderr}`, /Restored the previous installation/i);
    const siblings = fs.readdirSync(home);
    assert.ok(!siblings.some((name) =>
      name.startsWith("RelationshipInboxOS.previous-") ||
      name.startsWith("RelationshipInboxOS.failed-install-")
    ));
    assert.equal(fs.existsSync(installMaintenancePath(installDir)), false);
    assert.equal(fs.existsSync(installOperationPath(installDir)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("unverified database failure keeps recovery-capable code and the old backup", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-recovery-required-"));
  try {
    const installDir = path.join(home, "RelationshipInboxOS");
    fs.mkdirSync(path.join(installDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" })
    );
    fs.writeFileSync(path.join(installDir, "CODE_VERSION.txt"), "v1-old");
    fs.writeFileSync(path.join(installDir, ".env"), "MY_SECRET=keepme\n");
    fs.writeFileSync(path.join(installDir, "data", "inbox-os.sqlite"), "ORIGINAL-DATABASE");
    const source = makeSource(home, "v2-recovery-capable");
    const fakeBin = path.join(home, "fake-bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "node"), `#!/bin/sh
if [ "$1" = "-v" ]; then echo v22.20.0; exit 0; fi
case " $* " in
  *" scripts/start-app.mjs --database-only "*) exit 42 ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`);
    fs.chmodSync(path.join(fakeBin, "node"), 0o755);
    fs.writeFileSync(path.join(fakeBin, "npm"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(fakeBin, "npm"), 0o755);

    const result = spawnSync("bash", [path.join(source, "scripts", "install-student-macos.sh"), "--no-start"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        RIOS_INSTALL_DIR: installDir,
        RIOS_INSTALL_TRANSACTION_DIR: path.join(home, ".install-transactions"),
        RIOS_NO_START: "1"
      }
    });

    assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v2-recovery-capable");
    assert.equal(read(path.join(installDir, "data", "inbox-os.sqlite")), "ORIGINAL-DATABASE");
    assert.match(`${result.stdout}\n${result.stderr}`, /without a verified restoration|recovery-capable/i);
    const backups = fs.readdirSync(home).filter((name) => name.startsWith("RelationshipInboxOS.previous-"));
    assert.equal(backups.length, 1);
    assert.equal(read(path.join(home, backups[0], "CODE_VERSION.txt")), "v1-old");
    assert.equal(fs.existsSync(installMaintenancePath(installDir)), false);
    assert.equal(fs.existsSync(installOperationPath(installDir)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parent-only SIGTERM leaves rollback to recovery until the protected worker exits", { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-parent-signal-"));
  const installDir = path.join(home, "RelationshipInboxOS");
  const databasePath = path.join(installDir, "data", "inbox-os.sqlite");
  const workerMarker = path.join(home, "worker.pid");
  const releaseWorker = path.join(home, "release-worker");
  const transactionRoot = path.join(home, ".install-transactions");
  let installer;
  let workerPid = 0;
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" })
    );
    fs.writeFileSync(path.join(installDir, "CODE_VERSION.txt"), "v1-old");
    fs.writeFileSync(path.join(installDir, ".env"), "MY_SECRET=keepme\n");
    fs.writeFileSync(databasePath, "ORIGINAL-DATABASE");
    const source = makeSource(home, "v2-new");
    const fakeBin = path.join(home, "fake-bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "node"), `#!/bin/sh
if [ "$1" = "-v" ]; then echo v22.20.0; exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`);
    fs.chmodSync(path.join(fakeBin, "node"), 0o755);
    fs.writeFileSync(path.join(fakeBin, "npm"), `#!/bin/sh
printf '%s' "$$" > "$TEST_WORKER_MARKER"
trap '' TERM HUP INT
while [ ! -f "$TEST_RELEASE_WORKER" ]; do sleep 0.1; done
printf '\nCHILD-DONE' >> "$TEST_DATABASE_PATH"
exit 0
`);
    fs.chmodSync(path.join(fakeBin, "npm"), 0o755);

    installer = spawn("bash", [path.join(source, "scripts", "install-student-macos.sh"), "--no-start"], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        RIOS_INSTALL_DIR: installDir,
        RIOS_INSTALL_TRANSACTION_DIR: transactionRoot,
        RIOS_NO_APP_BUNDLE: "1",
        RIOS_NO_START: "1",
        TEST_DATABASE_PATH: databasePath,
        TEST_RELEASE_WORKER: releaseWorker,
        TEST_WORKER_MARKER: workerMarker
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    installer.stdout.on("data", (chunk) => (stdout += chunk));
    installer.stderr.on("data", (chunk) => (stderr += chunk));
    await waitForCondition(
      () => fs.existsSync(workerMarker),
      `installer worker did not start\n${stdout}\n${stderr}`,
      60_000
    );
    workerPid = Number(read(workerMarker));
    installer.kill("SIGTERM");
    await waitForExit(installer);

    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v2-new");
    assert.equal(read(databasePath), "ORIGINAL-DATABASE");
    assert.equal(processIsAlive(workerPid), true, "protected worker did not survive the parent-only signal");
    assert.equal(fs.readdirSync(transactionRoot).some((entry) => entry.endsWith(".json")), true);
    const backups = fs.readdirSync(home).filter((entry) => entry.startsWith("RelationshipInboxOS.previous-"));
    assert.equal(backups.length, 1);
    assert.equal(read(path.join(home, backups[0], "CODE_VERSION.txt")), "v1-old");

    fs.writeFileSync(releaseWorker, "go");
    await waitForCondition(() => !processIsAlive(workerPid), "protected installer worker did not exit");
    const recovery = spawnSync(process.execPath, [
      path.join(installDir, "scripts", "lib", "install-transaction.mjs"),
      "recover",
      "--app-dir", installDir,
      "--transaction-root", transactionRoot
    ], { encoding: "utf8" });
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    assert.match(recovery.stdout, /restored-old/);
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v1-old");
    assert.equal(read(databasePath), "ORIGINAL-DATABASE");
  } finally {
    if (installer?.pid && installer.exitCode === null && installer.signalCode === null) {
      try { installer.kill("SIGKILL"); } catch {}
    }
    if (workerPid && processIsAlive(workerPid)) {
      try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-install stops the owned runtime before preserving its database", { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-running-"));
  let child;
  let foreignChild;
  let startupChild;
  try {
    const installDir = path.join(home, "RelationshipInboxOS");
    const databasePath = path.join(installDir, "data", "inbox-os.sqlite");
    const foreignDir = `${installDir}-other`;
    const foreignMarker = path.join(foreignDir, "stopped.txt");
    const startupMarker = path.join(installDir, "data", "startup-stopped.txt");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" }, null, 2),
    );
    fs.writeFileSync(databasePath, "LIVE-DATABASE");

    const owned = await startOwnedListener(installDir, databasePath);
    child = owned.child;
    fs.writeFileSync(
      path.join(installDir, ".env"),
      `DASHBOARD_PORT=${owned.port}\nRUNNER_PORT=43199\n`
    );
    const foreign = await startOwnedListener(foreignDir, foreignMarker);
    foreignChild = foreign.child;
    startupChild = await startUnboundRuntime(installDir, startupMarker);

    const src = makeSource(home, "v2-new");
    const r = runInstaller(src, installDir, home);
    assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);
    await Promise.all([waitForExit(child), waitForExit(startupChild)]);
    assert.equal(
      read(databasePath),
      "LIVE-DATABASE\nSTOPPED-BEFORE-COPY",
      "the runtime must finish shutting down before data is copied",
    );
    assert.equal(child.signalCode, null, "listener handled SIGTERM and exited cleanly");
    assert.equal(read(startupMarker), "STOPPED-BEFORE-COPY", "pre-bind launcher stopped before data copy");
    assert.doesNotThrow(
      () => process.kill(foreignChild.pid, 0),
      "a listener from a similarly named directory must not be stopped",
    );
    assert.equal(fs.existsSync(foreignMarker), false, "foreign listener did not receive SIGTERM");
  } finally {
    if (child?.pid) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    if (foreignChild?.pid) {
      try { process.kill(foreignChild.pid, "SIGKILL"); } catch {}
    }
    if (startupChild?.pid) {
      try { process.kill(startupChild.pid, "SIGKILL"); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-install waits for in-flight schema preparation before preserving data", { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-preparation-"));
  let preparation;
  try {
    const installDir = path.join(home, "RelationshipInboxOS");
    const databasePath = path.join(installDir, "data", "inbox-os.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" }),
    );
    fs.writeFileSync(path.join(installDir, ".env"), "OPENAI_API_KEY=keep\n");
    fs.writeFileSync(databasePath, "DATABASE-BEFORE-PREPARATION");
    preparation = await startSchemaPreparation(installDir, databasePath);

    const source = makeSource(home, "v2-after-preparation");
    const startedAt = Date.now();
    const result = runInstaller(source, installDir, home);
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    await waitForExit(preparation);
    assert.ok(elapsed >= 500, `installer did not wait for preparation (${elapsed}ms)`);
    assert.equal(
      read(databasePath),
      "DATABASE-BEFORE-PREPARATION\nSCHEMA-PREPARATION-COMPLETE"
    );
  } finally {
    if (preparation?.pid) {
      try { process.kill(preparation.pid, "SIGKILL"); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
