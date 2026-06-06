import test from "node:test";
import assert from "node:assert/strict";
import { shapeThreadRows, toInboxRow } from "../apps/runner/dist/services/thread-row-shaping.js";

// Regression for PM16: the inbox row-shaper and the /data/thread endpoint must
// pick the canonical iMessage sibling over the SAME population. The thread
// endpoint re-picks canonical over ALL of a person's siblings (no
// archived/snoozed filter); loadVisibleThreadRows pre-filters to the visible
// subset before shaping. So when the live (most-recent-inbound) sibling is
// archived or snoozed, the inbox used to shape the dormant sibling and surface
// its STALE whatTheyWant/preview, while opening the thread showed the live
// sibling's FRESH brief — the "row says X, thread says Y" divergence #499 set
// out to kill, re-opened through the visibility filter.
//
// The fix passes shapeThreadRows the full, visibility-UNFILTERED sibling set so
// the row adopts the canonical sibling's AI fields, while the visible row stays
// the representative for identity + visibility (id / archivedAt / snoozedUntil).

const THRESHOLDS = { amberHours: 6, redHours: 18 };

function buildRow(overrides = {}) {
  const base = {
    id: "thread-1",
    platform: "IMESSAGE",
    platformThreadId: "any;-;handle",
    threadUrl: null,
    personId: "serena",
    unreadCount: 0,
    needsReply: false,
    lastMessagePreview: "Inbound preview",
    lastMessageText: "Inbound preview",
    lastMessageDirection: "IN",
    lastMessageAt: new Date("2026-06-04T10:00:00.000Z"),
    lastInboundAt: new Date("2026-06-04T10:00:00.000Z"),
    lastOutboundAt: new Date("2026-06-04T09:00:00.000Z"),
    riskLevel: "GREEN",
    riskReason: "Replied",
    slaDueAt: null,
    snoozedUntil: null,
    whatTheyWant: null,
    rollingSummary: null,
    archivedAt: null,
    category: null,
    closedStatus: null,
    closedStatusReason: null,
    reconnectScore: null,
    reconnectScoreReason: null,
    updatedAt: new Date("2026-06-04T10:00:00.000Z"),
    person: {
      id: "serena",
      displayName: "Serena",
      inferredName: null,
      platform: "IMESSAGE",
      avatarUrl: null,
      birthday: null,
      birthYear: null,
      favouritedAt: null
    },
    _count: { messages: 1 }
  };

  return {
    ...base,
    ...overrides,
    person: { ...base.person, ...(overrides.person ?? {}) },
    _count: { ...base._count, ...(overrides._count ?? {}) }
  };
}

// Serena: one Person, two handle-chats. The phone thread is dormant but
// enormous and still ACTIVE; the email thread is the live conversation but the
// operator has ARCHIVED that handle, so it never reaches the active inbox query.
const stalePhoneActive = buildRow({
  id: "imsg-phone",
  platformThreadId: "any;-;+447873519605",
  whatTheyWant: "STALE: weighing whether to push Praise to the ball",
  rollingSummary: "Stale phone-thread summary",
  lastMessageText: "Tried convince praise to go but she ain't hearing it",
  lastMessagePreview: "Tried convince praise to go but she ain't hearing it",
  lastInboundAt: new Date("2026-06-04T14:50:00.000Z"),
  lastMessageAt: new Date("2026-06-04T14:50:00.000Z"),
  lastOutboundAt: new Date("2026-06-04T14:49:00.000Z"),
  archivedAt: null,
  _count: { messages: 7313 }
});

const liveEmailArchived = buildRow({
  id: "imsg-email",
  platformThreadId: "any;-;seandserena@gmail.com",
  whatTheyWant: "FRESH: has a free award ticket and is seeing who else is going",
  rollingSummary: "Fresh email-thread summary",
  lastMessageText: "So I'm tryna see who's going asw",
  lastMessagePreview: "So I'm tryna see who's going asw",
  // Most-recent inbound => canonical, but archived out of the active inbox.
  lastInboundAt: new Date("2026-06-05T13:25:00.000Z"),
  lastMessageAt: new Date("2026-06-05T13:25:00.000Z"),
  lastOutboundAt: new Date("2026-06-05T13:22:00.000Z"),
  archivedAt: new Date("2026-06-05T13:30:00.000Z"),
  _count: { messages: 345 }
});

