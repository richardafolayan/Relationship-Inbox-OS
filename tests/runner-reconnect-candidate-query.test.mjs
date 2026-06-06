import test from "node:test";
import assert from "node:assert/strict";
import { buildReconnectCandidateWhere } from "../apps/runner/dist/services/reconnect-candidate-query.js";

// P4-P4L2: the runner's reconnect refresh-scores query and the dashboard's
// isReconnectCandidate predicate (apps/dashboard/lib/reconnect.ts) disagreed on
// the candidate set. The dashboard drops a dormant thread the moment a reply is
// queued (scheduledSendAt set); the runner used to filter only on
// archivedAt / dormancy / not-outreach, so it scored - and persisted a
// reconnectScore onto - a thread the dashboard never shows. These tests pin the
// extracted query builder so the producer mirrors the consumer's exclusions.

const CUTOFF = new Date("2026-05-01T00:00:00.000Z");

// Pull the array of NOT conditions whether Prisma got a single object or an
// array; this helper normalises so assertions stay simple.
const notList = (where) => (Array.isArray(where.NOT) ? where.NOT : [where.NOT]);

test("mirrors the dashboard's base predicate (LinkedIn, not archived, dormant)", () => {
  const where = buildReconnectCandidateWhere(CUTOFF, []);
  assert.equal(where.platform, "LINKEDIN");
  assert.equal(where.archivedAt, null);
  assert.deepEqual(where.lastMessageAt, { lt: CUTOFF });
});

test("still excludes outreach-tagged threads", () => {
  const where = buildReconnectCandidateWhere(CUTOFF, []);
  const outreach = notList(where).find(
    (c) => c && c.category === "outreach"
  );
  assert.ok(outreach, "expected a NOT category:outreach condition");
});

test("excludes threads with a SCHEDULED send (mirrors scheduledSendAt)", () => {
  const where = buildReconnectCandidateWhere(CUTOFF, ["t-scheduled-1", "t-scheduled-2"]);
  const idExclusion = notList(where).find(
    (c) => c && c.id && Array.isArray(c.id.in)
  );
  assert.ok(idExclusion, "expected a NOT id:{ in: [...] } condition");
  assert.deepEqual(idExclusion.id.in, ["t-scheduled-1", "t-scheduled-2"]);
});

test("empty scheduled set excludes nothing (where stays a strict narrowing)", () => {
  const where = buildReconnectCandidateWhere(CUTOFF, []);
  const idExclusion = notList(where).find(
    (c) => c && c.id && Array.isArray(c.id.in)
  );
  // Present but empty: NOT { id: { in: [] } } matches no row, so it removes
  // nothing - the query result is identical to the pre-fix behaviour when no
  // sends are scheduled.
  assert.ok(idExclusion, "expected the id-in exclusion to always be present");
  assert.deepEqual(idExclusion.id.in, []);
});
