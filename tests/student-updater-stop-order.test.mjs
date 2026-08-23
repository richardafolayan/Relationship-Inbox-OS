import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regression for #554: applyUpdate copied the preserved data/ dir (the live
// SQLite DB) BEFORE stopping the running app, so a concurrent write could yield
// a torn DB copy the pilot then boots on. Full runtime shutdown and the atomic
// rename must both happen before the PRESERVE cpSync loop.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "scripts", "update-student.mjs"), "utf8");
const LAUNCHER = readFileSync(join(__dirname, "..", "scripts", "start-app.mjs"), "utf8");

test("full runtime shutdown and rename run before the PRESERVE copy loop", () => {
  const stopIdx = SRC.indexOf(
    "await stopExistingInstallRuntime({ appDir: APP_DIR, preservePids: PRESERVED_UPDATE_PIDS });"
  );
  const renameIdx = SRC.indexOf("durableInstallRename(APP_DIR, backupDir);");
  const secondStopIdx = SRC.indexOf(
    "await stopExistingInstallRuntime({ appDir: backupDir, preservePids: PRESERVED_UPDATE_PIDS });"
  );
  const copyIdx = SRC.indexOf("cpSync(from, join(appNew, item)");
  assert.ok(stopIdx > 0, "full shutdown call present");
  assert.ok(renameIdx > stopIdx, "old launch path is removed after first shutdown");
  assert.ok(secondStopIdx > renameIdx, "rename race is closed under the backup path");
  assert.ok(copyIdx > 0, "PRESERVE cpSync present");
  assert.ok(secondStopIdx < copyIdx, "the app must be fully stopped BEFORE the live DB is copied");
});

test("signed bundles refuse source-directory replacement and use native whole-app updates", () => {
  const main = SRC.slice(SRC.indexOf("async function main()"));
  assert.match(
    main,
    /configurePackagedPaths\(\);[\s\S]*if \(RESIGN_BUNDLE\)[\s\S]*native whole-app updater[\s\S]*await recoverUnfinishedUpdate/
  );
});

test("the operation lock covers backup pruning and staging paths are collision-safe", () => {
  const pruneIdx = SRC.indexOf("pruneBackups(BACKUP_ROOT");
  const releaseIdx = SRC.indexOf("releaseUpdateOperation();", pruneIdx);
  assert.ok(pruneIdx > 0 && releaseIdx > pruneIdx);
  assert.match(SRC, /operationId = `\$\{stamp\}-\$\{process\.pid\}-\$\{randomUUID\(\)\}`/);
  assert.match(SRC, /`\.rios-update-\$\{installScope\}-\$\{operationId\}`/);
  assert.match(SRC, /`\.rios-backup-\$\{installScope\}-`/);
});

test("schema preparation and install mutation locks close the pre-bind database race", () => {
  const updaterPreparationIdx = SRC.indexOf("await acquireUpdatePreparation();");
  const updaterStopIdx = SRC.indexOf("await stopExistingInstallRuntime({ appDir: APP_DIR");
  assert.ok(updaterPreparationIdx > 0 && updaterStopIdx > updaterPreparationIdx);
  const launcherAcquireIdx = LAUNCHER.indexOf("preparationToken = acquireProcessLock(");
  const launcherOperationIdx = LAUNCHER.indexOf("const operation = inspectInstallOperation(");
  assert.ok(launcherAcquireIdx > 0 && launcherOperationIdx > launcherAcquireIdx);
  assert.match(LAUNCHER, /installPreparationPath\(APP_DIR\)/);
  assert.match(SRC, /RIOS_INSTALL_PREPARATION_TOKEN/);
});
