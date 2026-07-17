import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shapeThreadRows, toInboxRow } from "../apps/runner/dist/services/thread-row-shaping.js";

// #890: /data/thread must return the MERGED reply state for iMessage sibling
// cohorts — the same source of truth as aiNeedsReply, the fallback brief,
// suggested replies, live risk, and the folded inbox row. Returning the
// representative row's stored needsReply left the list saying "needs reply"
// while the opened thread entered reopen mode when the unanswered inbound
// lived on the other handle.

const indexSrc = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/index.ts", import.meta.url)),
  "utf8"
);

const THRESHOLDS = { amberHours: 6, redHours: 18 };
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

// Mirror the /data/thread derivation of aiNeedsReply from the newest IN/OUT
// across the merged sibling message set.
function mergedNeedsReply(lastInbound, lastOutbound) {
  return Boolean(lastInbound && (!lastOutbound || lastInbound.timestamp > lastOutbound.timestamp));
}

function buildRow(overrides = {}) {
  const base = {
    id: "thread-1",
    platform: "IMESSAGE",
    platformThreadId: "any;-;handle",
    threadUrl: null,
    personId: "kwame",
    unreadCount: 0,
    needsReply: false,
    lastMessagePreview: "Preview",
    lastMessageAt: hoursAgo(8),
    lastInboundAt: hoursAgo(30),
    lastOutboundAt: hoursAgo(20),
    riskLevel: "GREEN",
    riskReason: "Replied",
    slaDueAt: null,
    whatTheyWant: null,
    rollingSummary: null,
    updatedAt: hoursAgo(8),
    person: {
      id: "kwame",
      displayName: "Kwame",
      platform: "IMESSAGE"
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

test("/data/thread returns needsReply from aiNeedsReply, not the requested row's stored flag", () => {
  // The JSON body must surface the merged derivation already used for the
  // brief, suggested replies, and risk inputs — not thread.needsReply.
  assert.match(indexSrc, /needsReply:\s*aiNeedsReply/);
  // Guard the regression: the response block must not re-introduce the
  // per-row column as the thread-level flag.
  assert.equal(
    /needsReply:\s*thread\.needsReply/.test(indexSrc),
    false,
    "thread response must not return the requested row's stored needsReply"
  );
});

test("/data/thread derives aiNeedsReply from the merged last inbound/outbound across siblings", () => {
  // lastInbound / lastOutbound are queried with threadId: { in: siblingIds }.
  assert.match(
    indexSrc,
    /const aiNeedsReply = Boolean\(\s*lastInbound && \(!lastOutbound \|\| lastInbound\.timestamp > lastOutbound\.timestamp\)\s*\)/
  );
  assert.match(indexSrc, /const messageThreadFilter = \{ threadId: \{ in: siblingIds \} \}/);
});

test("representative sibling without the latest inbound still needsReply when a sibling has unanswered inbound", () => {
  // Inbox links to the visible phone row (settled on its own pair, stored
  // needsReply false). The person's email-handle sibling — absent from the
  // visible set (archived) but present in the full sibling cohort — holds a
  // fresh unanswered inbound. Folded inbox needsReply is true; opening the
  // phone representative must return the same merged state via aiNeedsReply
  // (message query over siblingIds), not phone.needsReply.
  const phone = buildRow({
    id: "imsg-phone",
    platformThreadId: "any;-;+447873519605",
    needsReply: false,
    lastInboundAt: hoursAgo(30),
    lastOutboundAt: hoursAgo(20),
    lastMessageAt: hoursAgo(20),
    _count: { messages: 500 }
  });
  const email = buildRow({
    id: "imsg-email",
    platformThreadId: "any;-;kwame@example.com",
    needsReply: true,
    lastInboundAt: hoursAgo(4),
    lastOutboundAt: hoursAgo(48),
    lastMessageAt: hoursAgo(4),
    archivedAt: hoursAgo(100),
    _count: { messages: 40 }
  });

  // Visible set is phone only; full cohort includes the archived email sibling.
  const folded = shapeThreadRows([phone], [phone, email]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].source.id, "imsg-phone", "link target stays the visible phone row");
  assert.equal(folded[0].needsReply, true, "folded inbox owes a reply from the email inbound");

  // Message-level merge the thread endpoint uses when last IN lives on email
  // and last OUT lives on phone (older than that inbound).
  const lastInbound = { timestamp: email.lastInboundAt };
  const lastOutbound = { timestamp: phone.lastOutboundAt };
  assert.equal(
    mergedNeedsReply(lastInbound, lastOutbound),
    true,
    "merged message timestamps agree with the folded inbox"
  );
  // Opening the representative alone (its stored flag / own pair) would
  // incorrectly report settled — the bug #890 fixed.
  assert.equal(phone.needsReply, false);
  assert.equal(
    mergedNeedsReply(
      { timestamp: phone.lastInboundAt },
      { timestamp: phone.lastOutboundAt }
    ),
    false,
    "phone-only pair is settled; must not drive the open thread"
  );

  const shaped = toInboxRow(folded[0], 1, THRESHOLDS);
  assert.equal(shaped.needsReply, true);
  assert.equal(shaped.id, "imsg-phone");
});

test("non-iMessage rows are not folded with each other (single-thread needsReply)", () => {
  const a = buildRow({
    id: "li-a",
    platform: "LINKEDIN",
    personId: "ada",
    person: { id: "ada", displayName: "Ada", platform: "LINKEDIN" },
    needsReply: false,
    lastInboundAt: hoursAgo(30),
    lastOutboundAt: hoursAgo(20)
  });
  const b = buildRow({
    id: "li-b",
    platform: "LINKEDIN",
    personId: "ada",
    person: { id: "ada", displayName: "Ada", platform: "LINKEDIN" },
    needsReply: true,
    lastInboundAt: hoursAgo(2),
    lastOutboundAt: hoursAgo(40)
  });
  const rows = shapeThreadRows([a, b]);
  assert.equal(rows.length, 2, "LinkedIn keeps one row per thread");
  assert.equal(rows.find((r) => r.source.id === "li-a").needsReply, false);
  assert.equal(rows.find((r) => r.source.id === "li-b").needsReply, true);
});
