import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { prismaDbPushInvocation } from "../scripts/lib/prisma-command.mjs";
import {
  applyRecoverableSchemaChange,
  SchemaRestoreError
} from "../scripts/lib/recoverable-schema-change.mjs";

const appDir = resolve(".");
const backupScript = resolve("scripts/lib/backup-sqlite.mjs");
const repairScript = resolve("scripts/lib/repair-schema-data.mjs");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tovi-draft-unique-upgrade-"));
  return {
    directory,
    databasePath: join(directory, "legacy.sqlite"),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function runRepair(databasePath) {
  execFileSync(process.execPath, [repairScript, databasePath], {
    cwd: appDir,
    stdio: "pipe"
  });
}

function createLegacyDraftTable(database) {
  database.exec(`
    CREATE TABLE drafts (
      id TEXT PRIMARY KEY,
      threadId TEXT NOT NULL,
      text TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
}

function insertDraft(database, id, threadId, text, updatedAt, createdAt = updatedAt) {
  database
    .prepare(
      "INSERT INTO drafts (id, threadId, text, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, threadId, text, updatedAt, createdAt);
}

function runCurrentSchemaPush(databasePath) {
  const invocation = prismaDbPushInvocation({
    appDir,
    packaged: true,
    nodeExecutable: process.execPath
  });
  return spawnSync(invocation.command, invocation.args, {
    cwd: appDir,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` }
  });
}

function assertUniqueDraftIndex(database) {
  const index = database
    .prepare('PRAGMA index_list("drafts")')
    .all()
    .find((candidate) => candidate.name === "drafts_threadId_key");
  assert.equal(index?.unique, 1);
  assert.deepEqual(
    database.prepare('PRAGMA index_info("drafts_threadId_key")').all().map((column) => column.name),
    ["threadId"]
  );
}

function currentSchemaHash() {
  const schemaPath = join(appDir, "packages/core/prisma/schema.prisma");
  return createHash("sha256")
    .update(schemaPath.slice(appDir.length))
    .update("\0")
    .update(readFileSync(schemaPath))
    .update("\0")
    .digest("hex");
}

function runDatabaseOnly(directory, databasePath, extraEnv = {}) {
  return spawnSync(process.execPath, [join(appDir, "scripts/start-app.mjs"), "--database-only"], {
    cwd: appDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DASHBOARD_PORT: "43111",
      RUNNER_PORT: "43112",
      DATABASE_URL: `file:${databasePath}`,
      RIOS_DATA_DIR: directory,
      RIOS_STATE_DIR: join(directory, "runtime"),
      ...extraEnv
    }
  });
}

test("schema backup is readable and can restore an already-modified database", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    database.exec("CREATE TABLE pilot (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO pilot (id) VALUES (?)").run("preserved");
    database.close();
    const backupPath = join(directory, "backups", "before.sqlite");

    execFileSync(process.execPath, [backupScript, databasePath, backupPath], {
      cwd: appDir,
      stdio: "pipe"
    });
    if (process.platform !== "win32") assert.equal(statSync(backupPath).mode & 0o777, 0o600);

    database = new Database(backupPath, { readonly: true, fileMustExist: true });
    assert.deepEqual(database.prepare("SELECT id FROM pilot").all(), [{ id: "preserved" }]);
    database.close();

    database = new Database(databasePath);
    database.prepare("UPDATE pilot SET id = ?").run("modified");
    database.close();
    execFileSync(process.execPath, [backupScript, backupPath, databasePath], {
      cwd: appDir,
      stdio: "pipe"
    });
    if (process.platform !== "win32") assert.equal(statSync(databasePath).mode & 0o777, 0o600);

    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.deepEqual(database.prepare("SELECT id FROM pilot").all(), [{ id: "preserved" }]);
    database.close();
  } finally {
    cleanup();
  }
});

