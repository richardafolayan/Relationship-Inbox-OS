import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { IMessageDb } from "../apps/runner/dist/platforms/imessage-db.js";
import { IMessageAdapter } from "../apps/runner/dist/platforms/imessage-adapter.js";

// Incremental iMessage scan gate (perf rank 13). The watcher fires a scan on
// every chat.db write, and candidate discovery alone (listThreads' per-chat
// subqueries) costs seconds of SYNCHRONOUS SQLite on a real library - so the
// gate must be able to answer "did anything change, and where?" from cheap
// indexed reads. These tests pin the three signals (insert / delete / read
// flip) and that the by-guid stub fetch matches the full sweep's shaping.

const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;
function unixMsToAppleNs(unixMs) {
  return (unixMs - APPLE_EPOCH_OFFSET_MS) * 1e6;
}

function buildFixtureDb(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      chat_identifier TEXT,
      display_name TEXT,
      service_name TEXT,
      style INTEGER,
      last_read_message_timestamp INTEGER
    );
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT,
      service TEXT
    );
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      is_from_me INTEGER,
      is_read INTEGER,
      date INTEGER,
      associated_message_type INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  // IMessageDb opens read-only and runs `pragma journal_mode = WAL`, which is
  // a no-op on the real (already-WAL) chat.db but a write on a fresh
  // delete-mode DB. Put the fixture in WAL mode up front.
  db.pragma("journal_mode = WAL");
  return db;
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "imessage-watermark-"));
  const path = join(dir, "chat.db");
  const db = buildFixtureDb(path);

  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)").run(1, "+447700900111", "iMessage");
  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)").run(2, "+447700900222", "iMessage");

  db.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name, style, last_read_message_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(1, "iMessage;-;+447700900111", "+447700900111", null, "iMessage", 45, 1000);
  db.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name, style, last_read_message_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(2, "iMessage;-;+447700900222", "+447700900222", null, "iMessage", 45, 2000);
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)").run();
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2)").run();

  const baseMs = Date.UTC(2026, 0, 10, 12, 0, 0);
  const insertMessage = (rowid, chatId, text, fromMe, offsetMin) => {
    db.prepare(
      "INSERT INTO message (ROWID, guid, text, is_from_me, is_read, date, associated_message_type) VALUES (?, ?, ?, ?, 1, ?, 0)"
    ).run(rowid, `msg-${rowid}`, text, fromMe ? 1 : 0, unixMsToAppleNs(baseMs + offsetMin * 60_000));
    db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(chatId, rowid);
  };
  insertMessage(1, 1, "hey", false, 0);
  insertMessage(2, 1, "you around?", false, 1);
  insertMessage(3, 1, "yes!", true, 2);
  insertMessage(4, 2, "lunch tomorrow?", false, 3);

  return { dir, path, db, baseMs, insertMessage };
}

