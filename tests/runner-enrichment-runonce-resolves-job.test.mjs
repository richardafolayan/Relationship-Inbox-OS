import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

// Regression for PM8: enrichment-queue runOnce (the manual `wait=1` enrich
// path) visited + persisted against Person/PersonEnrichment but never touched
// the EnrichmentJob table. A pre-existing PENDING/RUNNING job for the same
// person — created by first_seen auto-enrich, a prior queued manual, or a
// race — therefore survived the manual visit, and the background drain later
// picked it up and visited the SAME profile a second time. The enrich lock
// only serialised the two visits; it did not prevent the second one.
//
// The fix resolves any outstanding PENDING/RUNNING EnrichmentJob rows for the
// person to DONE *after* the visit, so the drain has nothing left to pick.
// These tests pin two guarantees:
//   1. a completed manual visit (here: the recorded-failure path) closes out
//      outstanding jobs via a single enrichmentJob.updateMany,
//   2. a call that defers WITHOUT visiting leaves the job alone (the drain
//      legitimately still owns it).

// In-memory fake of the slice of Prisma that runOnce touches. Unlike the
// throw-accounting harness, this one ALSO mocks enrichmentJob.updateMany —
// the very table runOnce used to ignore — and records every call so the test
// can assert the resolution query.
function createHarness({ throwOnVisit, dailyCap }) {
  const personUpdates = [];
  const enrichmentJobUpdateMany = [];
  const fakePrisma = {
    person: {
      async findUnique({ where }) {
        return { id: where.id, profileUrl: `https://www.linkedin.com/in/${where.id}` };
      },
      async update({ where, data }) {
        personUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      }
    },
    enrichmentJob: {
      async updateMany({ where, data }) {
        enrichmentJobUpdateMany.push({ where, data });
        return { count: 1 };
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
        // A thrown visit is coerced to { failed: true, reason: "unknown" }
        // by runOnce — a completed (if unsuccessful) visit, which is exactly
        // the moment outstanding jobs must be resolved.
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
    dailyCap: dailyCap ?? 5,
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
    enrichmentJobUpdateMany,
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

test("runOnce resolves outstanding PENDING/RUNNING jobs after a manual visit so the drain can't re-visit", async () => {
  const h = createHarness({ throwOnVisit: true });
  try {
    const createEnrichmentQueue = await loadQueue();
    const queue = createEnrichmentQueue(h.deps);

    const result = await queue.runOnce("person-1");

    // The visit happened (and was recorded as a failure).
    assert.deepEqual(result, { failed: true, reason: "unknown" });
    assert.equal(h.getManagedPageCalls(), 1, "the visit was actually attempted");

    // The bug: this array was empty pre-fix — runOnce never touched the
    // EnrichmentJob table, so a PENDING job survived for the drain to re-run.
    assert.equal(
      h.enrichmentJobUpdateMany.length,
      1,
      "runOnce must resolve outstanding jobs exactly once after a visit"
    );
    const call = h.enrichmentJobUpdateMany[0];
    assert.deepEqual(
      call.where,
      { personId: "person-1", status: { in: ["PENDING", "RUNNING"] } },
      "must target only this person's unfinished jobs"
    );
    assert.equal(call.data.status, "DONE", "outstanding jobs are closed out to DONE");
  } finally {
    h.restore();
  }
});

test("runOnce does NOT resolve jobs when it defers without visiting", async () => {
  // dailyCap 0 → recentVisits.length (0) >= cap (0) → defer before any visit.
  const h = createHarness({ throwOnVisit: false, dailyCap: 0 });
  try {
    const createEnrichmentQueue = await loadQueue();
    const queue = createEnrichmentQueue(h.deps);

    const result = await queue.runOnce("person-1");

    assert.deepEqual(result, { deferred: true });
    assert.equal(h.getManagedPageCalls(), 0, "no visit on a deferral");

    // No visit happened, so the PENDING job legitimately stays for the drain.
    // Resolving it here would silently drop the enrichment entirely.
    assert.equal(
      h.enrichmentJobUpdateMany.length,
      0,
      "a deferral must leave outstanding jobs untouched"
    );
  } finally {
    h.restore();
  }
});