test("a failed schema sync always restores the verified backup", () => {
  const calls = [];
  const changed = applyRecoverableSchemaChange({
    backup() {
      calls.push("backup");
      return { ok: true, backupPath: "/verified/before.sqlite" };
    },
    repair() {
      calls.push("repair");
      return true;
    },
    sync() {
      calls.push("sync");
      return false;
    },
    restore(backupPath) {
      calls.push(`restore:${backupPath}`);
      return true;
    }
  });

  assert.equal(changed, false);
  assert.deepEqual(calls, [
    "backup",
    "repair",
    "sync",
    "restore:/verified/before.sqlite"
  ]);
});

test("a thrown schema sync restores the backup before propagating", () => {
  const calls = [];
  const failure = new Error("filesystem unavailable");

  assert.throws(
    () => applyRecoverableSchemaChange({
      backup() {
        calls.push("backup");
        return { ok: true, backupPath: "/verified/before.sqlite" };
      },
      repair() {
        calls.push("repair");
        return true;
      },
      sync() {
        calls.push("sync");
        throw failure;
      },
      restore(backupPath) {
        calls.push(`restore:${backupPath}`);
        return true;
      }
    }),
    (error) => error === failure
  );
  assert.deepEqual(calls, [
    "backup",
    "repair",
    "sync",
    "restore:/verified/before.sqlite"
  ]);
});

test("a failed repair restores the backup without attempting synchronization", () => {
  const calls = [];
  const changed = applyRecoverableSchemaChange({
    backup() {
      calls.push("backup");
      return { ok: true, backupPath: "/verified/before.sqlite" };
    },
    repair() {
      calls.push("repair");
      return false;
    },
    sync() {
      calls.push("sync");
      return true;
    },
    restore(backupPath) {
      calls.push(`restore:${backupPath}`);
      return true;
    }
  });

  assert.equal(changed, false);
  assert.deepEqual(calls, ["backup", "repair", "restore:/verified/before.sqlite"]);
});

test("a false restore result becomes an explicit unrecovered-database error", () => {
  assert.throws(
    () => applyRecoverableSchemaChange({
      backup: () => ({ ok: true, backupPath: "/verified/before.sqlite" }),
      repair: () => true,
      sync: () => false,
      restore: () => false
    }),
    (error) => error instanceof SchemaRestoreError &&
      error.backupPath === "/verified/before.sqlite"
  );
});

test("a thrown restore keeps its cause and verified backup path", () => {
  const restoreFailure = new Error("disk full");
  assert.throws(
    () => applyRecoverableSchemaChange({
      backup: () => ({ ok: true, backupPath: "/verified/before.sqlite" }),
      repair: () => false,
      sync: () => true,
      restore: () => {
        throw restoreFailure;
      }
    }),
    (error) => error instanceof SchemaRestoreError &&
      error.backupPath === "/verified/before.sqlite" &&
      error.cause === restoreFailure
  );
});

test("backup verification rejects a copied database with a malformed schema", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    const destination = join(directory, "backups", "malformed.sqlite");
    mkdirSync(join(directory, "backups"), { recursive: true });
    writeFileSync(databasePath, "not-a-sqlite-database");

    const result = spawnSync(process.execPath, [backupScript, databasePath, destination], {
      cwd: appDir,
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0, "a malformed backup must never be reported as verified");
    assert.match(readFileSync("scripts/lib/backup-sqlite.mjs", "utf8"), /pragma\("quick_check"\)/);
  } finally {
    cleanup();
  }
});

test("repair is a no-op before the drafts table exists", () => {
  const { databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    database.exec("CREATE TABLE pilot (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO pilot (id) VALUES (?)").run("kept");
    database.close();

    runRepair(databasePath);

    database = new Database(databasePath, { readonly: true });
    assert.deepEqual(database.prepare("SELECT id FROM pilot").all(), [{ id: "kept" }]);
    database.close();
  } finally {
    cleanup();
  }
});

