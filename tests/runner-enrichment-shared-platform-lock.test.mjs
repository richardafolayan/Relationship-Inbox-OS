import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

// Regression for PM6: runWithPlatformLease provides no mutual exclusion
// (it is a refcount), and enrichment's visitProfile drove the shared
// managed page while holding only the enrich-specific lock key
// (default:LINKEDIN:ENRICH). Scans/sends serialise on a DIFFERENT key
// (default:LINKEDIN), so a scan starting after enrichment's TOCTOU
// `isRunning(scanLock)` pre-check could drive the SAME Chrome page
// concurrently with an in-flight profile visit, destroying scan DOM
// handles mid-loop.
//
// The fix makes the enrichment visit run INSIDE
// operationMutex.runExclusive(scanLock) — the same default:LINKEDIN key
// scan/send hold — so the visit and a scan are now mutually exclusive.
//
// This test pins the core invariant: WHILE an enrichment visit is in
// flight, the shared platform lock (scanLockKey) is HELD. Before the fix
// the visit only held the enrich key, so a concurrent scan could acquire
// scanLock and collide on the page; after the fix scanLock is held for the
// whole visit, so the scan must wait.

// Shared platform key that scan/send serialise on in production
// (`${personKey}:${platform}` — see index.ts platformLockKey).
const SHARED_PLATFORM_KEY = "default:LINKEDIN";
// Distinct enrich-only key (`${personKey}:LINKEDIN:ENRICH`). Pre-fix the
// visit ran under THIS key, which is why it never excluded a scan.
const ENRICH_KEY = "default:LINKEDIN:ENRICH";

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHarness({ visitGate }) {
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

  const enteredVisit = createDeferred();
  let getManagedPageCalls = 0;
  const sessionManager = {
    async getManagedPage() {
      getManagedPageCalls += 1;
      // Signal the test that the visit body is now executing, then block
      // until released. While blocked here the visit is "in flight", so
      // the assertion can observe whether the shared platform lock is held.
      enteredVisit.resolve();
      await visitGate.promise;
      // Throw after release so the real extractProfile is never reached —
      // runOnce coerces a thrown visit into { failed:true, reason:"unknown" }
      // and still releases scanLock.
      throw new Error("visit released");
    }
  };

  const mutex = createKeyedMutex();
  const deps = {
    sessionManager,
    operationMutex: mutex,
    paceMinMs: 0,
    paceMaxMs: 0,
    batchMax: 6,
    dailyCap: 100,
    longIdleEvery: 0,
    longIdleMinMs: 0,
    longIdleMaxMs: 0,
    refreshDays: 30,
    // scanLockKey returns the SHARED platform key — the whole point of the
    // fix is that the visit acquires THIS, not a private enrich key.
    scanLockKey: () => SHARED_PLATFORM_KEY,
    sendLockKey: () => `${SHARED_PLATFORM_KEY}:SEND`,
    enrichLockKey: ENRICH_KEY
  };

  return {
    deps,
    mutex,
    enteredVisit: enteredVisit.promise,
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

test("an in-flight enrichment visit holds the shared platform lock (mutually excludes scans)", async () => {
  const visitGate = createDeferred();
  const h = createHarness({ visitGate });
  try {
    const createEnrichmentQueue = await loadQueue();
    const queue = createEnrichmentQueue(h.deps);

    // Pre-check passes: scanLock is free when runOnce starts.
    assert.equal(
      h.mutex.isRunning(SHARED_PLATFORM_KEY),
      false,
      "shared platform lock must be free before the visit starts"
    );

    const runOncePromise = queue.runOnce("person-1");

    // Wait until the visit body is actually executing.
    await h.enteredVisit;

    // CORE INVARIANT: while the visit is in flight, the shared platform
    // lock is held, so a scan attempting it must defer. Pre-fix the visit
    // held only ENRICH_KEY and this tryAcquire would SUCCEED — proving the
    // page was unprotected and a concurrent scan could collide.
    const scanAttempt = await h.mutex.tryAcquire(SHARED_PLATFORM_KEY, async () => "scan-ran");
    assert.deepEqual(
      scanAttempt,
      { acquired: false },
      "a concurrent scan must NOT acquire the shared platform lock while an enrichment visit is in flight"
    );

    // Sanity: the visit really did start (getManagedPage was entered once).
    assert.equal(h.getManagedPageCalls(), 1, "the enrichment visit was in flight");

    // Release the visit and let runOnce settle.
    visitGate.resolve();
    const result = await runOncePromise;
    assert.deepEqual(result, { failed: true, reason: "unknown" });

    // After the visit completes the shared lock is released again, so a
    // scan can now proceed.
    const afterAttempt = await h.mutex.tryAcquire(SHARED_PLATFORM_KEY, async () => "scan-ran");
    assert.deepEqual(
      afterAttempt,
      { acquired: true, value: "scan-ran" },
      "the shared platform lock must be released once the enrichment visit finishes"
    );
  } finally {
    h.restore();
  }
});