test("getScanWatermark reflects max rowid, row count and the chat read mark", () => {
  const f = makeFixture();
  try {
    const idb = new IMessageDb(f.path);
    const w = idb.getScanWatermark();
    assert.equal(w.maxRowId, 4);
    assert.equal(w.msgCount, 4);
    assert.equal(w.readMark, "2000");
    idb.close();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("listChangedChatGuids: new rows surface the chat; read flips surface the chat; otherwise empty", () => {
  const f = makeFixture();
  try {
    const idb = new IMessageDb(f.path);
    const before = idb.getScanWatermark();

    // Nothing changed -> empty.
    assert.deepEqual(idb.listChangedChatGuids(before.maxRowId, before.readMark), []);

    // A new message in chat 2 -> exactly chat 2.
    f.insertMessage(5, 2, "or thursday?", false, 4);
    assert.deepEqual(idb.listChangedChatGuids(before.maxRowId, before.readMark), [
      "iMessage;-;+447700900222"
    ]);

    // Reading chat 1 (its read watermark advances past the stored mark)
    // surfaces chat 1 even with no new rows since rowid 5.
    f.db.prepare("UPDATE chat SET last_read_message_timestamp = 3000 WHERE ROWID = 1").run();
    const changed = idb.listChangedChatGuids(5, before.readMark);
    assert.deepEqual(changed, ["iMessage;-;+447700900111"]);
    idb.close();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("listThreadsByGuids matches the full sweep's shaping and automated-sender filtering", () => {
  const f = makeFixture();
  try {
    // An automated short-code 1:1 chat: the full sweep filters it, the
    // by-guid fetch must too (parity - it must never resurface chats the
    // sweep would hide).
    f.db.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name, style, last_read_message_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(3, "SMS;-;62884", "62884", null, "SMS", 45, 0);
    f.insertMessage(6, 3, "Your code is 123456", false, 5);

    const idb = new IMessageDb(f.path);
    const swept = idb.listThreads(10, { unreadOnly: false });
    const byGuids = idb.listThreadsByGuids([
      "iMessage;-;+447700900111",
      "iMessage;-;+447700900222",
      "SMS;-;62884"
    ]);

    assert.equal(byGuids.some((r) => r.chatIdentifier === "62884"), false, "automated chat filtered");
    assert.equal(swept.some((r) => r.chatIdentifier === "62884"), false, "sweep filters it too");

    for (const row of byGuids) {
      const sweptRow = swept.find((r) => r.guid === row.guid);
      assert.ok(sweptRow, `sweep also returns ${row.guid}`);
      assert.deepEqual(row, sweptRow, `by-guid row matches sweep row for ${row.guid}`);
    }
    assert.deepEqual(idb.listThreadsByGuids([]), []);
    idb.close();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("adapter watermark round-trips and collectChangedThreads returns exactly the changed chat", async () => {
  const f = makeFixture();
  try {
    const adapter = new IMessageAdapter({ dbPath: f.path, useAddressBook: false });
    const watermark = await adapter.getScanWatermark();
    assert.equal(watermark, "imsg1:4:4:2000");

    // Unchanged -> no stubs, no full sweep.
    const unchanged = await adapter.collectChangedThreads(watermark);
    assert.deepEqual(unchanged, { stubs: [], fullSweepRequired: false });

    // One new message -> one stub for that chat only.
    f.insertMessage(5, 2, "or thursday?", false, 4);
    const delta = await adapter.collectChangedThreads(watermark);
    assert.equal(delta.fullSweepRequired, false);
    assert.equal(delta.stubs.length, 1);
    assert.equal(delta.stubs[0].platformThreadId, "iMessage;-;+447700900222");
    assert.equal(delta.stubs[0].isRecentCandidate, true);

    // Unknown / older watermark format -> full sweep requested.
    const legacy = await adapter.collectChangedThreads("v0:1:2:3");
    assert.equal(legacy.fullSweepRequired, true);

    await adapter.closeSession();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("adapter requests a full sweep when message rows disappeared (unsend/deletion)", async () => {
  const f = makeFixture();
  try {
    const adapter = new IMessageAdapter({ dbPath: f.path, useAddressBook: false });
    const watermark = await adapter.getScanWatermark();

    // Delete a non-max row: maxRowId stays 4, count drops to 3. The count
    // detector must force a full sweep - deletions can't be attributed to a
    // chat cheaply and the retraction sweep runs per synced thread.
    f.db.prepare("DELETE FROM chat_message_join WHERE message_id = 2").run();
    f.db.prepare("DELETE FROM message WHERE ROWID = 2").run();

    const result = await adapter.collectChangedThreads(watermark);
    assert.equal(result.fullSweepRequired, true);

    // A deletion masked by inserts (count net unchanged, rowids advanced
    // further than the count did) is also caught.
    f.insertMessage(5, 2, "new", false, 4);
    const masked = await adapter.collectChangedThreads(watermark);
    assert.equal(masked.fullSweepRequired, true);

    await adapter.closeSession();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