test("repair keeps the newest meaningful draft and creates the invariant", () => {
  const { databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    createLegacyDraftTable(database);
    insertDraft(database, "older-meaningful", "thread-1", "Keep this", "2026-08-21T10:00:00.000Z");
    insertDraft(database, "newer-empty", "thread-1", "   ", "2026-08-23T10:00:00.000Z");
    insertDraft(database, "newest-tab-empty", "thread-1", "\t\n", "2026-08-24T10:00:00.000Z");
    insertDraft(database, "newest-meaningful", "thread-1", "Keep this instead", "2026-08-22T10:00:00.000Z");
    insertDraft(database, "only-empty", "thread-2", "", "2026-08-20T10:00:00.000Z");
    database.close();

    runRepair(databasePath);
    runRepair(databasePath);

    database = new Database(databasePath);
    assert.deepEqual(
      database.prepare("SELECT id, threadId, text FROM drafts ORDER BY threadId").all(),
      [
        { id: "newest-meaningful", threadId: "thread-1", text: "Keep this instead" },
        { id: "only-empty", threadId: "thread-2", text: "" }
      ]
    );
    assertUniqueDraftIndex(database);
    assert.throws(
      () => insertDraft(database, "duplicate", "thread-1", "blocked", "2026-08-24T10:00:00.000Z"),
      /UNIQUE constraint failed/
    );
    database.close();
  } finally {
    cleanup();
  }
});

test("repair is deterministic when meaningful timestamps match", () => {
  const { databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    createLegacyDraftTable(database);
    insertDraft(database, "z-draft", "thread-1", "z", "2026-08-21T10:00:00.000Z");
    insertDraft(database, "a-draft", "thread-1", "a", "2026-08-21T10:00:00.000Z");
    database.close();

    runRepair(databasePath);

    database = new Database(databasePath, { readonly: true });
    assert.deepEqual(database.prepare("SELECT id FROM drafts").all(), [{ id: "a-draft" }]);
    database.close();
  } finally {
    cleanup();
  }
});

test("schema readiness check distinguishes legacy and repaired draft indexes", () => {
  const { databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    createLegacyDraftTable(database);
    database.close();
    const legacy = spawnSync(process.execPath, [repairScript, "--check", databasePath], {
      cwd: appDir,
      encoding: "utf8"
    });
    assert.equal(legacy.status, 2);

    runRepair(databasePath);
    const ready = spawnSync(process.execPath, [repairScript, "--check", databasePath], {
      cwd: appDir,
      encoding: "utf8"
    });
    assert.equal(ready.status, 0, ready.stderr);
  } finally {
    cleanup();
  }
});

