import test from "node:test";
import assert from "node:assert/strict";
import { createScheduledSendPromoter } from "../apps/runner/dist/services/scheduled-send-promoter.js";
import { createSendService } from "../apps/runner/dist/services/send.js";

// ---------------------------------------------------------------------------
// Promoter: the single gate that turns a SCHEDULED row into a dispatchable
// PENDING one. If it promotes a row that was concurrently cancelled or
// rescheduled, a cancelled/edited send still goes out. These fakes honour the
// status + scheduledFor guard so they mirror the real DB's updateMany WHERE.
// ---------------------------------------------------------------------------
function createGuardedPromoterPrisma(initialRows, opts = {}) {
  const rows = initialRows.map((r) => ({ ...r }));
  return {
    rows,
    sendRequest: {
      async findMany({ where }) {
        const lte = where.scheduledFor.lte.getTime();
        return rows
          .filter((r) => r.status === "SCHEDULED" && r.scheduledFor.getTime() <= lte)
          .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
          .map((r) => ({ id: r.id, clientSendId: r.clientSendId }));
      },
      async updateMany({ where, data }) {
        // Simulate a cancel/reschedule landing between findMany and updateMany.
        if (opts.beforeUpdateMany) opts.beforeUpdateMany(rows);
        const ids = new Set(where.id.in);
        const lte = where.scheduledFor ? where.scheduledFor.lte.getTime() : Infinity;
        let count = 0;
        for (const r of rows) {
          if (
            ids.has(r.id) &&
            (where.status === undefined || r.status === where.status) &&
            r.scheduledFor.getTime() <= lte
          ) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      },
      async count({ where }) {
        return rows.filter((r) => r.status === where.status).length;
      }
    }
  };
}

function countingSendQueue() {
  let kicks = 0;
  return {
    kicks: () => kicks,
    kick: () => {
      kicks += 1;
    },
    enqueueAndKick: async () => {},
    resume: () => {},
    getActiveCount: async () => 0
  };
}

const noopEventBus = { emit: () => {}, nextEventId: () => 1, subscribe: () => () => {} };

const past = (ms = 1000) => new Date(Date.now() - ms);
const future = (ms = 60_000) => new Date(Date.now() + ms);

function makePromoter(prisma, sendQueue = countingSendQueue()) {
  return { promoter: createScheduledSendPromoter({ prisma, sendQueue, eventBus: noopEventBus }), sendQueue };
}

test("promoter: promotes due SCHEDULED rows to PENDING", async () => {
  const prisma = createGuardedPromoterPrisma([
    { id: "a", clientSendId: "ca", status: "SCHEDULED", scheduledFor: past(2000) },
    { id: "b", clientSendId: "cb", status: "SCHEDULED", scheduledFor: past(1000) }
  ]);
  const { promoter } = makePromoter(prisma);
  const res = await promoter.tick();
  assert.equal(res.promoted, 2);
  assert.ok(prisma.rows.every((r) => r.status === "PENDING"));
});

test("promoter: a row CANCELLED in the window is NOT resurrected to PENDING", async () => {
  const prisma = createGuardedPromoterPrisma(
    [{ id: "a", clientSendId: "ca", status: "SCHEDULED", scheduledFor: past() }],
    { beforeUpdateMany: (rows) => { rows[0].status = "CANCELLED"; } }
  );
  const { promoter, sendQueue } = makePromoter(prisma);
  const res = await promoter.tick();
  assert.equal(res.promoted, 0, "cancelled row must not be promoted");
  assert.equal(prisma.rows[0].status, "CANCELLED", "must stay CANCELLED, never flip to PENDING");
  assert.equal(sendQueue.kicks(), 0, "nothing promoted -> no queue kick");
});

test("promoter: a row rescheduled to the future is NOT fired at its old time", async () => {
  const prisma = createGuardedPromoterPrisma(
    [{ id: "a", clientSendId: "ca", status: "SCHEDULED", scheduledFor: past() }],
    { beforeUpdateMany: (rows) => { rows[0].scheduledFor = future(); } }
  );
  const { promoter } = makePromoter(prisma);
  const res = await promoter.tick();
  assert.equal(res.promoted, 0, "rescheduled row must not be promoted at the old time");
  assert.equal(prisma.rows[0].status, "SCHEDULED");
});

test("promoter: mixed batch — only the still-scheduled row promotes; count is accurate", async () => {
  const prisma = createGuardedPromoterPrisma(
    [
      { id: "a", clientSendId: "ca", status: "SCHEDULED", scheduledFor: past() },
      { id: "b", clientSendId: "cb", status: "SCHEDULED", scheduledFor: past() }
    ],
    { beforeUpdateMany: (rows) => { rows.find((r) => r.id === "a").status = "CANCELLED"; } }
  );
  const { promoter, sendQueue } = makePromoter(prisma);
  const res = await promoter.tick();
  assert.equal(res.promoted, 1);
  assert.equal(prisma.rows.find((r) => r.id === "a").status, "CANCELLED");
  assert.equal(prisma.rows.find((r) => r.id === "b").status, "PENDING");
  assert.equal(sendQueue.kicks(), 1, "kicks once something was actually promoted");
});

// ---------------------------------------------------------------------------
// cancel / update: must be atomic against the promoter. The fake's findUnique
// applies an optional `raceAfterRead` hook to simulate the promoter flipping
// the row SCHEDULED -> PENDING in the window between the read and the write.
// ---------------------------------------------------------------------------
function makeSendHarness(initialRows, opts = {}) {
  const rows = initialRows.map((r) => ({ ...r }));
  const prisma = {
    sendRequest: {
      async findUnique({ where }) {
        const r = rows.find((x) => x.clientSendId === where.clientSendId);
        if (!r) return null;
        const snapshot = { ...r };
        if (opts.raceAfterRead) opts.raceAfterRead(r); // promoter wins the race
        return snapshot;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const r of rows) {
          if (
            r.clientSendId === where.clientSendId &&
            (where.status === undefined || r.status === where.status)
          ) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      }
    },
    thread: {
      async findUnique({ where }) {
        return { id: where.id, platform: "LINKEDIN" };
      }
    }
  };
  const svc = createSendService({
    adapters: {},
    eventBus: noopEventBus,
    settingsStore: {},
    auditLog: async () => "",
    withPlatformLock: (_platform, work) => work(),
    prisma
  });
  return { svc, rows };
}

const scheduledRow = (over = {}) => ({
  clientSendId: "c1",
  threadId: "t1",
  status: "SCHEDULED",
  requestText: "original",
  scheduledFor: future(3_600_000),
  ...over
});

test("cancel: a still-scheduled send is cancelled", async () => {
  const { svc, rows } = makeSendHarness([scheduledRow()]);
  const res = await svc.cancelScheduledSend({ clientSendId: "c1", threadId: "t1" });
  assert.deepEqual(res, { cancelled: true });
  assert.equal(rows[0].status, "CANCELLED");
});

test("cancel: promoted during the read window -> refused, and NOT stomped to CANCELLED", async () => {
  const { svc, rows } = makeSendHarness([scheduledRow()], {
    raceAfterRead: (r) => { r.status = "PENDING"; }
  });
  const res = await svc.cancelScheduledSend({ clientSendId: "c1", threadId: "t1" });
  assert.equal(res.cancelled, false);
  assert.equal(res.reason, "no_longer_scheduled");
  assert.equal(rows[0].status, "PENDING", "an in-flight send must not be recorded as cancelled");
});

test("cancel: a non-scheduled row is refused with a precise reason", async () => {
  const { svc, rows } = makeSendHarness([scheduledRow({ status: "SENT" })]);
  const res = await svc.cancelScheduledSend({ clientSendId: "c1", threadId: "t1" });
  assert.equal(res.cancelled, false);
  assert.equal(res.reason, "not_scheduled:SENT");
  assert.equal(rows[0].status, "SENT");
});

test("cancel: unknown clientSendId -> not_found", async () => {
  const { svc } = makeSendHarness([]);
  const res = await svc.cancelScheduledSend({ clientSendId: "nope", threadId: "t1" });
  assert.deepEqual(res, { cancelled: false, reason: "not_found" });
});

test("update: a still-scheduled send is updated", async () => {
  const { svc, rows } = makeSendHarness([scheduledRow()]);
  const newTime = future(7_200_000);
  const res = await svc.updateScheduledSend({
    clientSendId: "c1",
    threadId: "t1",
    text: "edited wording",
    scheduledFor: newTime
  });
  assert.equal(res.updated, true);
  assert.equal(rows[0].requestText, "edited wording");
  assert.equal(rows[0].scheduledFor.getTime(), newTime.getTime());
});

test("update: promoted during the read window -> refused, content NOT rewritten", async () => {
  const { svc, rows } = makeSendHarness([scheduledRow()], {
    raceAfterRead: (r) => { r.status = "PENDING"; }
  });
  const res = await svc.updateScheduledSend({ clientSendId: "c1", threadId: "t1", text: "edited wording" });
  assert.equal(res.updated, false);
  assert.equal(res.reason, "no_longer_scheduled");
  assert.equal(rows[0].requestText, "original", "an in-flight send's content must not be rewritten");
});
