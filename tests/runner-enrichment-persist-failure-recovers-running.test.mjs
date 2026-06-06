import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

// Regression for PM10: a DB error in the post-visit persist / terminal
// job-status update left the enrichment job stuck RUNNING forever, which
// kept the dashboard's "Enriching N" banner glued on.
//
// processJob marks the row RUNNING before the pacing sleep (for crash
// recovery), runs the visit, then persists the outcome and writes the
// terminal status (DONE / FAILED / retry-PENDING). That post-visit block had
// NO try/catch: if persistSuccess / persistFailure or the terminal
// enrichmentJob.update threw after the visit returned, the exception escaped
// processJob -> drainPass -> kick's swallowing .catch. The row's last durable
// write was RUNNING, and pickNextJob only ever selects PENDING rows, so the
// job stayed RUNNING until the next boot's recoverInflightOnStart. The health
// endpoint counts RUNNING into enrichmentQueue.total, so "Enriching N · M in
// flight" hung indefinitely.
//
// The fix wraps the post-visit persist + terminal update in try/catch and, on
// failure, resets the row to PENDING with a short nextAttemptAt + lastError so
// a transient DB error reschedules the job instead of orphaning it. This test
// forces the terminal update to throw and pins that the row ends PENDING (not
// RUNNING) with a near-term retry.

// In-memory fake of the slice of Prisma that processJob -> visitProfile /
// persistFailure / the job-status updates touch.
//
// The person has NO profileUrl, so visitProfile returns
// { failed: true, reason: "not_found" } deterministically WITHOUT touching the
// browser session or the real extractProfile — a network-free way to reach the
// failure branch's terminal enrichmentJob.update.
//
// enrichmentJob.update throws exactly once, on the call that carries `attempts`
// in its data — that is uniquely the failure-branch terminal update. The
// RUNNING write (data: { status: "RUNNING" }) and the recovery write
// (data: { status: "PENDING", nextAttemptAt, lastError }) carry no `attempts`,
// so neither is affected: the throw lands precisely on the post-visit write the
// bug is about, and the recovery write is free to succeed.
function createHarness() {
  const job = {
    id: "job-1",
    personId: "person-1",
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    trigger: "manual",
    createdAt: new Date()
  };
  const jobUpdates = [];
  let threwTerminalOnce = false;

  const fakePrisma = {
    person: {
      async findUnique({ where }) {
        // profileUrl null -> visitProfile short-circuits to a not_found
        // failure before ever calling getManagedPage / extractProfile.
        return { id: where.id, profileUrl: null };
      },
      async update({ where, data }) {
        return { id: where.id, ...data };
      }
    },
    enrichmentJob: {
      async findFirst({ where }) {
        // Serves both enqueue's coalesce check and pickNextJob. We enqueue
        // with trigger "manual" (skips coalesce), so this is pickNextJob:
        // status PENDING and nextAttemptAt null or due.
        const wantsPending =
          where?.status === "PENDING" ||
          (Array.isArray(where?.status?.in) && where.status.in.includes("PENDING"));
        if (!wantsPending) return null;
        if (job.status !== "PENDING") return null;
        if (job.nextAttemptAt && job.nextAttemptAt.getTime() > Date.now()) return null;
        return { ...job };
      },
      async create({ data }) {
        Object.assign(job, data);
        return { ...job };
      },
      async update({ where, data }) {
        jobUpdates.push({ id: where.id, data });
        // Throw once on the failure-branch terminal update (the only update
        // that sets `attempts`). This is the exact write the bug fails to
        // guard.
        if (data.attempts !== undefined && !threwTerminalOnce) {
          threwTerminalOnce = true;
          throw new Error("db write boom (terminal job update)");
        }
        Object.assign(job, where.id === job.id ? data : {});
        return { ...job };
      }
    }
  };

  // db.js does `globalThis.__inboxPrisma ?? new PrismaClient()`, so seeding the
  // global before the (dynamic) import keeps a real client from ever being
  // constructed.
  const prevPrisma = globalThis.__inboxPrisma;
  globalThis.__inboxPrisma = fakePrisma;

  const sessionManager = {
    async getManagedPage() {
      // Never reached for a profileUrl-less person, but provided so deps are
      // well-formed. If it IS called the test should fail loudly.
      throw new Error("getManagedPage should not be called when profileUrl is null");
    }
  };

  const mutex = createKeyedMutex();
  const deps = {
    sessionManager,
    operationMutex: mutex,
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
  };

  return {
    deps,
    job,
    jobUpdates,
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

function tick() {
  // Let kick()'s setTimeout(0) drainPass run to completion.
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test("a DB error in the post-visit persist resets the job to PENDING instead of orphaning RUNNING", async () => {
  const h = createHarness();
  try {
    const createEnrichmentQueue = await loadQueue();
    const queue = createEnrichmentQueue(h.deps);

    // enqueue creates the PENDING row and kicks the drain. The drain marks the
    // row RUNNING, visits (not_found), then the terminal update throws.
    await queue.enqueue("person-1", "manual");
    await tick();
    queue.stop();

    // The RUNNING write happened, the terminal failure-update threw, and the
    // recovery wrote PENDING — so the row must NOT be left RUNNING.
    assert.notEqual(
      h.job.status,
      "RUNNING",
      "job must not be stranded RUNNING after a post-visit DB error"
    );
    assert.equal(h.job.status, "PENDING", "job is rescheduled to PENDING for retry");

    // Short backoff so the picker retries soon (not the multi-hour failure
    // tiers, and not null).
    assert.ok(h.job.nextAttemptAt instanceof Date, "a retry time was set");
    const delayMs = h.job.nextAttemptAt.getTime() - Date.now();
    assert.ok(
      delayMs > 0 && delayMs <= 5 * 60 * 1000,
      `retry is near-term (got ${delayMs}ms)`
    );

    // The reschedule records why, for diagnostics.
    assert.match(String(h.job.lastError), /persist failed after visit/);

    // We saw the RUNNING write, the throwing terminal write, and the recovery
    // write — three updates against this job.
    const runningWrites = h.jobUpdates.filter((u) => u.data.status === "RUNNING");
    const terminalWrites = h.jobUpdates.filter((u) => u.data.attempts !== undefined);
    const recoveryWrites = h.jobUpdates.filter(
      (u) => u.data.status === "PENDING" && /persist failed after visit/.test(String(u.data.lastError))
    );
    assert.equal(runningWrites.length, 1, "row was marked RUNNING before the visit");
    assert.equal(terminalWrites.length, 1, "the failure-branch terminal update was attempted");
    assert.equal(recoveryWrites.length, 1, "the orphaned RUNNING row was recovered to PENDING");
  } finally {
    h.restore();
  }
});