test("database-only repairs a legacy database even when the schema stamp is current", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    const currentSchema = readFileSync("packages/core/prisma/schema.prisma", "utf8");
    const legacySchema = currentSchema.replace(
      /threadId\s+String\s+@unique([\s\S]*?thread Thread @relation\([^\n]+\)\n)\n  @@map\("drafts"\)/,
      'threadId  String$1\n  @@index([threadId])\n  @@map("drafts")'
    );
    const legacySchemaPath = join(directory, "legacy.prisma");
    writeFileSync(legacySchemaPath, legacySchema);
    writeFileSync(databasePath, "", { mode: 0o600 });
    const prismaCli = join(appDir, "node_modules", "prisma", "build", "index.js");
    const legacyPush = spawnSync(
      process.execPath,
      [prismaCli, "db", "push", "--schema", legacySchemaPath, "--skip-generate"],
      {
        cwd: appDir,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` }
      }
    );
    assert.equal(legacyPush.status, 0, `${legacyPush.stdout}\n${legacyPush.stderr}`);

    let database = new Database(databasePath);
    database.pragma("foreign_keys = OFF");
    insertDraft(database, "old", "thread-1", "older", "2026-08-20T10:00:00.000Z");
    insertDraft(database, "new", "thread-1", "newer", "2026-08-21T10:00:00.000Z");
    database.close();
    writeFileSync(
      join(directory, "app-prepare-stamps.json"),
      `${JSON.stringify({ schemaHash: currentSchemaHash() })}\n`
    );

    const result = runDatabaseOnly(directory, databasePath);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    database = new Database(databasePath);
    assert.deepEqual(database.prepare("SELECT id FROM drafts").all(), [{ id: "new" }]);
    assertUniqueDraftIndex(database);
    database.close();
  } finally {
    cleanup();
  }
});

test("database-only retries a pending verified restore before schema checks", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    createLegacyDraftTable(database);
    database.exec('CREATE UNIQUE INDEX "drafts_threadId_key" ON "drafts"("threadId")');
    database.exec("CREATE TABLE pilot (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO pilot (id) VALUES ('preserved')").run();
    database.close();

    const backupPath = join(directory, "backups", "verified.sqlite");
    mkdirSync(join(directory, "backups"), { recursive: true });
    execFileSync(process.execPath, [backupScript, databasePath, backupPath], { cwd: appDir });
    writeFileSync(databasePath, "not-a-database");
    const stateDir = join(directory, "runtime");
    mkdirSync(stateDir, { recursive: true });
    const markerPath = join(stateDir, "database-recovery-required.json");
    writeFileSync(markerPath, JSON.stringify({ version: 1, backupPath }));
    writeFileSync(
      join(directory, "app-prepare-stamps.json"),
      `${JSON.stringify({ schemaHash: currentSchemaHash() })}\n`
    );

    const result = runDatabaseOnly(directory, databasePath);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(existsSync(markerPath), false);
    database = new Database(databasePath, { readonly: true });
    assert.deepEqual(database.prepare("SELECT id FROM pilot").all(), [{ id: "preserved" }]);
    database.close();
  } finally {
    cleanup();
  }
});

test("database-only exits 42 when a recovery marker cannot be verified", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    const stateDir = join(directory, "runtime");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "database-recovery-required.json"),
      JSON.stringify({ version: 1, backupPath: join(directory, "outside-backups.sqlite") })
    );
    const result = runDatabaseOnly(directory, databasePath);
    assert.equal(result.status, 42, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Database recovery is required/);
  } finally {
    cleanup();
  }
});

test("the exact launcher Prisma command upgrades a repaired legacy database unattended", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    const currentSchema = readFileSync("packages/core/prisma/schema.prisma", "utf8");
    const legacySchema = currentSchema.replace(
      /threadId\s+String\s+@unique([\s\S]*?thread Thread @relation\([^\n]+\)\n)\n  @@map\("drafts"\)/,
      'threadId  String$1\n  @@index([threadId])\n  @@map("drafts")'
    );
    assert.notEqual(legacySchema, currentSchema);
    const legacySchemaPath = join(directory, "legacy.prisma");
    writeFileSync(legacySchemaPath, legacySchema);
    writeFileSync(databasePath, "", { mode: 0o600 });
    const prismaCli = join(appDir, "node_modules", "prisma", "build", "index.js");
    const legacyPush = spawnSync(
      process.execPath,
      [prismaCli, "db", "push", "--schema", legacySchemaPath, "--skip-generate"],
      {
        cwd: appDir,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` }
      }
    );
    assert.equal(
      legacyPush.status,
      0,
      `stdout:\n${legacyPush.stdout}\nstderr:\n${legacyPush.stderr}`
    );

    let database = new Database(databasePath);
    database.pragma("foreign_keys = OFF");
    insertDraft(database, "old", "thread-1", "older", "2026-08-20T10:00:00.000Z");
    insertDraft(database, "new", "thread-1", "newer", "2026-08-21T10:00:00.000Z");
    database.close();

    const unsafePush = runCurrentSchemaPush(databasePath);
    assert.notEqual(unsafePush.status, 0);
    assert.match(`${unsafePush.stdout}\n${unsafePush.stderr}`, /--accept-data-loss/);

    runRepair(databasePath);
    const repairedPush = runCurrentSchemaPush(databasePath);
    assert.equal(
      repairedPush.status,
      0,
      `stdout:\n${repairedPush.stdout}\nstderr:\n${repairedPush.stderr}`
    );

    database = new Database(databasePath);
    assert.deepEqual(database.prepare('SELECT "id" FROM "drafts"').all(), [{ id: "new" }]);
    assertUniqueDraftIndex(database);
    database.close();
  } finally {
    cleanup();
  }
});

