import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

// Regression for M14: enrichment-queue runOnce did not catch a thrown
// visitProfile.
//
// runOnce acquired the enrich lock with `visitProfile(personId)` as the
// work function and then read `acquired.value` directly. visitProfile does
// NOT wrap sessionManager.getManagedPage (only the ensureConnected call is
// guarded), so a managed-page failure threw straight out of tryAcquire and
// escaped runOnce. That skipped the rate-limit accounting
// (lastVisitAt / recentVisits / visitsSinceLongIdle) and the persistFailure
// call below it: the request aborted without counting the visit toward the
// daily cap or recording the failure on the person row.
//
// The fix mirrors processJob: wrap the tryAcquire in try/catch, coerce a
// throw into `{ failed: true, reason: "unknown" }`, then always run the
// accounting + persistFailure. These tests pin all three guarantees.

// In-memory fake of the slice of Prisma that runOnce -> visitProfile /
// persistFailure touches. runOnce never reads enrichmentJob (that is
// processJob's table), so person is all we need. getManagedPage throwing
// stands in for the real "visit threw" path the bug is about.
function createHarness({ throwOnVisit }) {
  const personUpdates = [];
  const fakePrisma = {
    person: {
      async findUnique({ where }) {
        return { id: where.id, profileUrl: `https://www.linkedin.com/in/${where.id}` };
      },
      async update({ where, data }) {
        personUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      }
    }
  };
  // db.js does `globalThis.__inboxPrisma ?? new PrismaClient()`, so seeding
  // the global before the (dynamic) import keeps a real client from ever
  // being constructed.
  const prevPrisma = globalThis.__inboxPrisma;
  globalThis.__inboxPrisma = fakePrisma;

  let getManagedPageCalls = 0;
  const sessionManager = {
    async getManagedPage() {
      getManagedPageCalls += 1;
      if (throwOnVisit) {
        throw new Error("managed page boom");
      }
      return {};
    }
  };

  const mutex = createKeyedMutex();
  const deps = {
    sessionManager,
    operationMutex: mutex,
    paceMinMs: 0,
    paceMaxMs: 0,
    batchMax: 6,
    dailyCap: 1,
    longIdleEvery: 0,
    longIdleMinMs: 0,
    longIdleMaxMs: 0,
    refreshDays: 30,
    scanLockKey: (platform) => `scan:${platform}`,
    sendLockKey: (platform) => `send:${platform}`,
    enrichLockKey: "enrich:default:LINKEDIN"
  };

  return {
    deps,
    personUpdates,
    getManagedPageCalls: () => getManagedPageCalls,
    restore() {
      if (prevPrisma === undefined) delete globalThis.__inboxPrisma;
      else globalThis.__inboxPrisma = prevPrisma;
    }
  };
}

async function loadQueue() {
  const mod = await import("../apps/runner/dist/services/enrichment-queue.js");
  return mod.createEnrichmentQueue;
}

test("runOnce records a thrown visit as a failure instead of aborting the request", async () => {
  const h = createHarness({ throwOnVisit: true });
  try {
    const createEnrichmentQueue = await loadQueue();
    const queue = createEnrichmentQueue(h.deps);

    // Before the fix this rejected (the throw escaped runOnce). It must now
    // resolve to a recorded failure.
    const result = await queue.runOnce("person-1");

    assert.deepEqual(result, { failed: true, reason: "unknown" });
    assert.equal(h.getManagedPageCalls(), 1, "the visit was actually attempted");

    // The failure was persisted to the person row (persistFailure ran).
    assert.equal(h.personUpdates.length, 1, "persistFailure must run on a thrown visit");
    assert.equal(h.personUpdates[0].id, "person-1");
    assert.equal(h.personUpdates[0].data.enrichmentFailedReason, "unknown");
  } finally {
    h.restore();
  }
});

test("a thrown visit still counts toward the daily cap", async () => {
  const h = createHarness({ throwOnVisit: true });
  try {
    const createEnrichmentQueue = await loadQueue();
    const queue = createEnrichmentQueue(h.deps);

    // dailyCap is 1. The first runOnce throws inside the visit; the fix
    // records the visit in the rate-limit ring anyway.
    const first = await queue.runOnce("person-1");
    assert.deepEqual(first, { failed: true, reason: "unknown" });

    // Because the thrown visit was counted, the ring is now at the cap, so
    // the next call defers instead of hammering the (failing) session again.
    // Pre-fix the ring stayed empty and this would have thrown a second time.
    const second = await queue.runOnce("person-2");
    assert.deepEqual(second, { deferred: true });
    assert.equal(h.getManagedPageCalls(), 1, "second call must defer before attempting a visit");
  } finally {
    h.restore();
  }
});
