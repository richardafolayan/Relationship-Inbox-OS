import test from "node:test";
import assert from "node:assert/strict";

const { isReconnectCandidate, rankReconnectCandidates } = await import(
  "../apps/dashboard/lib/reconnect.ts"
);

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
