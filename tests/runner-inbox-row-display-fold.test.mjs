import test from "node:test";
import assert from "node:assert/strict";
import { shapeThreadRows, toInboxRow } from "../apps/runner/dist/services/thread-row-shaping.js";

const THRESHOLDS = { amberHours: 6, redHours: 18 };

function buildRow(overrides = {}) {
  const base = {
    id: "thread-1",
    platform: "IMESSAGE",
    platformThreadId: "any;-;handle",
    threadUrl: null,
    personId: "person-1",
    unreadCount: 0,
    needsReply: false,
    lastMessagePreview: "Inbound preview",
    lastMessageAt: new Date("2026-02-19T10:00:00.000Z"),
    lastInboundAt: new Date("2026-02-19T10:00:00.000Z"),
    lastOutboundAt: new Date("2026-02-19T09:00:00.000Z"),
    lastMessageDirection: "IN",
    lastMessageText: "Inbound text",
    riskLevel: "GREEN",
    riskReason: "Replied",
    slaDueAt: null,
    whatTheyWant: null,
    rollingSummary: null,
    updatedAt: new Date("2026-02-19T10:00:00.000Z"),
    person: {
      id: "person-1",
      displayName: "Ada",
      platform: "IMESSAGE"
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

// PM17: the canonical sibling (most-recent INBOUND) carries the AI fields and
// the row id, but the collapsed row's preview + lastMessageAt + direction must
// describe the most-recent MESSAGE in either direction. When the operator's
// last reply went out on the OTHER handle, that outbound is the newest message
// and must drive the display fields even though its sibling is not canonical.
test("collapsed iMessage row surfaces a newer outbound on a non-canonical sibling for display fields", () => {
  // Canonical: newest inbound (so it owns id + whatTheyWant), but its latest
  // message is older than the sibling's outbound below.
  const canonicalInbound = buildRow({
    id: "imsg-email",
    platformThreadId: "any;-;ada@gmail.com",
    whatTheyWant: "FRESH: wants to know who else is going",
    lastInboundAt: new Date("2026-06-05T13:00:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T12:30:00.000Z"),
    lastMessageDirection: "IN",
    lastMessageText: "So who's coming?",
    lastMessagePreview: "So who's coming?",
    lastMessageAt: new Date("2026-06-05T13:00:00.000Z"),
    _count: { messages: 50 }
  });
  // Non-canonical: older inbound (loses the canonical race) but the operator's
  // reply from this handle is the NEWEST message overall.
  const newerOutbound = buildRow({
    id: "imsg-phone",
    platformThreadId: "any;-;+447873519605",
    whatTheyWant: "STALE: should not win",
    lastInboundAt: new Date("2026-06-05T11:00:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T18:45:00.000Z"),
    lastMessageDirection: "OUT",
    lastMessageText: "On my way now",
    lastMessagePreview: "On my way now",
    lastMessageAt: new Date("2026-06-05T18:45:00.000Z"),
    _count: { messages: 9000 }
  });

  const groups = shapeThreadRows([canonicalInbound, newerOutbound]);
  assert.equal(groups.length, 1, "the two handle-chats collapse to one person row");
  // Canonical pick (id + AI fields) is unchanged: still the newest-inbound sibling.
  assert.equal(groups[0].source.id, "imsg-email", "canonical source stays the newest-inbound sibling");

  const shaped = toInboxRow(groups[0], 1, THRESHOLDS);
  assert.equal(shaped.whatTheyWant, "FRESH: wants to know who else is going", "AI field comes from the canonical sibling");
  // Display fields come from the newest-message (outbound) sibling.
  assert.equal(shaped.lastMessageAt, "2026-06-05T18:45:00.000Z", "lastMessageAt is the newest message across siblings");
  assert.equal(shaped.preview, "On my way now", "preview is the newest message's text");
  assert.equal(shaped.lastMessageDirection, "OUT", "direction reflects the newest (outbound) message");
});

// Ordering of the input must not matter: the fold is commutative on max(lastMessageAt).
test("display fold is independent of sibling input order", () => {
  const canonicalInbound = buildRow({
    id: "imsg-email",
    platformThreadId: "any;-;ada@gmail.com",
    lastInboundAt: new Date("2026-06-05T13:00:00.000Z"),
    lastMessageDirection: "IN",
    lastMessageText: "So who's coming?",
    lastMessagePreview: "So who's coming?",
    lastMessageAt: new Date("2026-06-05T13:00:00.000Z")
  });
  const newerOutbound = buildRow({
    id: "imsg-phone",
    platformThreadId: "any;-;+447873519605",
    lastInboundAt: new Date("2026-06-05T11:00:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T18:45:00.000Z"),
    lastMessageDirection: "OUT",
    lastMessageText: "On my way now",
    lastMessagePreview: "On my way now",
    lastMessageAt: new Date("2026-06-05T18:45:00.000Z")
  });

  for (const order of [[canonicalInbound, newerOutbound], [newerOutbound, canonicalInbound]]) {
    const groups = shapeThreadRows(order);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].source.id, "imsg-email", "canonical stays the newest-inbound sibling regardless of order");
    const shaped = toInboxRow(groups[0], 1, THRESHOLDS);
    assert.equal(shaped.lastMessageAt, "2026-06-05T18:45:00.000Z");
    assert.equal(shaped.preview, "On my way now");
    assert.equal(shaped.lastMessageDirection, "OUT");
  }
});

// A single (non-collapsed) row must be byte-for-byte unchanged: display equals
// the source's own fields, so the legacy text->preview->whatTheyWant fallback
// chain still holds.
test("single-sibling row display fields are unchanged (fallback chain intact)", () => {
  const groups = shapeThreadRows([
    buildRow({
      id: "solo",
      lastMessageText: null,
      lastMessagePreview: null,
      whatTheyWant: "AI summary fallback",
      lastMessageAt: new Date("2026-06-05T09:00:00.000Z"),
      lastMessageDirection: "IN"
    })
  ]);
  assert.equal(groups.length, 1);
  const shaped = toInboxRow(groups[0], 1, THRESHOLDS);
  assert.equal(shaped.preview, "AI summary fallback", "falls through to whatTheyWant when text+preview are null");
  assert.equal(shaped.lastMessageAt, "2026-06-05T09:00:00.000Z");
  assert.equal(shaped.lastMessageDirection, "IN");
});

// PM17 must-fix: the newest message can live on an archived/snoozed sibling that
// is ABSENT from the visible `rows` but present in the unfiltered
// `canonicalSiblings` set. The display fold must still surface it, matching the
// merged thread view (and the AI-field adoption from the same set).
test("a newer message on a non-visible sibling (canonicalSiblings only) drives the row display", () => {
  const visibleActive = buildRow({
    id: "imsg-email",
    platformThreadId: "any;-;ada@gmail.com",
    whatTheyWant: "FRESH: from the visible canonical sibling",
    lastInboundAt: new Date("2026-06-05T13:00:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T12:30:00.000Z"),
    lastMessageDirection: "IN",
    lastMessageText: "So who's coming?",
    lastMessagePreview: "So who's coming?",
    lastMessageAt: new Date("2026-06-05T13:00:00.000Z")
  });
  // Archived/snoozed sibling: NOT in the visible rows, but its outbound is the
  // newest message overall. Provided only via canonicalSiblings.
  const nonVisibleNewerOutbound = buildRow({
    id: "imsg-phone",
    platformThreadId: "any;-;+447873519605",
    lastInboundAt: new Date("2026-06-05T11:00:00.000Z"),
    lastOutboundAt: new Date("2026-06-05T18:45:00.000Z"),
    lastMessageDirection: "OUT",
    lastMessageText: "On my way now",
    lastMessagePreview: "On my way now",
    lastMessageAt: new Date("2026-06-05T18:45:00.000Z")
  });

  // visible = active sibling only; canonicalSiblings = ALL siblings.
  const groups = shapeThreadRows([visibleActive], [visibleActive, nonVisibleNewerOutbound]);
  assert.equal(groups.length, 1, "only the visible sibling forms a row; the non-visible one just contributes");
  assert.equal(groups[0].source.id, "imsg-email", "link target / identity stays the visible sibling");

  const shaped = toInboxRow(groups[0], 1, THRESHOLDS);
  assert.equal(shaped.whatTheyWant, "FRESH: from the visible canonical sibling");
  assert.equal(shaped.lastMessageAt, "2026-06-05T18:45:00.000Z", "newest message on the non-visible sibling drives lastMessageAt");
  assert.equal(shaped.preview, "On my way now", "preview reflects the non-visible sibling's newer message");
  assert.equal(shaped.lastMessageDirection, "OUT");
});
