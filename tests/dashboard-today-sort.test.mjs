import test from "node:test";
import assert from "node:assert/strict";

// today.ts is framework-free, so the tsx loader resolves this .ts import
// directly (matches the dashboard-today-queue.test.mjs pattern).
const { sortTodayQueue } = await import("../apps/dashboard/lib/today.ts");

const recent = () => new Date().toISOString();
const older = () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

const row = (over = {}) => ({
  id: "t",
  needsReply: true,
  scheduledSendAt: null,
  lastMessageAt: recent(),
  lastMessageDirection: "IN",
  riskLevel: "GREEN",
  personFavourite: false,
  lastInboundAt: recent(),
  ...over
});

// P3-PL9: sortTodayQueue's within-bucket tie-break is "oldest real inbound
// first". A row whose lastInboundAt is null (reachable: deriveNeedsReply falls
// back to the persisted needsReply column, calculateRisk gives it GREEN) used
// to fall back to epoch 0, sorting it to the FRONT of its bucket and becoming
// the Today hero. It must instead sort to the BACK, matching overdue-digest.ts.

test("a null-inbound GREEN row sorts BEHIND a real recent-inbound GREEN row", () => {
  const fresh = row({ id: "fresh", lastInboundAt: recent() });
  const unknown = row({ id: "unknown", lastInboundAt: null });
  // Feed it unknown-first so the only thing that can move it is the fix.
  const sorted = sortTodayQueue([unknown, fresh]);
  assert.equal(sorted[0].id, "fresh", "the real-inbound row must lead the bucket");
  assert.equal(sorted[1].id, "unknown", "the unknown-waiting row must trail");
});

test("the genuinely-oldest real inbound still leads its bucket", () => {
  const old = row({ id: "old", lastInboundAt: older() });
  const newer = row({ id: "newer", lastInboundAt: recent() });
  const sorted = sortTodayQueue([newer, old]);
  assert.equal(sorted[0].id, "old", "oldest-waiting real inbound leads");
  assert.equal(sorted[1].id, "newer");
});

test("a non-null but unparseable lastInboundAt also sorts to the BACK", () => {
  // Date.parse(garbage) -> NaN; without the guard, aIn - bIn returns NaN, an
  // inconsistent comparator with undefined order. The fix coerces it to the
  // back, leaving a deterministic result.
  const fresh = row({ id: "fresh", lastInboundAt: recent() });
  const garbage = row({ id: "garbage", lastInboundAt: "not-a-date" });
  const sorted = sortTodayQueue([garbage, fresh]);
  assert.equal(sorted[0].id, "fresh");
  assert.equal(sorted[1].id, "garbage");
});

test("null-inbound rows never jump ahead across a populated all-GREEN queue", () => {
  const rows = [
    row({ id: "unknown", lastInboundAt: null }),
    row({ id: "a", lastInboundAt: older() }),
    row({ id: "b", lastInboundAt: recent() })
  ];
  const sorted = sortTodayQueue(rows);
  assert.equal(sorted[0].id, "a", "oldest real inbound is the hero, not the null row");
  assert.equal(sorted[sorted.length - 1].id, "unknown");
});
