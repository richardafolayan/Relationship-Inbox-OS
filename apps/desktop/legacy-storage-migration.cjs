const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  chmodSync,
  closeSync,
  cpSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");

const MIGRATION_MARKER = "legacy-migration-v1.json";
const EXCLUDED_LEGACY_DATA = new Set([
  "app-prepare-stamps.json",
  "inbox-os.sqlite",
  "inbox-os.sqlite-journal",
  "inbox-os.sqlite-shm",
  "inbox-os.sqlite-wal",
  "runtime"
]);

function fsyncDirectory(path) {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readMigrationState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (!state?.version && ["imported", "fresh"].includes(state?.decision)) {
      return { version: 1, phase: "complete", decision: state.decision };
    }
    if (
      state?.version === 2 &&
      ["importing", "complete"].includes(state.phase) &&
      ["import", "imported", "fresh"].includes(state.decision)
    ) {
      return state;
    }
  } catch {}
  return null;
}

function writeMigrationState(path, state) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(directory);
}

function writePrivateTextAtomically(path, text) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  fsyncDirectory(directory);
}

function runChecked(runProcess, executable, args, options, label) {
  const result = runProcess(executable, args, {
    encoding: "utf8",
    timeout: 30_000,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
}

function verifyDatabase(runProcess, nodeExecutable, backupScript, databasePath) {
  const result = runProcess(nodeExecutable, [backupScript, "--verify", databasePath], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: "pipe"
  });
  return !result.error && result.status === 0;
}

function canonicalExisting(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function pathIsWithin(root, target) {
  const path = relative(canonicalExisting(root), canonicalExisting(target));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function recoverLegacyDatabaseIfRequired({
  legacyData,
  sourceDatabase,
  runProcess,
  nodeExecutable,
  backupScript
}) {
  const markerPath = join(legacyData, "runtime", "database-recovery-required.json");
  if (!existsSync(markerPath)) return;
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("The existing app has an unreadable database recovery marker");
  }
  const recordedDatabase = marker.version === 2 && typeof marker.databasePath === "string"
    ? resolve(marker.databasePath)
    : sourceDatabase;
  if (recordedDatabase !== resolve(sourceDatabase)) {
    throw new Error("The existing app's database recovery marker points to another database");
  }
  const mode = marker.version === 1 ? "restore-backup" : marker.mode;
  if (mode === "remove-created-database" && marker.version === 2) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${sourceDatabase}${suffix}`, { force: true });
    }
    fsyncDirectory(dirname(sourceDatabase));
  } else if (mode === "restore-backup" && [1, 2].includes(marker.version)) {
    const backupPath = typeof marker.backupPath === "string" ? resolve(marker.backupPath) : "";
    const backupRoot = join(legacyData, "backups");
    if (!backupPath || !existsSync(backupPath) || !pathIsWithin(backupRoot, backupPath)) {
      throw new Error("The existing app's pending database backup could not be verified");
    }
    runChecked(
      runProcess,
      nodeExecutable,
      [backupScript, backupPath, resolve(sourceDatabase)],
      { stdio: "pipe" },
      "Restoring the existing message database"
    );
    if (!verifyDatabase(runProcess, nodeExecutable, backupScript, sourceDatabase)) {
      throw new Error("The existing app's restored database did not pass SQLite verification");
    }
  } else {
    throw new Error("The existing app has an unsupported database recovery marker");
  }
  rmSync(markerPath);
  fsyncDirectory(dirname(markerPath));
}

function copyFileAtomically(source, destination) {
  if (!existsSync(source) || existsSync(destination)) return;
  const directory = dirname(destination);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o600);
  const descriptor = openSync(temporary, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, destination);
  fsyncDirectory(directory);
}

function copyDurableDataAtomically(sourceDirectory, destinationDirectory) {
  if (!existsSync(sourceDirectory)) return;
  mkdirSync(destinationDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory)) {
    if (EXCLUDED_LEGACY_DATA.has(entry)) continue;
    const source = join(sourceDirectory, entry);
    const destination = join(destinationDirectory, entry);
    if (existsSync(destination)) continue;
    const temporary = join(destinationDirectory, `.${entry}.${process.pid}.${randomUUID()}.tmp`);
    rmSync(temporary, { recursive: true, force: true });
    try {
      cpSync(source, temporary, { recursive: true, errorOnExist: true, preserveTimestamps: true });
      const fsyncTree = (path) => {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) return;
        if (stats.isDirectory()) {
          for (const child of readdirSync(path)) fsyncTree(join(path, child));
          fsyncDirectory(path);
          return;
        }
        if (!stats.isFile()) return;
        const descriptor = openSync(path, "r");
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      };
      fsyncTree(temporary);
      renameSync(temporary, destination);
      fsyncDirectory(destinationDirectory);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function lockCommand(runProcess, nodeExecutable, lockScript, command, appDir, token = "") {
  const args = [lockScript, command, "--app-dir", resolve(appDir)];
  if (command.startsWith("acquire")) {
    args.push("--owner-pid", String(process.pid), "--token", token || randomUUID());
  } else {
    args.push("--token", token);
  }
  const result = runProcess(nodeExecutable, args, { encoding: "utf8", timeout: 30_000, stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return String(result.stdout || "").trim();
}

async function prepareLegacyStorageMigration({
  paths,
  decide,
  nodeExecutable,
  backupScript,
  stopScript = "",
  lockScript = "",
  runProcess = spawnSync
}) {
  const markerPath = join(paths.stateDir, MIGRATION_MARKER);
  const legacyData = join(paths.legacyDir, "data");
  const sourceDatabase = join(legacyData, "inbox-os.sqlite");
  const destinationDatabase = join(paths.dataDir, "inbox-os.sqlite");
  const sourceEnv = join(paths.legacyDir, ".env");
  const destinationEnv = join(paths.configDir, ".env");
  const state = readMigrationState(markerPath);

  if (state?.phase === "complete") {
    return { proceed: true, decision: state.decision, migrated: false };
  }
  if (!state && existsSync(destinationDatabase)) {
    return { proceed: true, decision: "existing", migrated: false };
  }
  const meaningfulLegacyData = existsSync(sourceEnv) || existsSync(sourceDatabase) || (
    existsSync(legacyData) &&
    readdirSync(legacyData).some((entry) => !EXCLUDED_LEGACY_DATA.has(entry))
  );
  if (!state && !meaningfulLegacyData) {
    return { proceed: true, decision: "none", migrated: false };
  }

  let decision = state?.phase === "importing" ? "import" : await decide();
  if (decision === "quit") return { proceed: false, decision, migrated: false };
  if (decision === "fresh") {
    writeMigrationState(markerPath, {
      version: 2,
      phase: "complete",
      decision: "fresh",
      recordedAt: new Date().toISOString()
    });
    return { proceed: true, decision: "fresh", migrated: false };
  }
  if (decision !== "import") throw new Error(`Unknown legacy migration decision: ${decision}`);

  if (!state) {
    writeMigrationState(markerPath, {
      version: 2,
      phase: "importing",
      decision: "import",
      recordedAt: new Date().toISOString()
    });
  }

  let operationToken = "";
  let preparationToken = "";
  const stopLegacyRuntime = () => {
    if (!stopScript || !existsSync(paths.legacyDir)) return;
    runChecked(
      runProcess,
      nodeExecutable,
      [stopScript, "--app-dir", resolve(paths.legacyDir)],
      { stdio: "pipe" },
      "Stopping the existing app"
    );
  };
  try {
    if (lockScript) {
      operationToken = lockCommand(
        runProcess,
        nodeExecutable,
        lockScript,
        "acquire-operation",
        paths.legacyDir
      );
    }
    stopLegacyRuntime();
    if (lockScript) {
      preparationToken = lockCommand(
        runProcess,
        nodeExecutable,
        lockScript,
        "acquire-preparation",
        paths.legacyDir
      );
    }
    stopLegacyRuntime();
    recoverLegacyDatabaseIfRequired({
      legacyData,
      sourceDatabase,
      runProcess,
      nodeExecutable,
      backupScript
    });
    copyDurableDataAtomically(legacyData, paths.dataDir);

    if (existsSync(destinationDatabase) && !verifyDatabase(
      runProcess,
      nodeExecutable,
      backupScript,
      destinationDatabase
    )) {
      rmSync(destinationDatabase, { force: true });
      rmSync(`${destinationDatabase}-wal`, { force: true });
      rmSync(`${destinationDatabase}-shm`, { force: true });
      rmSync(`${destinationDatabase}-journal`, { force: true });
    }
    if (!existsSync(destinationDatabase)) {
      if (existsSync(sourceDatabase)) {
        runChecked(
          runProcess,
          nodeExecutable,
          [backupScript, resolve(sourceDatabase), resolve(destinationDatabase)],
          { stdio: "pipe" },
          "Importing the message database"
        );
      }
    }
    if (existsSync(destinationDatabase) && !verifyDatabase(
      runProcess,
      nodeExecutable,
      backupScript,
      destinationDatabase
    )) {
      throw new Error("The imported message database did not pass SQLite verification");
    }
    if (existsSync(destinationDatabase)) {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        rmSync(`${destinationDatabase}${suffix}`, { force: true });
      }
    }

    copyFileAtomically(sourceEnv, destinationEnv);
    writeMigrationState(markerPath, {
      version: 2,
      phase: "complete",
      decision: "imported",
      recordedAt: new Date().toISOString()
    });
  } finally {
    if (preparationToken) {
      try {
        lockCommand(
          runProcess,
          nodeExecutable,
          lockScript,
          "release-preparation",
          paths.legacyDir,
          preparationToken
        );
      } catch {}
    }
    if (operationToken) {
      try {
        lockCommand(
          runProcess,
          nodeExecutable,
          lockScript,
          "release-operation",
          paths.legacyDir,
          operationToken
        );
      } catch {}
    }
  }
  return { proceed: true, decision: "imported", migrated: true };
}

module.exports = {
  MIGRATION_MARKER,
  prepareLegacyStorageMigration,
  readMigrationState,
  writePrivateTextAtomically,
  writeMigrationState
};
