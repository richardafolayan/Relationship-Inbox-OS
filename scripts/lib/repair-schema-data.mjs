#!/usr/bin/env node

import { isAbsolute } from "node:path";
import Database from "better-sqlite3";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Usage: repair-schema-data.mjs <database.sqlite>");
if (!isAbsolute(databasePath)) throw new Error("SQLite database path must be absolute");

const database = new Database(databasePath);
try {
  const draftsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'drafts'")
    .get();
  if (draftsTable) {
    database.transaction(() => {
      const drafts = database
        .prepare(
          'SELECT "id", "threadId" FROM "drafts" ORDER BY "threadId" ASC, "updatedAt" DESC, "id" ASC'
        )
        .all();
      const deleteDraft = database.prepare('DELETE FROM "drafts" WHERE "id" = ?');
      let previousThreadId;
      for (const draft of drafts) {
        if (draft.threadId === previousThreadId) deleteDraft.run(draft.id);
        else previousThreadId = draft.threadId;
      }
    }).immediate();
  }
} finally {
  database.close();
}
