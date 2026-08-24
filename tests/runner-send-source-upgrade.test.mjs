import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  hasSendRequestSourceRepairMarker,
  hasSendRequestSourceColumn,
  repairSendRequestSource,
  sendRequestSourceRequiresRepair
} from "../scripts/lib/repair-schema-data.mjs";

function createSettingsTable(database) {
  database.exec(`
    CREATE TABLE "settings" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "key" TEXT NOT NULL UNIQUE,
      "valueJson" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL,
      "updatedAt" DATETIME NOT NULL
    );
  `);
}

test("a database without send requests needs no provenance repair", () => {
  const database = new Database(":memory:");
  try {
    assert.equal(hasSendRequestSourceColumn(database), false);
    assert.equal(sendRequestSourceRequiresRepair(database), false);
    assert.deepEqual(repairSendRequestSource(database), {
      columnAdded: false,
      legacyRowsMarkedUnknown: 0,
      markerAdded: false
    });
  } finally {
    database.close();
  }
});

test("legacy send requests fail closed with unknown provenance before Prisma sync", () => {
  const database = new Database(":memory:");
  try {
    createSettingsTable(database);
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
    assert.deepEqual(repairSendRequestSource(database), {
      columnAdded: true,
      legacyRowsMarkedUnknown: 1,
      markerAdded: true
    });
    assert.equal(hasSendRequestSourceColumn(database), true);
    assert.equal(hasSendRequestSourceRepairMarker(database), true);
    assert.equal(sendRequestSourceRequiresRepair(database), false);
    assert.equal(
      database.prepare('SELECT "source" FROM "send_requests" WHERE "id" = ?').get("send-1").source,
      "legacy_unknown"
    );
    assert.deepEqual(repairSendRequestSource(database), {
      columnAdded: false,
      legacyRowsMarkedUnknown: 0,
      markerAdded: false
    });
  } finally {
    database.close();
  }
});

test("the immediately preceding source-column schema is repaired exactly once", () => {
  const database = new Database(":memory:");
  try {
    createSettingsTable(database);
    database.exec(`
      CREATE TABLE "send_requests" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "clientSendId" TEXT NOT NULL UNIQUE,
        "threadId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "requestText" TEXT NOT NULL,
        "source" TEXT NOT NULL DEFAULT 'manual'
      );
      INSERT INTO "send_requests" (
        "id", "clientSendId", "threadId", "requestText", "source"
      ) VALUES
        ('send-manual', 'client-manual', 'thread-1', 'hello', 'manual'),
        ('send-focus', 'client-focus', 'thread-1', 'hello', 'focus_auto_ack');
    `);

    assert.equal(hasSendRequestSourceColumn(database), true);
    assert.equal(hasSendRequestSourceRepairMarker(database), false);
    assert.equal(sendRequestSourceRequiresRepair(database), true);
    assert.deepEqual(repairSendRequestSource(database), {
      columnAdded: false,
      legacyRowsMarkedUnknown: 2,
      markerAdded: true
    });
    assert.deepEqual(
      database
        .prepare('SELECT "source" FROM "send_requests" ORDER BY "id"')
        .all()
        .map((row) => row.source),
      ["legacy_unknown", "legacy_unknown"]
    );

    database
      .prepare(`
        INSERT INTO "send_requests" (
          "id", "clientSendId", "threadId", "requestText", "source"
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run("send-new", "client-new", "thread-1", "new", "manual");
    assert.deepEqual(repairSendRequestSource(database), {
      columnAdded: false,
      legacyRowsMarkedUnknown: 0,
      markerAdded: false
    });
    assert.equal(
      database.prepare('SELECT "source" FROM "send_requests" WHERE "id" = ?').get("send-new")
        .source,
      "manual"
    );
  } finally {
    database.close();
  }
});

test("provenance upgrade rolls back the new column when legacy relabelling fails", () => {
  const database = new Database(":memory:");
  try {
    createSettingsTable(database);
    database.exec(`
      CREATE TABLE "send_requests" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "source_guard" TEXT
      );
      INSERT INTO "send_requests" ("id") VALUES ('send-1');
      CREATE TRIGGER "reject_source_repair"
      BEFORE UPDATE ON "send_requests"
      BEGIN
        SELECT RAISE(ABORT, 'source repair rejected');
      END;
    `);

    assert.throws(() => repairSendRequestSource(database), /source repair rejected/);
    assert.equal(hasSendRequestSourceColumn(database), false);
    assert.equal(hasSendRequestSourceRepairMarker(database), false);
    assert.equal(sendRequestSourceRequiresRepair(database), true);
  } finally {
    database.close();
  }
});

test("provenance relabelling rolls back when the durable marker cannot be inserted", () => {
  const database = new Database(":memory:");
  try {
    createSettingsTable(database);
    database.exec(`
      CREATE TABLE "send_requests" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "source" TEXT NOT NULL DEFAULT 'manual'
      );
      INSERT INTO "send_requests" ("id", "source") VALUES ('send-1', 'manual');
      CREATE TRIGGER "reject_source_marker"
      BEFORE INSERT ON "settings"
      WHEN NEW."key" = 'data_repair_send_request_source_v2'
      BEGIN
        SELECT RAISE(ABORT, 'source marker rejected');
      END;
    `);

    assert.throws(() => repairSendRequestSource(database), /source marker rejected/);
    assert.equal(
      database.prepare('SELECT "source" FROM "send_requests" WHERE "id" = ?').get("send-1")
        .source,
      "manual"
    );
    assert.equal(hasSendRequestSourceRepairMarker(database), false);
    assert.equal(sendRequestSourceRequiresRepair(database), true);
  } finally {
    database.close();
  }
});

test("a malformed provenance marker fails closed without mutating requests", () => {
  const database = new Database(":memory:");
  try {
    createSettingsTable(database);
    const now = Date.now();
    database.exec(`
      CREATE TABLE "send_requests" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "source" TEXT NOT NULL
      );
      INSERT INTO "send_requests" ("id", "source") VALUES ('send-1', 'manual');
    `);
    database
      .prepare(`
        INSERT INTO "settings" (
          "id", "key", "valueJson", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        "data_repair_send_request_source_v2",
        "data_repair_send_request_source_v2",
        '{"version":1}',
        now,
        now
      );

    assert.throws(() => repairSendRequestSource(database), /marker is malformed/);
    assert.equal(
      database.prepare('SELECT "source" FROM "send_requests" WHERE "id" = ?').get("send-1")
        .source,
      "manual"
    );
    assert.equal(hasSendRequestSourceRepairMarker(database), false);
  } finally {
    database.close();
  }
});