test("without the full sibling set, the inbox surfaces the stale visible sibling (the PM16 bug)", () => {
  // Active inbox only sees the phone thread (email is archived). This is the
  // pre-fix behaviour: the row reflects the dormant phone sibling.
  const rows = shapeThreadRows([stalePhoneActive]);
  assert.equal(rows.length, 1);
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.id, "imsg-phone");
  assert.equal(shaped.whatTheyWant, "STALE: weighing whether to push Praise to the ball");
  assert.equal(shaped.preview, "Tried convince praise to go but she ain't hearing it");
});

test("with the full sibling set, the visible row adopts the archived canonical sibling's AI fields", () => {
  // shapeThreadRows still only gets the VISIBLE rows as `rows` (email archived
  // out), but now also gets the full sibling set for canonical selection —
  // mirroring the thread endpoint, which picks canonical over all siblings.
  const rows = shapeThreadRows([stalePhoneActive], [stalePhoneActive, liveEmailArchived]);
  assert.equal(rows.length, 1, "the two handle-chats collapse to one person row");

  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);

  // AI fields now match the canonical (live email) sibling — the same values
  // the thread endpoint resolves and renders on the rail.
  assert.equal(
    shaped.whatTheyWant,
    "FRESH: has a free award ticket and is seeing who else is going",
    "whatTheyWant adopts the canonical sibling"
  );
  assert.equal(
    shaped.preview,
    "So I'm tryna see who's going asw",
    "preview adopts the canonical sibling's latest message"
  );

  // Identity + visibility STAY on the visible representative: the row links to
  // the active phone thread and is NOT marked archived, so it keeps showing in
  // the active inbox and the dashboard's archivedAt-keyed filters/styles behave.
  assert.equal(shaped.id, "imsg-phone", "link target stays the visible (active) sibling");
  assert.equal(shaped.archivedAt, null, "visible row's archived state is preserved");
  assert.equal(shaped.snoozedUntil, null, "visible row's snooze state is preserved");
});

test("with the full sibling set, a snoozed canonical sibling is still adopted for AI fields", () => {
  // Same divergence via snooze rather than archive.
  const liveEmailSnoozed = buildRow({
    id: "imsg-email",
    platformThreadId: "any;-;seandserena@gmail.com",
    whatTheyWant: "FRESH: has a free award ticket and is seeing who else is going",
    lastMessageText: "So I'm tryna see who's going asw",
    lastMessagePreview: "So I'm tryna see who's going asw",
    lastInboundAt: new Date("2026-06-05T13:25:00.000Z"),
    lastMessageAt: new Date("2026-06-05T13:25:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T13:22:00.000Z"),
    snoozedUntil: new Date("2026-06-09T13:30:00.000Z"),
    _count: { messages: 345 }
  });

  const rows = shapeThreadRows([stalePhoneActive], [stalePhoneActive, liveEmailSnoozed]);
  assert.equal(rows.length, 1);
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.whatTheyWant, "FRESH: has a free award ticket and is seeing who else is going");
  assert.equal(shaped.id, "imsg-phone");
  assert.equal(shaped.snoozedUntil, null);
});

test("when the canonical sibling is itself visible, the representative is unchanged", () => {
  // Both siblings active: the existing in-set canonical pick already chooses the
  // live email row, and passing the full set must not alter that result.
  const liveEmailActive = buildRow({
    id: "imsg-email",
    platformThreadId: "any;-;seandserena@gmail.com",
    whatTheyWant: "FRESH: has a free award ticket and is seeing who else is going",
    lastMessageText: "So I'm tryna see who's going asw",
    lastMessagePreview: "So I'm tryna see who's going asw",
    lastInboundAt: new Date("2026-06-05T13:25:00.000Z"),
    lastMessageAt: new Date("2026-06-05T13:25:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T13:22:00.000Z"),
    _count: { messages: 345 }
  });

  const both = [stalePhoneActive, liveEmailActive];
  const rows = shapeThreadRows(both, both);
  assert.equal(rows.length, 1);
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.id, "imsg-email", "live email row is both representative and canonical");
  assert.equal(shaped.whatTheyWant, "FRESH: has a free award ticket and is seeing who else is going");
});

test("a single-sibling iMessage person is unaffected by the canonical pass", () => {
  const solo = buildRow({
    id: "imsg-solo",
    personId: "lone",
    person: { id: "lone", displayName: "Lone" },
    whatTheyWant: "solo want",
    lastMessageText: "solo text"
  });
  const rows = shapeThreadRows([solo], [solo]);
  assert.equal(rows.length, 1);
  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  assert.equal(shaped.id, "imsg-solo");
  assert.equal(shaped.whatTheyWant, "solo want");
});
