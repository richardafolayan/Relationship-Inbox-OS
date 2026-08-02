import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function tableExists(database, table) {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table)
  );
}

export function repairDatabaseBeforeSchemaSync(databasePath) {
  if (!existsSync(databasePath)) return { removedDrafts: 0, clearedReplyLinks: 0 };

  const Database = require("better-sqlite3");
  const database = new Database(databasePath);
  try {
    let removedDrafts = 0;
    let clearedReplyLinks = 0;
    database.transaction(() => {
      if (tableExists(database, "drafts")) {
        const drafts = database
          .prepare(
            `SELECT id, threadId, text, updatedAt, createdAt
             FROM drafts
             ORDER BY threadId,
               CASE WHEN trim(text) = '' THEN 1 ELSE 0 END,
               updatedAt DESC,
               createdAt DESC,
               id DESC`
          )
          .all();
        const seenThreads = new Set();
        const remove = database.prepare("DELETE FROM drafts WHERE id = ?");
        for (const draft of drafts) {
          if (!seenThreads.has(draft.threadId)) {
            seenThreads.add(draft.threadId);
            continue;
          }
          removedDrafts += remove.run(draft.id).changes;
        }
      }

      if (tableExists(database, "messages")) {
        clearedReplyLinks = database
          .prepare(
            `UPDATE messages
             SET replyToMessageId = NULL
             WHERE replyToMessageId IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM messages AS parent
                 WHERE parent.id = messages.replyToMessageId
                   AND parent.threadId = messages.threadId
               )`
          )
          .run().changes;
      }
    })();
    return { removedDrafts, clearedReplyLinks };
  } finally {
    database.close();
  }
}
