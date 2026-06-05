import test from "node:test";
import assert from "node:assert/strict";
import { markAllThreadsForReassess } from "../apps/runner/dist/services/reassess-all.js";

// Pure-helper tests for the bulk "mark all threads for reassess" admin
// action. The runner endpoint is a one-line wrapper around this helper,
// so pinning the SQL filter + the cleared fields here is sufficient to
// catch regressions without booting Express or hitting a live DB.

function makePrismaMock() {
  const calls = [];
  return {
    thread: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: 7 };
      }
    },
    __calls: calls
  };
}

test("markAllThreadsForReassess clears the three AI cache fields on non-archived threads", async () => {
  const prisma = makePrismaMock();
  const result = await markAllThreadsForReassess(prisma);

  // Returns the count Prisma reported.
  assert.equal(result.threadsMarked, 7);

  // Exactly one updateMany call.
  assert.equal(prisma.__calls.length, 1);
  const args = prisma.__calls[0];

  // Filter must scope to non-archived threads only. Archived threads are
  // out of inbox view and shouldn't burn AI calls on next regen.
  assert.deepEqual(args.where, { archivedAt: null });

  // All three caches cleared — brief, predraft JSON, predraft cache key.
  // Brief clear forces fallback synthesis until next reassess; predraft
  // JSON + cache key force the pre-warm path to regenerate.
  assert.deepEqual(args.data, {
    replyBriefJson: null,
    suggestedRepliesJson: null,
    suggestedRepliesCacheKey: null
  });
});

test("markAllThreadsForReassess returns zero when no threads matched", async () => {
  const prisma = {
    thread: {
      updateMany: async () => ({ count: 0 })
    }
  };
  const result = await markAllThreadsForReassess(prisma);
  assert.equal(result.threadsMarked, 0);
});

test("markAllThreadsForReassess does not touch archived threads", async () => {
  // The where clause must NOT include archived threads. We assert by
  // reading the filter rather than running real data — the unit-test
  // pattern in the rest of the suite.
  const prisma = makePrismaMock();
  await markAllThreadsForReassess(prisma);
  const args = prisma.__calls[0];
  assert.equal(args.where.archivedAt, null, "filter must require archivedAt IS NULL");
  // No other where clauses should sneak in — the action is intentionally
  // broad (every active thread) so spurious filters would silently
  // exclude some threads from the regen.
  assert.deepEqual(Object.keys(args.where).sort(), ["archivedAt"]);
});

test("markAllThreadsForReassess does not clear non-cache fields", async () => {
  // The cleared set is exactly the three AI cache fields. The action
  // must NOT touch rollingSummary, whatTheyWant, openLoopsJson,
  // dismissedOpenLoopsJson, rememberJson, etc — those carry durable
  // state and dropping them silently would lose operator context.
  const prisma = makePrismaMock();
  await markAllThreadsForReassess(prisma);
  const args = prisma.__calls[0];
  assert.deepEqual(
    Object.keys(args.data).sort(),
    ["replyBriefJson", "suggestedRepliesCacheKey", "suggestedRepliesJson"]
  );
});
