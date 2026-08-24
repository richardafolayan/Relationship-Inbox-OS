import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  beginInstallTransaction,
  captureInstallIdentity,
  installRecoveryBootstrapPath,
  installTransactionPath,
  moveInstallTransaction,
  rollbackInstallTransaction,
  recoverInstallTransaction
} from "../scripts/lib/install-transaction.mjs";
import {
  acquireInstallOperation,
  acquireInstallPreparation,
  releaseInstallOperation,
  releaseInstallPreparation
} from "../scripts/lib/install-maintenance.mjs";

const MODULE_URL = pathToFileURL(resolve("scripts/lib/install-transaction.mjs")).href;

function writeApp(path, version) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), `${JSON.stringify({ name: "tovi-test", version })}\n`);
  writeFileSync(join(path, "release.json"), `${JSON.stringify({ version, channel: "test" })}\n`);
}

function fixture({ existing = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tovi-install-transaction-"));
  const appDir = join(root, "Tovi");
  const backupRoot = join(root, "updates");
  const stagingRoot = join(backupRoot, ".stage-operation");
  const stagedApp = join(stagingRoot, "relationship-inbox-os");
  const backupDir = join(backupRoot, ".backup-operation");
  const transactionRoot = join(root, "private", "transactions");
  mkdirSync(backupRoot, { recursive: true });
  if (existing) writeApp(appDir, "1.0.0");
  writeApp(stagedApp, "2.0.0");
  return {
    root,
    appDir,
    backupRoot,
    stagingRoot,
    stagedApp,
    backupDir,
    transactionRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function versionAt(path) {
  return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version;
}

async function crashAt(item, point) {
  const code = `
    import { renameSync } from "node:fs";
    import { beginInstallTransaction, checkpointInstallTransaction } from ${JSON.stringify(MODULE_URL)};
    const item = ${JSON.stringify({
      appDir: item.appDir,
      backupDir: item.backupDir,
      backupRoot: item.backupRoot,
      stagedApp: item.stagedApp,
      stagingRoot: item.stagingRoot
    })};
    const options = { rootDir: ${JSON.stringify(item.transactionRoot)} };
    const transaction = beginInstallTransaction({ ...item, kind: "test-update" }, options);
    renameSync(item.appDir, item.backupDir);
    if (${JSON.stringify(point)} !== "after-old-rename-before-checkpoint") {
      checkpointInstallTransaction(item.appDir, transaction.operationId, "old_moved", options);
    }
    if (${JSON.stringify(point)}.startsWith("after-publish") || ${JSON.stringify(point)} === "after-ready") {
      renameSync(item.stagedApp, item.appDir);
      if (${JSON.stringify(point)} !== "after-publish-before-checkpoint") {
        checkpointInstallTransaction(item.appDir, transaction.operationId, "published", options);
      }
      if (${JSON.stringify(point)} === "after-ready") {
        checkpointInstallTransaction(item.appDir, transaction.operationId, "ready", options);
      }
    }
    process.send?.("ready");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  await new Promise((resolveReady, reject) => {
    child.once("message", resolveReady);
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => reject(new Error(`transaction child exited early (${exitCode ?? signal})`)));
  });
  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

test("SIGKILL after moving the old app restores the verified old install", { skip: process.platform === "win32" }, async () => {
  const item = fixture();
  try {
    await crashAt(item, "after-old-moved");
    assert.equal(existsSync(item.appDir), false);
    assert.equal(versionAt(item.backupDir), "1.0.0");

    const result = recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot });
    assert.equal(result.status, "restored-old");
    assert.equal(versionAt(item.appDir), "1.0.0");
    assert.equal(existsSync(item.stagingRoot), false, "recovery leaked the extracted update payload");
    assert.equal(recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot }).status, "none");
  } finally {
    item.cleanup();
  }
});

test("filesystem observation recovers a crash before the old-moved checkpoint", { skip: process.platform === "win32" }, async () => {
  const item = fixture();
  try {
    await crashAt(item, "after-old-rename-before-checkpoint");
    const result = recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot });
    assert.equal(result.status, "restored-old");
    assert.equal(versionAt(item.appDir), "1.0.0");
  } finally {
    item.cleanup();
  }
});

test("SIGKILL after atomic publication restores the old app before preparation is ready", { skip: process.platform === "win32" }, async () => {
  const item = fixture();
  try {
    await crashAt(item, "after-publish");
    const result = recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot });
    assert.equal(result.status, "restored-old");
    assert.equal(versionAt(item.appDir), "1.0.0");
    assert.equal(existsSync(item.backupDir), false);
    assert.equal(existsSync(item.stagingRoot), false, "recovery leaked the extracted update payload");
  } finally {
    item.cleanup();
  }
});

test("filesystem observation restores old code when publication beat its checkpoint", { skip: process.platform === "win32" }, async () => {
  const item = fixture();
  try {
    await crashAt(item, "after-publish-before-checkpoint");
    const result = recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot });
    assert.equal(result.status, "restored-old");
    assert.equal(versionAt(item.appDir), "1.0.0");
  } finally {
    item.cleanup();
  }
});

test("a ready checkpoint rolls forward to the verified new app", { skip: process.platform === "win32" }, async () => {
  const item = fixture();
  try {
    await crashAt(item, "after-ready");
    const result = recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot });
    assert.equal(result.status, "kept-new");
    assert.equal(versionAt(item.appDir), "2.0.0");
    assert.equal(versionAt(item.backupDir), "1.0.0");
  } finally {
    item.cleanup();
  }
});

test("same-version rollback restores the concrete old tree", () => {
  const item = fixture();
  try {
    writeApp(item.stagedApp, "1.0.0");
    writeFileSync(join(item.appDir, "CODE.txt"), "OLD");
    writeFileSync(join(item.stagedApp, "CODE.txt"), "NEW");
    const transaction = beginInstallTransaction({ ...item, kind: "same-version-reinstall" }, {
      rootDir: item.transactionRoot
    });
    moveInstallTransaction(item.appDir, transaction.operationId, "move-old", { rootDir: item.transactionRoot });
    moveInstallTransaction(item.appDir, transaction.operationId, "publish", { rootDir: item.transactionRoot });

    const result = rollbackInstallTransaction(item.appDir, transaction.operationId, {
      rootDir: item.transactionRoot
    });
    assert.equal(result.status, "restored-old");
    assert.equal(readFileSync(join(item.appDir, "CODE.txt"), "utf8"), "OLD");
    assert.equal(existsSync(item.backupDir), false);
  } finally {
    item.cleanup();
  }
});

test("fresh install recovery publishes only the verified staged app", () => {
  const item = fixture({ existing: false });
  try {
    const transaction = beginInstallTransaction({ ...item, kind: "fresh-install" }, {
      rootDir: item.transactionRoot
    });
    assert.equal(transaction.before, null);
    const result = recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot });
    assert.equal(result.status, "published-new");
    assert.equal(versionAt(item.appDir), "2.0.0");
    assert.ok(captureInstallIdentity(item.appDir));
    assert.equal(existsSync(installRecoveryBootstrapPath(item.appDir, { rootDir: item.transactionRoot })), true);
  } finally {
    item.cleanup();
  }
});

test("a path-escaping transaction fails closed without moving either app", () => {
  const item = fixture();
  try {
    beginInstallTransaction({ ...item, kind: "test-update" }, { rootDir: item.transactionRoot });
    const journalPath = installTransactionPath(item.appDir, { rootDir: item.transactionRoot });
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.backupDir = resolve("/");
    writeFileSync(journalPath, JSON.stringify(journal));

    assert.throws(
      () => recoverInstallTransaction(item.appDir, { rootDir: item.transactionRoot }),
      /unsafe path/
    );
    assert.equal(versionAt(item.appDir), "1.0.0");
    assert.equal(versionAt(item.stagedApp), "2.0.0");
  } finally {
    item.cleanup();
  }
});

test("external bootstrap cannot recover old-moved state through active install locks", async () => {
  const item = fixture();
  let operationToken = "";
  let preparationToken = "";
  try {
    const transaction = beginInstallTransaction({ ...item, kind: "active-installer" }, {
      rootDir: item.transactionRoot
    });
    moveInstallTransaction(item.appDir, transaction.operationId, "move-old", { rootDir: item.transactionRoot });
    operationToken = acquireInstallOperation(item.appDir);
    preparationToken = acquireInstallPreparation(item.appDir);
    const bootstrap = installRecoveryBootstrapPath(item.appDir, { rootDir: item.transactionRoot });

    const blocked = spawn(process.execPath, [
      bootstrap,
      "recover-serialized",
      "--app-dir", item.appDir,
      "--transaction-root", item.transactionRoot
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let blockedError = "";
    blocked.stderr.on("data", (chunk) => (blockedError += chunk));
    const blockedCode = await new Promise((resolveExit) => blocked.once("close", resolveExit));
    assert.notEqual(blockedCode, 0);
    assert.match(blockedError, /already changing/i);
    assert.equal(existsSync(item.appDir), false);
    assert.equal(versionAt(item.backupDir), "1.0.0");
    assert.equal(versionAt(item.stagedApp), "2.0.0");
    assert.equal(existsSync(installTransactionPath(item.appDir, { rootDir: item.transactionRoot })), true);

    releaseInstallPreparation(item.appDir, preparationToken);
    preparationToken = "";
    releaseInstallOperation(item.appDir, operationToken);
    operationToken = "";
    const recovered = spawn(process.execPath, [
      bootstrap,
      "recover-serialized",
      "--app-dir", item.appDir,
      "--transaction-root", item.transactionRoot
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let recoveredOut = "";
    let recoveredError = "";
    recovered.stdout.on("data", (chunk) => (recoveredOut += chunk));
    recovered.stderr.on("data", (chunk) => (recoveredError += chunk));
    const recoveredCode = await new Promise((resolveExit) => recovered.once("close", resolveExit));
    assert.equal(recoveredCode, 0, `${recoveredOut}\n${recoveredError}`);
    assert.match(recoveredOut, /restored-old/);
    assert.equal(versionAt(item.appDir), "1.0.0");
  } finally {
    if (preparationToken) releaseInstallPreparation(item.appDir, preparationToken);
    if (operationToken) releaseInstallOperation(item.appDir, operationToken);
    item.cleanup();
  }
});
