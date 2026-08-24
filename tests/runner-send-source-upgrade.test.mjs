import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  hasSendRequestSourceColumn,
  repairSendRequestSource,
  sendRequestSourceRequiresRepair
} from "../scripts/lib/repair-schema-data.mjs";

test("a database without send requests needs no provenance repair", () => {
  const database = new Database(":memory:");
  try {
    assert.equal(hasSendRequestSourceColumn(database), false);
    assert.equal(sendRequestSourceRequiresRepair(database), false);
    assert.deepEqual(repairSendRequestSource(database), { columnAdded: false });
  } finally {
    database.close();
  }
});

test("legacy send requests gain durable manual provenance before Prisma sync", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE "send_requests" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "clientSendId" TEXT NOT NULL,
        "threadId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "requestText" TEXT NOT NULL
      );
      INSERT INTO "send_requests" (
        "id", "clientSendId", "threadId", "requestText"
      ) VALUES ('send-1', 'client-1', 'thread-1', 'hello');
    `);

    assert.equal(hasSendRequestSourceColumn(database), false);
    assert.equal(sendRequestSourceRequiresRepair(database), true);
    assert.deepEqual(repairSendRequestSource(database), { columnAdded: true });
    assert.equal(hasSendRequestSourceColumn(database), true);
    assert.equal(sendRequestSourceRequiresRepair(database), false);
    assert.equal(
      database.prepare('SELECT "source" FROM "send_requests" WHERE "id" = ?').get("send-1").source,
      "manual"
    );
    assert.deepEqual(repairSendRequestSource(database), { columnAdded: false });
  } finally {
    database.close();
  }
});
