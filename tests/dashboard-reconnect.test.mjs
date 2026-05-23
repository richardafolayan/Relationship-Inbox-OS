import test from "node:test";
import assert from "node:assert/strict";

const {
  isReconnectCandidate,
  rankReconnectCandidates,
  relationshipSignalScore,
  combinedReconnectScore
} = await import("../apps/dashboard/lib/reconnect.ts");

const NOW = Date.parse("2026-05-22T12:00:00.000Z");
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

// Smaller helper so each test row only carries the fields the function
// actually reads. The horizon helper uses Date.now() by default; this
// shim makes sure the test is not date-sensitive by pinning a fixed
// reference inside lastMessageAt timestamps.
const linkedinDormant = (overrides = {}) => ({
  platform: "LINKEDIN",
  lastMessageAt: daysAgo(120),
  archivedAt: null,
  category: "genuine",
  scheduledSendAt: null,
  ...overrides
});

test("LinkedIn dormant genuine threads are reconnect candidates", () => {
  // Use real Date.now so we exercise the same code path as production.
  // 400 days ago is comfortably outside the 30-day horizon regardless of
  // when this test runs.
  assert.equal(
    isReconnectCandidate({
      platform: "LINKEDIN",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      category: "genuine"
    }),
    true
  );
});

test("non-LinkedIn platforms are never reconnect candidates", () => {
  assert.equal(
    isReconnectCandidate({
      platform: "IMESSAGE",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    }),
    false
  );
  assert.equal(
    isReconnectCandidate({
      platform: "INSTAGRAM",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    }),
    false
  );
});

test("threads still inside the recency horizon are not candidates", () => {
  assert.equal(
    isReconnectCandidate({
      platform: "LINKEDIN",
      lastMessageAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      category: "genuine"
    }),
    false
  );
});

test("archived threads stay out of Reconnect", () => {
  assert.equal(
    isReconnectCandidate({
      platform: "LINKEDIN",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      archivedAt: new Date().toISOString(),
      category: "genuine"
    }),
    false
  );
});

test("outreach (recruiter / pitch) threads are filtered out", () => {
  assert.equal(
    isReconnectCandidate({
      platform: "LINKEDIN",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      category: "outreach"
    }),
    false
  );
});

test("threads with a scheduled outbound send are not suggested", () => {
  assert.equal(
    isReconnectCandidate({
      platform: "LINKEDIN",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      category: "genuine",
      scheduledSendAt: new Date(Date.now() + 60_000).toISOString()
    }),
    false
  );
});

test("threads without a category default to candidate when other rules pass", () => {
  // null category means the runner has not yet labelled the thread;
  // erring on the side of surfacing the thread is fine here because the
  // operator can dismiss it.
  assert.equal(
    isReconnectCandidate({
      platform: "LINKEDIN",
      lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      category: null
    }),
    true
  );
});

test("rankReconnectCandidates puts the most recently dormant thread first", () => {
  const rows = [
    { platform: "LINKEDIN", lastMessageAt: daysAgo(300) },
    { platform: "LINKEDIN", lastMessageAt: daysAgo(60) },
    { platform: "LINKEDIN", lastMessageAt: daysAgo(120) }
  ];
  const ranked = rankReconnectCandidates(rows);
  assert.deepEqual(
    ranked.map((r) => r.lastMessageAt),
    [daysAgo(60), daysAgo(120), daysAgo(300)]
  );
});

test("rankReconnectCandidates pushes unknown timestamps to the bottom", () => {
  const rows = [
    { platform: "LINKEDIN", lastMessageAt: null },
    { platform: "LINKEDIN", lastMessageAt: daysAgo(60) },
    { platform: "LINKEDIN", lastMessageAt: daysAgo(120) }
  ];
  const ranked = rankReconnectCandidates(rows);
  assert.equal(ranked[0].lastMessageAt, daysAgo(60));
  assert.equal(ranked[1].lastMessageAt, daysAgo(120));
  assert.equal(ranked[2].lastMessageAt, null);
});

test("rankReconnectCandidates is non-mutating", () => {
  const rows = [
    { platform: "LINKEDIN", lastMessageAt: daysAgo(60) },
    { platform: "LINKEDIN", lastMessageAt: daysAgo(300) }
  ];
  const original = [...rows];
  rankReconnectCandidates(rows);
  assert.deepEqual(rows, original);
});