test("schema, launcher order, and save route share one Draft invariant", () => {
  const schema = readFileSync("packages/core/prisma/schema.prisma", "utf8");
  const draftModel = schema.slice(schema.indexOf("model Draft"), schema.indexOf("model AuditLog"));
  assert.match(draftModel, /threadId\s+String\s+@unique/);
  assert.doesNotMatch(draftModel, /@@index\(\[threadId\]\)/);

  const launcher = readFileSync("scripts/start-app.mjs", "utf8");
  const backupHelper = readFileSync("scripts/lib/backup-sqlite.mjs", "utf8");
  assert.match(backupHelper, /database\.backup\(temporary\)/);
  assert.match(backupHelper, /pragma\("quick_check"\)/);
  assert.match(backupHelper, /copyFile\(temporary, destination\)/);
  const preparation = launcher.slice(launcher.indexOf("function prepare()"), launcher.indexOf("function delay("));
  const backupAt = preparation.indexOf("backupDatabaseBeforeSchemaChange(schemaHash)");
  const repairAt = preparation.indexOf("repairDatabaseBeforeSchemaChange");
  const syncAt = preparation.indexOf("syncDatabase");
  const restoreAt = preparation.indexOf("restoreDatabaseAfterFailedSchemaChange");
  assert.ok(backupAt >= 0 && repairAt > backupAt && syncAt > repairAt);
  assert.ok(restoreAt > syncAt);

  const updater = readFileSync("scripts/update-student.mjs", "utf8");
  const dependencyStep = updater.slice(
    updater.indexOf('execFileSync("npm", ["run", "db:generate"]'),
    updater.indexOf("if (!RESIGN_BUNDLE)", updater.indexOf('execFileSync("npm", ["run", "db:generate"]'))
  );
  const buildOnlyAt = dependencyStep.indexOf('start-app.mjs", "--build-only"');
  const databaseOnlyAt = dependencyStep.indexOf('start-app.mjs", "--database-only"');
  assert.ok(buildOnlyAt >= 0 && databaseOnlyAt > buildOnlyAt);
  assert.doesNotMatch(dependencyStep, /db:push/);

  const installer = readFileSync("scripts/install-student-macos.sh", "utf8");
  const installDatabaseStep = installer.slice(
    installer.indexOf('run "Preparing the local database..."'),
    installer.indexOf('ok "Local database ready"')
  );
  assert.match(installDatabaseStep, /start-app\.mjs --database-only/);
  assert.doesNotMatch(installDatabaseStep, /db:push/);

  assert.match(launcher, /const BUILD_ONLY = args\.has\("--build-only"\)/);
  assert.match(preparation, /if \(!BUILD_ONLY\) \{[\s\S]*applyRecoverableSchemaChange/);

  const runner = readFileSync("apps/runner/src/index.ts", "utf8");
  const draftRoute = runner.slice(
    runner.indexOf('app.post("/control/thread/:threadId/draft"'),
    runner.indexOf('app.post("/control/thread/:threadId/delete-draft"')
  );
  assert.match(draftRoute, /prisma\.draft\.upsert\(\{/);
  assert.match(draftRoute, /where:\s*\{ threadId \}/);
  assert.doesNotMatch(draftRoute, /draft\.findFirst/);
});
