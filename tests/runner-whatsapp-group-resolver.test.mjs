import test from "node:test";
import assert from "node:assert/strict";
import { chatToThreadStub } from "../apps/runner/dist/platforms/whatsapp/groupResolver.js";

test("chatToThreadStub maps a 1:1 chat to a non-group ThreadStub", () => {
  const stub = chatToThreadStub({
    id: { _serialized: "447111222333@c.us" },
    name: "Alice",
    isGroup: false,
    unreadCount: 2,
    timestamp: 1700000000,
    lastMessage: { body: "see you tomorrow" }
  });
  assert.equal(stub.platformThreadId, "447111222333@c.us");
  // v1 ThreadStub carries the jid in platformThreadId (no separate handle field).
  assert.equal(stub.displayName, "Alice");
  assert.equal(stub.isGroup, false);
  assert.equal(stub.groupName, undefined);
  assert.equal(stub.unreadCount, 2);
  assert.equal(stub.isUnreadCandidate, true);
  assert.equal(stub.lastMessagePreview, "see you tomorrow");
  assert.equal(stub.lastMessageAt, "2023-11-14T22:13:20.000Z");
});

test("chatToThreadStub maps a group chat to a group ThreadStub with groupName set", () => {
  const stub = chatToThreadStub({
    id: { _serialized: "12345-67890@g.us" },
    name: "Lads weekend",
    isGroup: true,
    unreadCount: 5,
    timestamp: 1700000000,
    lastMessage: { body: "who's driving" }
  });
  assert.equal(stub.isGroup, true);
  assert.equal(stub.groupName, "Lads weekend");
  assert.equal(stub.platformThreadId, "12345-67890@g.us");
  assert.equal(stub.displayName, "Lads weekend");
});

test("chatToThreadStub falls back to 'Unnamed group' when a group has no name", () => {
  const stub = chatToThreadStub({
    id: { _serialized: "12345-67890@g.us" },
    isGroup: true
  });
  assert.equal(stub.displayName, "Unnamed group");
  assert.equal(stub.groupName, "Unnamed group");
});

test("chatToThreadStub falls back to the JID when a 1:1 chat has no name", () => {
  const stub = chatToThreadStub({
    id: { _serialized: "447111222333@c.us" },
    isGroup: false
  });
  assert.equal(stub.displayName, "447111222333@c.us");
});

test("chatToThreadStub flags isUnreadCandidate only when unreadCount > 0", () => {
  assert.equal(
    chatToThreadStub({ id: { _serialized: "x@c.us" }, unreadCount: 0 }).isUnreadCandidate,
    false
  );
  assert.equal(
    chatToThreadStub({ id: { _serialized: "x@c.us" } }).isUnreadCandidate,
    false
  );
});

test("chatToThreadStub omits lastMessageAt when the chat has no timestamp", () => {
  const stub = chatToThreadStub({ id: { _serialized: "x@c.us" } });
  assert.equal(stub.lastMessageAt, undefined);
});

test("chatToThreadStub truncates the lastMessage preview at 280 chars", () => {
  const long = "x".repeat(500);
  const stub = chatToThreadStub({
    id: { _serialized: "x@c.us" },
    lastMessage: { body: long }
  });
  assert.equal(stub.lastMessagePreview.length, 280);
});
