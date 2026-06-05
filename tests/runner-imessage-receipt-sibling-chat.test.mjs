import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { IMessageDb } from "../apps/runner/dist/platforms/imessage-db.js";

// Regression for the iMessage send-receipt lookup keying on the wrong chat.
//
// A contact owns two separate 1:1 chats in chat.db: an SMS-only phone chat
// (the one the Thread happens to be keyed by) and an iMessage email chat.
// pickBestSendHandle prefers the iMessage email, so Messages.app delivers the
// just-sent message into the EMAIL chat — a different chat.ROWID/guid than
// thread.platformThreadId. The post-send receipt lookups must therefore key
// on the picked handle's own chat, not the original thread guid, or they miss
// the sent row (no guid -> later scan re-inserts a duplicate; no delivery
// confirmation; no attachments).

// Apple absolute-time epoch (2001-01-01) offset from unix-ms, mirroring
// imessage-db.ts. Dates in chat.db are nanoseconds since this epoch.
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;
function unixMsToAppleNs(unixMs) {
  return (unixMs - APPLE_EPOCH_OFFSET_MS) * 1e6;
}

// Build the minimal chat.db schema the IMessageDb queries touch.
function buildFixtureDb(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      chat_identifier TEXT,
      display_name TEXT,
      service_name TEXT,
      style INTEGER
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
      is_sent INTEGER,
      is_delivered INTEGER,
      error INTEGER,
      service TEXT,
      date INTEGER,
      cache_has_attachments INTEGER,
      handle_id INTEGER,
      associated_message_type INTEGER,
      associated_message_guid TEXT,
      thread_originator_guid TEXT
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  // IMessageDb opens read-only and runs `pragma journal_mode = WAL`, which is a
  // no-op on the real (already-WAL) chat.db but a write on a fresh delete-mode
  // DB. Put the fixture in WAL mode up front so the read-only open never writes.
  db.pragma("journal_mode = WAL");
  return db;
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "imessage-receipt-"));
  const path = join(dir, "chat.db");
  const db = buildFixtureDb(path);

  // Two handles for one contact: SMS phone + iMessage email.
  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)").run(1, "+447700900111", "SMS");
  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)").run(2, "contact@example.com", "iMessage");

  // Two distinct 1:1 chats. The phone chat is what the Thread is keyed by;
  // the email chat is where the send actually lands.
  db.prepare("INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (?, ?, ?, ?, ?)")
    .run(10, "PHONE-CHAT-GUID", "+447700900111", "SMS", 45);
  db.prepare("INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (?, ?, ?, ?, ?)")
    .run(11, "EMAIL-CHAT-GUID", "contact@example.com", "iMessage", 45);
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(10, 1);
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(11, 2);

  // A group chat that ALSO contains the email handle — must never be picked.
  db.prepare("INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (?, ?, ?, ?, ?)")
    .run(20, "GROUP-CHAT-GUID", "chat999", "iMessage", 43);
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(20, 2);
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(20, 1);

  // An older inbound in the phone chat so it has some history.
  db.prepare(
    `INSERT INTO message (ROWID, guid, text, is_from_me, is_sent, is_delivered, error, service, date, cache_has_attachments, handle_id, associated_message_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(100, "OLD-IN-GUID", "hi", 0, 0, 0, 0, "SMS", unixMsToAppleNs(Date.now() - 60_000), 0, 1, 0);

  return { dir, path, db };
}

test("findChatGuidForHandle resolves the 1:1 chat for the picked sibling handle", () => {
  const { dir, db } = makeFixture();
  try {
    db.close();
    const idb = new IMessageDb(join(dir, "chat.db"));
    assert.equal(idb.findChatGuidForHandle("contact@example.com"), "EMAIL-CHAT-GUID");
    assert.equal(idb.findChatGuidForHandle("+447700900111"), "PHONE-CHAT-GUID");
    idb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findChatGuidForHandle ignores group chats and unknown handles", () => {
  const { dir, db } = makeFixture();
  try {
    db.close();
    const idb = new IMessageDb(join(dir, "chat.db"));
    // The group chat (style 43, 2 participants) must not be returned for the
    // email handle — only its real 1:1 chat is.
    assert.notEqual(idb.findChatGuidForHandle("contact@example.com"), "GROUP-CHAT-GUID");
    assert.equal(idb.findChatGuidForHandle("nobody@nowhere.com"), undefined);
    idb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt lookup finds the sent row via the picked handle's chat, not the thread guid", () => {
  const { dir, db } = makeFixture();
  try {
    const sendStartedAt = Date.now();
    // The freshly-sent outbound message lands ONLY in the email (iMessage)
    // chat — exactly what pickBestSendHandle routing produces.
    db.prepare(
      `INSERT INTO message (ROWID, guid, text, is_from_me, is_sent, is_delivered, error, service, date, cache_has_attachments, handle_id, associated_message_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(200, "SENT-OUT-GUID", "on my way", 1, 1, 1, 0, "iMessage", unixMsToAppleNs(sendStartedAt + 50), 0, 2, 0);
    db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(11, 200);
    db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(10, 100);
    db.close();

    const idb = new IMessageDb(join(dir, "chat.db"));
    const emailChatGuid = idb.findChatGuidForHandle("contact@example.com");
    assert.equal(emailChatGuid, "EMAIL-CHAT-GUID");

    // Fixed behaviour: key on the picked handle's chat -> finds the sent row.
    const found = idb.findOutboundDeliveryStatus(emailChatGuid, sendStartedAt - 1000);
    assert.ok(found, "delivery status should be found via the picked handle's chat");
    assert.equal(found.guid, "SENT-OUT-GUID");
    assert.equal(found.isDelivered, true);

    // Pre-fix behaviour: keying on the original thread (phone) guid misses it.
    const missed = idb.findOutboundDeliveryStatus("PHONE-CHAT-GUID", sendStartedAt - 1000);
    assert.equal(missed, undefined, "the original thread guid must NOT find the sibling-chat send");

    idb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
