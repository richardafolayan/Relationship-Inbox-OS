import test from "node:test";
import assert from "node:assert/strict";
import { shapeThreadRows, toInboxRow } from "../apps/runner/dist/services/thread-row-shaping.js";

function buildRow(overrides = {}) {
  const base = {
    id: "thread-1",
    platform: "LINKEDIN",
    platformThreadId: "linkedin-temp:1",
    threadUrl: null,
    personId: "person-1",
    unreadCount: 0,
    needsReply: false,
    lastMessagePreview: "Inbound preview",
    lastMessageAt: new Date("2026-02-19T10:00:00.000Z"),
    lastInboundAt: new Date("2026-02-19T10:00:00.000Z"),
    lastOutboundAt: new Date("2026-02-19T09:00:00.000Z"),
    riskLevel: "GREEN",
    riskReason: "Replied",
    slaDueAt: null,
    whatTheyWant: null,
    rollingSummary: null,
    updatedAt: new Date("2026-02-19T10:00:00.000Z"),
    person: {
      id: "person-1",
      displayName: "Ada",
      platform: "LINKEDIN"
    },
    _count: {
      messages: 1
    }
  };

  return {
    ...base,
    ...overrides,
    person: {
      ...base.person,
      ...(overrides.person ?? {})
    },
    _count: {
      ...base._count,
      ...(overrides._count ?? {})
    }
  };
}

test("thread row shaping first-pass dedupes duplicate source rows by thread.id", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "thread-a",
      platformThreadId: "linkedin-temp:a",
      threadUrl: "https://www.linkedin.com/messaging/thread/thread-a/",
      _count: { messages: 5 },
      updatedAt: new Date("2026-02-19T10:00:00.000Z")
    }),
    buildRow({
      id: "thread-a",
      platformThreadId: "thread-a",
      threadUrl: "https://www.linkedin.com/messaging/thread/thread-a/",
      _count: { messages: 1 },
      updatedAt: new Date("2026-02-19T09:00:00.000Z")
    })
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source.id, "thread-a");
  assert.equal(rows[0].messageCount, 5);
});

test("thread row shaping excludes unresolved zero-message placeholders", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "placeholder",
      platformThreadId: "linkedin-temp:placeholder",
      threadUrl: null,
      _count: { messages: 0 }
    })
  ]);

  assert.equal(rows.length, 0);
});

test("thread row shaping keeps unresolved rows with messages and marks warning", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "unresolved-with-messages",
      platformThreadId: "linkedin-temp:with-msg",
      threadUrl: null,
      _count: { messages: 3 }
    })
  ]);

  assert.equal(rows.length, 1);
  const shaped = toInboxRow(rows[0]);
  assert.equal(shaped.identityWarning, "unresolved_id");
  assert.equal(shaped.messageCount, 3);
});

test("thread row shaping derives needsReply from inbound/outbound timestamps for read-but-unreplied", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "read-but-unreplied",
      unreadCount: 0,
      needsReply: false,
      lastInboundAt: new Date("2026-02-19T10:00:00.000Z"),
      lastOutboundAt: new Date("2026-02-19T09:00:00.000Z")
    })
  ]);

  assert.equal(rows.length, 1);
  const shaped = toInboxRow(rows[0]);
  assert.equal(shaped.unreadCount, 0);
  assert.equal(shaped.needsReply, true);
});
