import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

function createHarness() {
  const created = [];
  const fakePrisma = {
    enrichmentJob: {
      async findFirst({ where }) {
        await Promise.resolve();
        return created.find((job) =>
          job.personId === where.personId &&
          where.status.in.includes(job.status)
        ) ?? null;
      },
      async create({ data }) {
        const job = { id: `job-${created.length + 1}`, ...data };
        created.push(job);
        return job;
      }
    }
  };

  const prevPrisma = globalThis.__inboxPrisma;
  globalThis.__inboxPrisma = fakePrisma;

  return {
    created,
    deps: {
      sessionManager: { async getManagedPage() { throw new Error("not reached"); } },
      operationMutex: createKeyedMutex(),
      paceMinMs: 0,
      paceMaxMs: 0,
      batchMax: 6,
      dailyCap: 10,
      longIdleEvery: 0,
      longIdleMinMs: 0,
      longIdleMaxMs: 0,
      refreshDays: 30,
      scanLockKey: (platform) => `scan:${platform}`,
      sendLockKey: (platform) => `send:${platform}`,
      enrichLockKey: "enrich:default:LINKEDIN"
    },
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

test("concurrent non-manual enqueue calls create one pending job for a person", async () => {
  const h = createHarness();
  try {
    const createEnrichmentQueue = await loadQueue();
    const queue = createEnrichmentQueue(h.deps);

    await Promise.all([
      queue.enqueue("person-1", "first_seen"),
      queue.enqueue("person-1", "periodic")
    ]);
    queue.stop();

    assert.equal(h.created.length, 1);
    assert.deepEqual(
      h.created.map((job) => ({ personId: job.personId, status: job.status })),
      [{ personId: "person-1", status: "PENDING" }]
    );

    await Promise.all([
      queue.enqueue("person-1", "manual"),
      queue.enqueue("person-1", "manual")
    ]);
    queue.stop();

    assert.equal(h.created.length, 3);
    assert.deepEqual(h.created.slice(1).map((job) => job.trigger), ["manual", "manual"]);
  } finally {
    h.restore();
  }
});
