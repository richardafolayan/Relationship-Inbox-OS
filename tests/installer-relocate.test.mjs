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
import { fileURLToPath } from "node:url";
import {
  acquireInstallOperation,
  installOperationPath,
  releaseInstallOperation
} from "../scripts/lib/install-maintenance.mjs";

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
  for (const file of ["env-file.mjs", "install-maintenance.mjs", "process-lifecycle.mjs"]) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "lib", file), path.join(src, "scripts", "lib", file));
  }
  return src;
}

function runInstaller(src, installDir, home) {
  return spawnSync("bash", [path.join(src, "scripts", "install-student-macos.sh"), "--skip-deps"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, RIOS_INSTALL_DIR: installDir, RIOS_NO_START: "1" },
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
    assert.equal(fs.existsSync(installOperationPath(installDir)), false, "operation lock released");

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

    // No staging/backup leftovers beside the install dir.
    const siblings = fs.readdirSync(home);
    assert.ok(
      !siblings.some((n) => n.startsWith("RelationshipInboxOS.new-") || n === "RelationshipInboxOS.previous"),
      `temp install artefacts left behind: ${siblings.join(", ")}`,
    );

    // Source still intact (never the live copy).
    assert.ok(fs.existsSync(path.join(src, "CODE_VERSION.txt")), "source folder left intact");
    assert.equal(fs.existsSync(path.join(installDir, ".tovi-installing")), false, "update lock released");
  } finally {
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
