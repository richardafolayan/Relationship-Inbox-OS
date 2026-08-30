import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  SchemaChangeRestoredError,
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

function createLegacySendRequestTable(database) {
  database.exec(`
    CREATE TABLE settings (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      valueJson TEXT NOT NULL,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL
    );
    CREATE TABLE send_requests (
      id TEXT PRIMARY KEY,
      clientSendId TEXT NOT NULL,
      threadId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      requestText TEXT NOT NULL,
      draftConsumed BOOLEAN NOT NULL DEFAULT false
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

function assertUniqueRecoveryPredecessorIndex(database) {
  const index = database
    .prepare('PRAGMA index_list("send_requests")')
    .all()
    .find(
      (candidate) =>
        candidate.name ===
        "send_requests_recoveryPredecessorClientSendId_key"
    );
  assert.equal(index?.unique, 1);
  assert.deepEqual(
    database
      .prepare(
        'PRAGMA index_info("send_requests_recoveryPredecessorClientSendId_key")'
      )
      .all()
      .map((column) => column.name),
    ["recoveryPredecessorClientSendId"]
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
    writeFileSync(`${databasePath}-journal`, "stale rollback journal");
    execFileSync(process.execPath, [backupScript, backupPath, databasePath], {
      cwd: appDir,
      stdio: "pipe"
    });
    if (process.platform !== "win32") assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    assert.equal(existsSync(`${databasePath}-journal`), false);

    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.deepEqual(database.prepare("SELECT id FROM pilot").all(), [{ id: "preserved" }]);
    assert.deepEqual(database.pragma("quick_check"), [{ quick_check: "ok" }]);
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

test("a thrown schema sync reports that the backup was restored", () => {
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
    (error) => error instanceof SchemaChangeRestoredError &&
      error.backupPath === "/verified/before.sqlite" &&
      error.cause === failure
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
    createLegacySendRequestTable(database);
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
    assert.equal(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("external_action_requests")?.name,
      "external_action_requests"
    );
    assert.deepEqual(
      database
        .prepare('SELECT "id", "valueJson" FROM "settings" WHERE "key" = ?')
        .get("data_repair_send_request_source_v2"),
      {
        id: "data_repair_send_request_source_v2",
        valueJson: '{"version":2}'
      }
    );
    assert.equal(
      database
        .prepare('PRAGMA table_info("send_requests")')
        .all()
        .find((column) => column.name === "source")?.dflt_value,
      null
    );
    database.close();
  } finally {
    cleanup();
  }
});

test("database-only writes the provenance marker before a clean first launch succeeds", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    const result = runDatabaseOnly(directory, databasePath);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.equal(
      database
        .prepare('SELECT "valueJson" FROM "settings" WHERE "key" = ?')
        .get("data_repair_send_request_source_v2")?.valueJson,
      '{"version":2}'
    );
    assert.equal(
      database
        .prepare('PRAGMA table_info("send_requests")')
        .all()
        .find((column) => column.name === "source")?.dflt_value,
      null
    );
    database.close();
  } finally {
    cleanup();
  }
});

test("database-only invalidates provenance from the immediately preceding source schema", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    const currentSchema = readFileSync("packages/core/prisma/schema.prisma", "utf8");
    const predecessorSchema = currentSchema.replace(
      /^  source\s+String\s*$/m,
      '  source       String            @default("manual")'
    );
    assert.notEqual(predecessorSchema, currentSchema);
    const predecessorSchemaPath = join(directory, "predecessor.prisma");
    writeFileSync(predecessorSchemaPath, predecessorSchema);
    writeFileSync(databasePath, "", { mode: 0o600 });
    const prismaCli = join(appDir, "node_modules", "prisma", "build", "index.js");
    const predecessorPush = spawnSync(
      process.execPath,
      [prismaCli, "db", "push", "--schema", predecessorSchemaPath, "--skip-generate"],
      {
        cwd: appDir,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` }
      }
    );
    assert.equal(
      predecessorPush.status,
      0,
      `${predecessorPush.stdout}\n${predecessorPush.stderr}`
    );

    let database = new Database(databasePath);
    database.pragma("foreign_keys = OFF");
    const now = Date.now();
    database
      .prepare(`
        INSERT INTO "send_requests" (
          "id", "clientSendId", "threadId", "status", "requestText",
          "source", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "send-predecessor",
        "client-predecessor",
        "thread-predecessor",
        "PENDING",
        "hello",
        "manual",
        now,
        now
      );
    database.close();
    writeFileSync(
      join(directory, "app-prepare-stamps.json"),
      `${JSON.stringify({ schemaHash: currentSchemaHash() })}\n`
    );

    const result = runDatabaseOnly(directory, databasePath);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.equal(
      database
        .prepare('SELECT "source" FROM "send_requests" WHERE "id" = ?')
        .get("send-predecessor")?.source,
      "legacy_unknown"
    );
    assert.equal(
      database
        .prepare('SELECT "valueJson" FROM "settings" WHERE "key" = ?')
        .get("data_repair_send_request_source_v2")?.valueJson,
      '{"version":2}'
    );
    assert.equal(
      database
        .prepare('PRAGMA table_info("send_requests")')
        .all()
        .find((column) => column.name === "source")?.dflt_value,
      null
    );
    database.close();
  } finally {
    cleanup();
  }
});

test("a current-stamp predecessor database gains send safety columns without losing sends", () => {
  const { directory, databasePath, cleanup } = fixture();
  try {
    const currentSchema = readFileSync("packages/core/prisma/schema.prisma", "utf8");
    const predecessorSchema = currentSchema
      .replace(/^\s+draftConsumed\s+Boolean\s+@default\(false\)\s*$/m, "")
      .replace(/^\s+recoveryPredecessorClientSendId\s+String\?\s*$/m, "");
    assert.notEqual(predecessorSchema, currentSchema);
    const predecessorSchemaPath = join(directory, "predecessor-no-draft-consumed.prisma");
    writeFileSync(predecessorSchemaPath, predecessorSchema);
    writeFileSync(databasePath, "", { mode: 0o600 });
    const prismaCli = join(appDir, "node_modules", "prisma", "build", "index.js");
    const predecessorPush = spawnSync(
      process.execPath,
      [prismaCli, "db", "push", "--schema", predecessorSchemaPath, "--skip-generate"],
      {
        cwd: appDir,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` }
      }
    );
    assert.equal(
      predecessorPush.status,
      0,
      `${predecessorPush.stdout}\n${predecessorPush.stderr}`
    );

    let database = new Database(databasePath);
    database.pragma("foreign_keys = OFF");
    const now = Date.now();
    database
      .prepare(`
        INSERT INTO "send_requests" (
          "id", "clientSendId", "threadId", "status", "requestText",
          "source", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "send-before-draft-consumed",
        "client-before-draft-consumed",
        "thread-predecessor",
        "PENDING",
        "preserve me",
        "manual",
        now,
        now
      );
    database.close();
    writeFileSync(
      join(directory, "app-prepare-stamps.json"),
      `${JSON.stringify({ schemaHash: currentSchemaHash() })}\n`
    );

    const check = spawnSync(process.execPath, [repairScript, "--check", databasePath], {
      cwd: appDir,
      encoding: "utf8"
    });
    assert.equal(check.status, 2, check.stderr);

    const result = runDatabaseOnly(directory, databasePath);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.equal(
      database
        .prepare('PRAGMA table_info("send_requests")')
        .all()
        .find((column) => column.name === "draftConsumed")?.notnull,
      1
    );
    assert.deepEqual(
      database
        .prepare('SELECT "id", "draftConsumed" FROM "send_requests" WHERE "id" = ?')
        .get("send-before-draft-consumed"),
      { id: "send-before-draft-consumed", draftConsumed: 0 }
    );
    const predecessorColumn = database
      .prepare('PRAGMA table_info("send_requests")')
      .all()
      .find((column) => column.name === "recoveryPredecessorClientSendId");
    assert.equal(predecessorColumn?.type, "TEXT");
    assert.equal(predecessorColumn?.notnull, 0);
    assertUniqueRecoveryPredecessorIndex(database);
    database.close();
  } finally {
    cleanup();
  }
});

test("repair deterministically arbitrates duplicate recovery successors before adding uniqueness", () => {
  const { databasePath, cleanup } = fixture();
  try {
    writeFileSync(databasePath, "", { mode: 0o600 });
    const pushed = runCurrentSchemaPush(databasePath);
    assert.equal(pushed.status, 0, `${pushed.stdout}\n${pushed.stderr}`);
    let database = new Database(databasePath);
    database.pragma("foreign_keys = OFF");
    database.exec(
      'DROP INDEX IF EXISTS "send_requests_recoveryPredecessorClientSendId_key"'
    );
    const insert = database.prepare(`
      INSERT INTO "send_requests" (
        "id", "clientSendId", "threadId", "status", "requestText",
        "draftConsumed", "source", "receiptJson", "errorJson",
        "recoveryPredecessorClientSendId", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run(
      "a-pending",
      "pending-successor",
      "thread-1",
      "PENDING",
      "same intent",
      0,
      "manual",
      null,
      null,
      "failed-predecessor",
      now,
      now
    );
    insert.run(
      "z-sent",
      "sent-successor",
      "thread-1",
      "SENT",
      "same intent",
      0,
      "manual",
      JSON.stringify({ sentAt: "2026-08-30T09:00:00.000Z" }),
      null,
      "failed-predecessor",
      now + 1,
      now + 1
    );
    database.close();

    runRepair(databasePath);
    runRepair(databasePath);

    database = new Database(databasePath);
    assertUniqueRecoveryPredecessorIndex(database);
    assert.deepEqual(
      database
        .prepare(`
          SELECT "id", "status", "recoveryPredecessorClientSendId", "errorJson"
          FROM "send_requests"
          ORDER BY "id"
        `)
        .all()
        .map((row) => ({
          ...row,
          errorJson: row.errorJson ? JSON.parse(row.errorJson) : null
        })),
      [
        {
          id: "a-pending",
          status: "FAILED",
          recoveryPredecessorClientSendId: null,
          errorJson: {
            errorKind: "DELIVERY_UNCERTAIN",
            message: "Another recovered send already claimed this predecessor",
            reasonCode: "recovery_predecessor_already_claimed"
          }
        },
        {
          id: "z-sent",
          status: "SENT",
          recoveryPredecessorClientSendId: "failed-predecessor",
          errorJson: null
        }
      ]
    );
    const insertAfterRepair = database.prepare(`
      INSERT INTO "send_requests" (
        "id", "clientSendId", "threadId", "status", "requestText",
        "draftConsumed", "source", "receiptJson", "errorJson",
        "recoveryPredecessorClientSendId", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    assert.throws(
      () => insertAfterRepair.run(
        "third",
        "third-successor",
        "thread-1",
        "PENDING",
        "same intent",
        0,
        "manual",
        null,
        null,
        "failed-predecessor",
        now + 2,
        now + 2
      ),
      /UNIQUE constraint failed/
    );
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
    createLegacySendRequestTable(database);
    database.exec("CREATE TABLE pilot (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO pilot (id) VALUES ('preserved')").run();
    database.close();
    runRepair(databasePath);

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

function assertFailedFirstDatabaseSyncIsRemoved({ withCurrentStamp = false } = {}) {
  const { directory, databasePath, cleanup } = fixture();
  const fakeBin = join(directory, "fake-bin");
  const fakeNpm = join(fakeBin, "npm");
  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeNpm, `#!/bin/sh
if [ "$1" = "exec" ]; then
  printf 'partial database' > "$TEST_DATABASE_PATH"
  printf 'partial wal' > "$TEST_DATABASE_PATH-wal"
  printf 'partial shm' > "$TEST_DATABASE_PATH-shm"
  printf 'partial journal' > "$TEST_DATABASE_PATH-journal"
  exit 1
fi
exit 0
`);
    chmodSync(fakeNpm, 0o755);
    if (withCurrentStamp) {
      writeFileSync(
        join(directory, "app-prepare-stamps.json"),
        `${JSON.stringify({ schemaHash: currentSchemaHash() })}\n`
      );
    }
    const result = runDatabaseOnly(directory, databasePath, {
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      TEST_DATABASE_PATH: databasePath
    });
    assert.equal(result.status, 43, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /prior database state was restored|incomplete newly created database/i);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      assert.equal(existsSync(`${databasePath}${suffix}`), false, `partial database${suffix} survived`);
    }
    assert.equal(
      existsSync(join(directory, "runtime", "database-recovery-required.json")),
      false,
      "successful absence restoration must clear its recovery marker"
    );
  } finally {
    cleanup();
  }
}

test("a failed first database sync removes every partial SQLite file before reporting safe recovery", () => {
  assertFailedFirstDatabaseSyncIsRemoved();
});

test("a missing database with a current schema stamp still uses recoverable creation", () => {
  assertFailedFirstDatabaseSyncIsRemoved({ withCurrentStamp: true });
});

test("a killed schema sync restores the pre-repair database on the next launch", { skip: process.platform === "win32" }, () => {
  const { directory, databasePath, cleanup } = fixture();
  const fakeBin = join(directory, "fake-bin");
  const fakeNpm = join(fakeBin, "npm");
  try {
    let database = new Database(databasePath);
    createLegacyDraftTable(database);
    insertDraft(database, "old", "thread-1", "older", "2026-08-20T10:00:00.000Z");
    insertDraft(database, "new", "thread-1", "newer", "2026-08-21T10:00:00.000Z");
    database.close();

    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeNpm, `#!/bin/sh
if [ "$1" = "exec" ]; then
  kill -KILL "$PPID"
  exit 137
fi
exit 0
`);
    chmodSync(fakeNpm, 0o755);
    const killed = runDatabaseOnly(directory, databasePath, {
      PATH: `${fakeBin}:${process.env.PATH || ""}`
    });
    assert.equal(killed.signal, "SIGKILL", `stdout:\n${killed.stdout}\nstderr:\n${killed.stderr}`);
    assert.equal(
      existsSync(join(directory, "runtime", "database-recovery-required.json")),
      true,
      "the recovery intent must predate repair and sync"
    );
    database = new Database(databasePath, { readonly: true });
    assert.deepEqual(database.prepare("SELECT id FROM drafts").all(), [{ id: "new" }]);
    database.close();

    writeFileSync(fakeNpm, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeNpm, 0o755);
    const recovered = runDatabaseOnly(directory, databasePath, {
      PATH: `${fakeBin}:${process.env.PATH || ""}`
    });
    assert.equal(recovered.status, 1, `stdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    database = new Database(databasePath, { readonly: true });
    assert.deepEqual(
      database.prepare("SELECT id FROM drafts ORDER BY id").all(),
      [{ id: "new" }, { id: "old" }],
      "the verified pre-repair database must be restored before any retry work"
    );
    database.close();
    assert.equal(existsSync(join(directory, "runtime", "database-recovery-required.json")), false);
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
  assert.match(backupHelper, /rename\(temporary, destination\)/);
  assert.match(backupHelper, /rename\(temporary, destination\)[\s\S]*restoredFile\.sync\(\)[\s\S]*destinationDirectory\.sync\(\)/);
  assert.doesNotMatch(backupHelper, /copyFile\(temporary, destination\)/);
  const preparation = launcher.slice(launcher.indexOf("function prepare()"), launcher.indexOf("function delay("));
  const restoreHelper = launcher.slice(
    launcher.indexOf("function restoreDatabaseAfterFailedSchemaChange"),
    launcher.indexOf("function packagedArtifactsReady")
  );
  const backupRestore = restoreHelper.slice(restoreHelper.indexOf("if (!backupPath) return false;"));
  assert.ok(
    backupRestore.indexOf('recordDatabaseRecoveryFailure(backupPath, "restore-backup")') <
      backupRestore.indexOf("backup-sqlite.mjs"),
    "the durable recovery marker must exist before SQLite replacement begins"
  );
  assert.ok(
    backupRestore.indexOf("clearDatabaseRecoveryFailure()") >
      backupRestore.indexOf("result.status !== 0"),
    "the recovery marker is cleared only after a successful restore"
  );
  assert.match(
    launcher,
    /function clearDatabaseRecoveryFailure\(\)[\s\S]*rmSync\(DATABASE_RECOVERY_REQUIRED_PATH\);[\s\S]*fsyncDirectory\(directory\);/
  );
  assert.match(launcher, /function fsyncDirectory\(path\) \{\s*if \(process\.platform === "win32"\) return;/);
  assert.match(
    launcher,
    /if \(existsSync\(DATABASE_RECOVERY_REQUIRED_PATH\)\)[\s\S]*sameLegacyRestore[\s\S]*sameCurrentRecovery[\s\S]*fsyncSync\(existingDescriptor\)/
  );
  const backupAt = preparation.indexOf("backupDatabaseBeforeSchemaChange(schemaHash)");
  const repairAt = preparation.indexOf("repairDatabaseSchemaData");
  const syncAt = preparation.indexOf("syncDatabase");
  const restoreAt = preparation.indexOf("restoreDatabaseAfterFailedSchemaChange");
  assert.ok(backupAt >= 0 && repairAt > backupAt && syncAt > repairAt);
  assert.ok(restoreAt > syncAt);
  const syncHelper = launcher.slice(
    launcher.indexOf("function syncDatabase()"),
    launcher.indexOf("function backupDatabaseBeforeSchemaChange")
  );
  assert.match(syncHelper, /return synced && repairDatabaseSchemaData\(\)/);

  const updater = readFileSync("scripts/update-student.mjs", "utf8");
  const dependencyStep = updater.slice(
    updater.indexOf('execWithPreparationLease("npm", ["run", "db:generate"]'),
    updater.indexOf(
      "if (!RESIGN_BUNDLE)",
      updater.indexOf('execWithPreparationLease("npm", ["run", "db:generate"]')
    )
  );
  const buildOnlyAt = dependencyStep.indexOf('start-app.mjs", "--build-only"');
  const databaseOnlyAt = dependencyStep.indexOf('start-app.mjs", "--database-only"');
  assert.ok(buildOnlyAt >= 0 && databaseOnlyAt > buildOnlyAt);
  assert.doesNotMatch(dependencyStep, /db:push/);

  const installer = readFileSync("scripts/install-student-macos.sh", "utf8");
  const installDatabaseStep = installer.slice(
    installer.indexOf('run_prepared "Preparing the local database..."'),
    installer.indexOf('ok "Local database ready"')
  );
  assert.match(installDatabaseStep, /start-app\.mjs --database-only/);
  assert.doesNotMatch(installDatabaseStep, /db:push/);

  assert.match(launcher, /const BUILD_ONLY = args\.has\("--build-only"\)/);
  assert.match(preparation, /if \(!BUILD_ONLY\) \{[\s\S]*applyRecoverableSchemaChange/);
  assert.match(preparation, /error instanceof SchemaChangeRestoredError/);

  const runner = readFileSync("apps/runner/src/index.ts", "utf8");
  const draftRoute = runner.slice(
    runner.indexOf('app.post("/control/thread/:threadId/draft"'),
    runner.indexOf('app.post("/control/thread/:threadId/delete-draft"')
  );
  assert.match(draftRoute, /prisma\.draft\.upsert\(\{/);
  assert.match(draftRoute, /where:\s*\{ threadId \}/);
  assert.doesNotMatch(draftRoute, /draft\.findFirst/);
});
