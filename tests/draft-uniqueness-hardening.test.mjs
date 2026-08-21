import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const repairScript = resolve("scripts/lib/repair-schema-data.mjs");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tovi-draft-repair-"));
  const databasePath = join(directory, "inbox.sqlite");
  return {
    databasePath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function runRepair(databasePath) {
  execFileSync(process.execPath, [repairScript, databasePath], {
    cwd: resolve("."),
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

test("schema repair is a no-op when the legacy drafts table does not exist", () => {
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

test("schema repair keeps the newest draft per thread before UNIQUE is applied", () => {
  const { databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    createLegacyDraftTable(database);
    const insert = database.prepare(
      "INSERT INTO drafts (id, threadId, text, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run("old", "thread-1", "older", "2026-08-20T10:00:00.000Z", "2026-08-20T09:00:00.000Z");
    insert.run("new", "thread-1", "newest", "2026-08-21T10:00:00.000Z", "2026-08-21T09:00:00.000Z");
    insert.run("only", "thread-2", "single", "2026-08-19T10:00:00.000Z", "2026-08-19T09:00:00.000Z");
    database.close();

    runRepair(databasePath);

    database = new Database(databasePath, { readonly: true });
    assert.deepEqual(
      database.prepare("SELECT id, threadId, text FROM drafts ORDER BY threadId").all(),
      [
        { id: "new", threadId: "thread-1", text: "newest" },
        { id: "only", threadId: "thread-2", text: "single" }
      ]
    );
    database.close();

    database = new Database(databasePath);
    database.exec('CREATE UNIQUE INDEX "drafts_threadId_key" ON "drafts"("threadId")');
    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO drafts (id, threadId, text, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?)"
          )
          .run("duplicate", "thread-1", "blocked", "2026-08-22T10:00:00.000Z", "2026-08-22T09:00:00.000Z"),
      /UNIQUE constraint failed/
    );
    database.close();
  } finally {
    cleanup();
  }
});

test("schema repair uses a stable id tie-break when update timestamps match", () => {
  const { databasePath, cleanup } = fixture();
  try {
    let database = new Database(databasePath);
    createLegacyDraftTable(database);
    const insert = database.prepare(
      "INSERT INTO drafts (id, threadId, text, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run("z-draft", "thread-1", "z", "2026-08-21T10:00:00.000Z", "2026-08-21T09:00:00.000Z");
    insert.run("a-draft", "thread-1", "a", "2026-08-21T10:00:00.000Z", "2026-08-21T09:00:00.000Z");
    database.close();

    runRepair(databasePath);

    database = new Database(databasePath, { readonly: true });
    assert.deepEqual(database.prepare("SELECT id FROM drafts").all(), [{ id: "a-draft" }]);
    database.close();
  } finally {
    cleanup();
  }
});

test("schema, startup, and save route enforce the same unique-draft contract", () => {
  const schema = readFileSync("packages/core/prisma/schema.prisma", "utf8");
  const draftModel = schema.slice(schema.indexOf("model Draft"), schema.indexOf("model AuditLog"));
  assert.match(draftModel, /threadId\s+String\s+@unique/);
  assert.doesNotMatch(draftModel, /@@index\(\[threadId\]\)/);

  const runner = readFileSync("apps/runner/src/index.ts", "utf8");
  const draftRoute = runner.slice(
    runner.indexOf('app.post("/control/thread/:threadId/draft"'),
    runner.indexOf('app.post("/control/thread/:threadId/delete-draft"')
  );
  assert.match(draftRoute, /prisma\.draft\.upsert\(\{/);
  assert.match(draftRoute, /where:\s*\{ threadId \}/);
  assert.doesNotMatch(draftRoute, /draft\.findFirst/);

  const launcher = readFileSync("scripts/start-app.mjs", "utf8");
  const preparation = launcher.slice(launcher.indexOf("function prepare()"), launcher.indexOf("function delay("));
  const backupAt = preparation.indexOf("backupDatabaseBeforeSchemaChange(schemaHash)");
  const repairAt = preparation.indexOf("repairDatabaseBeforeSchemaChange()");
  const syncAt = preparation.indexOf("syncDatabase()");
  assert.ok(backupAt >= 0 && repairAt > backupAt && syncAt > repairAt);
  assert.match(launcher, /could not be repaired\. No schema change was applied\./);
});
