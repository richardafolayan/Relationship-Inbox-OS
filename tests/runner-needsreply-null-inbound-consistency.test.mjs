import test from "node:test";
import assert from "node:assert/strict";
import { shapeThreadRows, toInboxRow } from "../apps/runner/dist/services/thread-row-shaping.js";

const THRESHOLDS = { amberHours: 6, redHours: 18 };

function buildRow(overrides = {}) {
  const base = {
    id: "thread-1",
    platform: "LINKEDIN",
    platformThreadId: "linkedin-temp:1",
    threadUrl: null,
    personId: "person-1",
    unreadCount: 0,
    needsReply: false,
    lastMessagePreview: "Preview",
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

// P2-PL5 regression: a thread with no inbound message (lastInboundAt === null)
// but a stored needsReply=true column (e.g. an AI summary set needs_reply, or a
// seeded thread) used to surface a self-contradictory row: needsReply=true while
// calculateRisk -- which has no inbound to age -- reports GREEN and no SLA. That
// row survived the needsReplyOnly inbox filter yet could never age to amber/red.
// deriveNeedsReply must agree with calculateRisk: no inbound = nothing owed.
test("row with null lastInboundAt is not flagged needsReply even when the stored column says true", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "no-inbound-but-flagged",
      lastInboundAt: null,
      lastOutboundAt: null,
      needsReply: true,
      riskLevel: "GREEN"
    })
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].needsReply, false, "no inbound means nothing is owed");

  const shaped = toInboxRow(rows[0], 1, THRESHOLDS);
  // The three fields must agree: not-needs-reply, GREEN, and an empty (not
  // "No SLA") countdown -- the self-contradictory state can no longer occur.
  assert.equal(shaped.needsReply, false);
  assert.equal(shaped.riskLevel, "GREEN");
  assert.equal(shaped.slaCountdown, "");
});

// Guard the inverse so the fix does not over-correct: a genuine unanswered
// inbound (lastInboundAt set, no later outbound) must STILL be needsReply=true.
test("row with an unanswered inbound is still flagged needsReply", () => {
  const rows = shapeThreadRows([
    buildRow({
      id: "unanswered-inbound",
      lastInboundAt: new Date("2026-02-19T10:00:00.000Z"),
      lastOutboundAt: null,
      needsReply: false
    })
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].needsReply, true);
});
