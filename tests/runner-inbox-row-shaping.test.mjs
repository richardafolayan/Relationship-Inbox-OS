import test from "node:test";
import assert from "node:assert/strict";
import { shapeThreadRows, toInboxRow } from "../apps/runner/dist/services/thread-row-shaping.js";

const THRESHOLDS = { amberHours: 6, redHours: 18 };
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

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
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
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
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.unreadCount, 0);
  assert.equal(shaped.needsReply, true);
});

// Risk is recomputed at view time from the timestamps + current thresholds,
// not read from the level frozen at the last scan/send. Timestamps are
// relative to now so the waited durations are deterministic.
test("toInboxRow recomputes a long-overdue inbound to RED even when the stored level says GREEN", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "stale-green",
      riskLevel: "GREEN",
      lastInboundAt: hoursAgo(30),
      lastOutboundAt: hoursAgo(40)
    })
  ]);
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.needsReply, true);
  assert.equal(shaped.riskLevel, "RED");
});

test("toInboxRow recomputes a fresh inbound to GREEN even when the stored level says RED", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "stale-red",
      riskLevel: "RED",
      lastInboundAt: hoursAgo(1),
      lastOutboundAt: hoursAgo(50)
    })
  ]);
  assert.equal(toInboxRow(rows[0], 1, THRESHOLDS).riskLevel, "GREEN");
});

test("toInboxRow recomputes an inbound past the amber threshold to AMBER", () => {
  const rows = shapeThreadRows([
    buildRow({ id: "amber", riskLevel: "GREEN", lastInboundAt: hoursAgo(8), lastOutboundAt: hoursAgo(40) })
  ]);
  assert.equal(toInboxRow(rows[0], 1, THRESHOLDS).riskLevel, "AMBER");
});

test("toInboxRow keeps a replied thread GREEN with no SLA countdown regardless of the stored level", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "replied",
      riskLevel: "RED",
      lastInboundAt: hoursAgo(30),
      lastOutboundAt: hoursAgo(1)
    })
  ]);
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.needsReply, false);
  assert.equal(shaped.riskLevel, "GREEN");
  assert.equal(shaped.slaCountdown, "");
});

test("toInboxRow risk reflects the CURRENT thresholds, not the scan-time ones", () => {
  const rows = shapeThreadRows([
    buildRow({ id: "thresh", riskLevel: "GREEN", lastInboundAt: hoursAgo(7), lastOutboundAt: hoursAgo(40) })
  ]);
  assert.equal(toInboxRow(rows[0], 1, { amberHours: 6, redHours: 18 }).riskLevel, "AMBER");
  assert.equal(toInboxRow(rows[0], 1, { amberHours: 8, redHours: 18 }).riskLevel, "GREEN");
});

test("iMessage siblings collapse to the most-recent-inbound row, not the highest message count", () => {
  // Serena bug: one Person, two handle-chats. The phone thread is dormant but
  // enormous; the email thread is small but where the live conversation is.
  // The representative (preview + whatTheyWant + link target) must be the
  // LIVE email thread despite the phone thread having far more messages.
  const stalePhone = buildRow({
    id: "imsg-phone",
    platform: "IMESSAGE",
    platformThreadId: "any;-;+447873519605",
    personId: "serena",
    person: { id: "serena", displayName: "Serena", platform: "IMESSAGE" },
    whatTheyWant: "STALE: weighing whether to push Praise to the ball",
    lastMessageText: "Tried convince praise to go but she ain't hearing it",
    lastInboundAt: new Date("2026-06-04T14:50:00.000Z"),
    lastMessageAt: new Date("2026-06-04T14:50:00.000Z"),
    lastOutboundAt: new Date("2026-06-04T14:49:00.000Z"),
    _count: { messages: 7313 }
  });
  const liveEmail = buildRow({
    id: "imsg-email",
    platform: "IMESSAGE",
    platformThreadId: "any;-;shared@example.com",
    personId: "serena",
    person: { id: "serena", displayName: "Serena", platform: "IMESSAGE" },
    whatTheyWant: "FRESH: has a free award ticket and is seeing who else is going",
    lastMessageText: "So I'm tryna see who's going asw",
    lastInboundAt: new Date("2026-06-05T13:25:00.000Z"),
    lastMessageAt: new Date("2026-06-05T13:25:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T13:22:00.000Z"),
    _count: { messages: 345 }
  });

  const rows = shapeThreadRows([stalePhone, liveEmail]);
  assert.equal(rows.length, 1, "the two handle-chats collapse to one person row");
  assert.equal(rows[0].source.id, "imsg-email", "representative is the live email thread");

  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.whatTheyWant, "FRESH: has a free award ticket and is seeing who else is going");
  assert.equal(shaped.preview, "So I'm tryna see who's going asw");
});

test("toInboxRow maps a favourited contact's favouritedAt to personFavourite (R-0066)", () => {
  const favourited = shapeThreadRows([
    buildRow({ id: "fav", person: { favouritedAt: new Date("2026-06-05T12:00:00.000Z") } })
  ]);
  assert.equal(toInboxRow(favourited[0], 1, THRESHOLDS).personFavourite, true);

  const notFavourited = shapeThreadRows([buildRow({ id: "plain", person: { favouritedAt: null } })]);
  assert.equal(toInboxRow(notFavourited[0], 1, THRESHOLDS).personFavourite, false);
});
