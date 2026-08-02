import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairDatabaseBeforeSchemaSync } from "../scripts/lib/preflight-schema-repairs.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

test("preflight keeps one useful draft per thread and clears cross-thread replies", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-preflight-"));
  const path = join(root, "test.sqlite");
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        text TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        replyToMessageId TEXT
      );
      INSERT INTO drafts VALUES
        ('empty-new', 'thread-1', ' ', '2026-08-03', '2026-08-03'),
        ('useful-old', 'thread-1', 'old', '2026-08-01', '2026-08-01'),
        ('useful-new', 'thread-1', 'new', '2026-08-02', '2026-08-02');
      INSERT INTO messages VALUES
        ('parent', 'thread-1', NULL),
        ('valid-child', 'thread-1', 'parent'),
        ('cross-thread-child', 'thread-2', 'parent'),
        ('missing-child', 'thread-2', 'missing');
    `);
  } finally {
    database.close();
  }

  try {
    assert.deepEqual(repairDatabaseBeforeSchemaSync(path), {
      removedDrafts: 2,
      clearedReplyLinks: 2
    });
    const reopened = new Database(path);
    try {
      assert.deepEqual(reopened.prepare("SELECT id FROM drafts").all(), [{ id: "useful-new" }]);
      assert.deepEqual(
        reopened.prepare("SELECT id, replyToMessageId FROM messages ORDER BY id").all(),
        [
          { id: "cross-thread-child", replyToMessageId: null },
          { id: "missing-child", replyToMessageId: null },
          { id: "parent", replyToMessageId: null },
          { id: "valid-child", replyToMessageId: "parent" }
        ]
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