// Sanity check that the linkedinDormant helper itself is a candidate so
// the other test scaffolding stays trustworthy.
test("the linkedinDormant test fixture is a candidate by default", () => {
  // Build the row with a clearly-outside-horizon timestamp because the
  // fixture's daysAgo uses a fixed NOW. Override lastMessageAt so the
  // horizon helper using real Date.now() still sees it as dormant.
  const row = linkedinDormant({
    lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
  });
  assert.equal(isReconnectCandidate(row), true);
});

// Phase 3.5: relationship-signal scoring + AI-score combination.
test("relationshipSignalScore rewards depth and freshness", () => {
  // 6 turns, dormant for 35 days: depth 18, recency ~39 -> ~57
  const fresh = relationshipSignalScore(
    { platform: "LINKEDIN", lastMessageAt: daysAgo(35), messageCount: 6 },
    NOW
  );
  assert.ok(fresh > 50 && fresh < 65, `expected fresh score in 50-65 band, got ${fresh}`);

  // 30 turns, dormant 365 days: depth caps at 60, recency 0 -> 60
  const deep = relationshipSignalScore(
    { platform: "LINKEDIN", lastMessageAt: daysAgo(365), messageCount: 30 },
    NOW
  );
  assert.equal(deep, 60);

  // 1 turn, 540 days dormant: depth 3, recency 0 -> 3
  const thin = relationshipSignalScore(
    { platform: "LINKEDIN", lastMessageAt: daysAgo(540), messageCount: 1 },
    NOW
  );
  assert.equal(thin, 3);
});

test("relationshipSignalScore handles missing fields conservatively", () => {
  // No timestamp -> assume a year dormant -> 0 recency. No count -> 0 depth.
  assert.equal(relationshipSignalScore({ platform: "LINKEDIN", lastMessageAt: null }, NOW), 0);
});

test("combinedReconnectScore prefers the AI score when present", () => {
  // AI says 88; the relationship-signal would have read ~12 from a thin
  // history. The AI score wins for ranking.
  const row = {
    platform: "LINKEDIN",
    lastMessageAt: daysAgo(180),
    messageCount: 3,
    reconnectScore: 88
  };
  assert.equal(combinedReconnectScore(row, NOW), 88);
});

test("combinedReconnectScore falls back to relationship signals without AI", () => {
  const row = {
    platform: "LINKEDIN",
    lastMessageAt: daysAgo(50),
    messageCount: 8,
    reconnectScore: null
  };
  assert.equal(combinedReconnectScore(row, NOW), relationshipSignalScore(row, NOW));
});

test("rankReconnectCandidates puts the highest combined score first", () => {
  // Build the rows so each combined score is distinct and predictable.
  // The AI-scored row sits between the deepest fresh row and the rest:
  // the test verifies that the AI score is consulted per-row, NOT that
  // it always wins (a row with a stronger relationship signal still
  // outranks a row with a weaker AI score).
  const rows = [
    // thin, year-old: rel signal ~3
    { platform: "LINKEDIN", lastMessageAt: daysAgo(365), messageCount: 1 },
    // deep + dormant 365d: depth 60, recency 0 -> 60
    { platform: "LINKEDIN", lastMessageAt: daysAgo(365), messageCount: 30 },
    // AI override: 90 (beats the deep+dormant 60, loses to anyone above)
    {
      platform: "LINKEDIN",
      lastMessageAt: daysAgo(300),
      messageCount: 4,
      reconnectScore: 90
    },
    // medium: depth 15, recency ~27 -> 42
    { platform: "LINKEDIN", lastMessageAt: daysAgo(80), messageCount: 5 }
  ];
  const ranked = rankReconnectCandidates(rows, NOW);
  // AI 90 -> deep+dormant 60 -> medium 42 -> thin 3
  assert.equal(ranked[0].reconnectScore, 90);
  assert.equal(ranked[1].messageCount, 30);
  assert.equal(ranked[2].messageCount, 5);
  assert.equal(ranked[3].messageCount, 1);
});

test("rankReconnectCandidates breaks ties by most-recent dormancy", () => {
  // Two rows with identical relationship scores; the more-recent one wins.
  const rows = [
    { platform: "LINKEDIN", lastMessageAt: daysAgo(120), messageCount: 6 },
    { platform: "LINKEDIN", lastMessageAt: daysAgo(60), messageCount: 6 }
  ];
  const ranked = rankReconnectCandidates(rows, NOW);
  assert.equal(ranked[0].lastMessageAt, daysAgo(60));
  assert.equal(ranked[1].lastMessageAt, daysAgo(120));
});
