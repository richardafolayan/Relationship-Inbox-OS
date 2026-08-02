import test from "node:test";
import assert from "node:assert/strict";
import {
  createSendService,
  SEND_CLAIM_MARKER,
  isClaimMarker
} from "../apps/runner/dist/services/send.js";

// ---------------------------------------------------------------------------
// BUG PH5 — processSendRequest must atomically CLAIM the PENDING row before the
// (non-idempotent) adapter send, so that:
//   * a re-kick / a post-restart resume() of a row whose send already went out
//     does NOT message the recipient a second time, and
//   * a row left in-doubt by a crash mid-send (PENDING + claim marker) is
//     reconciled to FAILED rather than blindly re-dispatched.
//
// The fake prisma below honours the real updateMany WHERE semantics, including
// the `receiptJson` guard the claim depends on (null vs. the claim marker).
// ---------------------------------------------------------------------------
function matchesWhere(row, where) {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "id") {
      if (row.id !== expected) return false;
    } else if (key === "clientSendId") {
      if (row.clientSendId !== expected) return false;
    } else if (key === "status") {
      if (row.status !== expected) return false;
    } else if (key === "receiptJson") {
      // Prisma: `receiptJson: null` matches only null/undefined; an explicit
      // string matches that exact string.
      if (expected === null) {
        if (row.receiptJson != null) return false;
      } else if (row.receiptJson !== expected) {
        return false;
      }
    } else {
      throw new Error(`unhandled where key in fake prisma: ${key}`);
    }
  }
  return true;
}

function makeHarness(initialRows, opts = {}) {
  const rows = initialRows.map((r) => ({ ...r }));
  const sends = []; // every physical adapter.sendMessage call
  const messages = []; // every Message upsert (one per actual persisted send)
  const events = [];

  const prisma = {
    sendRequest: {
      async findUnique({ where }) {
        const r = rows.find((x) =>
          where.id != null ? x.id === where.id : x.clientSendId === where.clientSendId
        );
        return r ? { ...r } : null;
      },
      async findFirst({ where }) {
        const match = rows.find((r) => matchesWhere(r, where));
        return match ? { ...match } : null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const r of rows) {
          if (matchesWhere(r, where)) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      },
      async update({ where, data }) {
        const r = rows.find((x) =>
          where.id != null ? x.id === where.id : x.clientSendId === where.clientSendId
        );
        if (!r) throw new Error("update: row not found");
        Object.assign(r, data);
        return { ...r };
      },
      async count({ where }) {
        return rows.filter((r) => matchesWhere(r, where)).length;
      }
    },
    thread: {
      async findUnique({ where }) {
        return {
          id: where.id,
          platform: "LINKEDIN",
          platformThreadId: "pt1",
          threadUrl: null,
          lastMessageAt: null,
          lastInboundAt: null,
          person: { displayName: "Test Person" }
        };
      },
      async update() {
        return {};
      }
    },
    message: {
      async upsert({ create }) {
        if (opts.messagePersistFailure) throw new Error("message persistence unavailable");
        messages.push(create);
        return {};
      }
    }
  };

  const adapter = {
    async sendMessage(_stub, text) {
      sends.push(text);
      if (opts.crashAfterSend) {
        // Simulate the process dying AFTER the physical send but BEFORE the
        // terminal SENT write: the adapter delivered, then we throw past the
        // SENT update so the row is left claimed-but-PENDING. (The catch in
        // processSendRequest will mark it FAILED in a real failure; for the
        // crash case the test instead inspects the claimed PENDING state by
        // never reaching this branch — see the dedicated crash test.)
        throw new Error("simulated crash after send");
      }
      return { sentAt: new Date().toISOString(), verifiedBy: "best_effort" };
    }
  };

  const svc = createSendService({
    adapters: { LINKEDIN: adapter },
    eventBus: { emit: (event) => events.push(event), nextEventId: () => 1, subscribe: () => () => {} },
    settingsStore: {
      getSettings: async () => ({
        presenterDemoMode: "off",
        amberHours: 24,
        redHours: 72
      }),
      getDemoSeedManifest: async () => null
    },
    auditLog: async () => "audit-id",
    withPlatformLock: (_platform, work) => work(),
    prisma
  });

  return { svc, rows, sends, messages, events };
}

const pendingRow = (over = {}) => ({
  id: "sr1",
  clientSendId: "c1",
  threadId: "t1",
  status: "PENDING",
  requestText: "hello there",
  receiptJson: null,
  errorJson: null,
  attachmentsJson: null,
  replyToMessageId: null,
  ...over
});

test("claim marker helper distinguishes a claim from a real receipt", () => {
  assert.equal(isClaimMarker(SEND_CLAIM_MARKER), true);
  assert.equal(isClaimMarker(null), false);
  assert.equal(isClaimMarker(JSON.stringify({ sentAt: "x", verifiedBy: "best_effort" })), false);
});

test("happy path: a PENDING row sends exactly once and lands SENT", async () => {
  const { svc, rows, sends } = makeHarness([pendingRow()]);
  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 1, "exactly one physical send");
  assert.equal(rows[0].status, "SENT");
});

test("re-dispatch of an already-SENT row does NOT re-send (resume after a completed send)", async () => {
  const { svc, rows, sends } = makeHarness([pendingRow()]);
  await svc.processSendRequest("sr1");
  assert.equal(rows[0].status, "SENT");
  // Simulate resume()/a re-kick re-reading the same row id.
  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 1, "must not re-send an already-terminal row");
});

test("a post-send persistence failure keeps the delivered request SENT", async () => {
  const { svc, rows, sends, events } = makeHarness([pendingRow()], {
    messagePersistFailure: true
  });
  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 1);
  assert.equal(rows[0].status, "SENT");
  assert.equal(JSON.parse(rows[0].receiptJson).verifiedBy, "best_effort");
  assert.equal(events.at(-1).type, "MESSAGE_SENT");

  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 1, "persistence recovery must never retry the physical send");
});

test("REGRESSION: two concurrent workers on one PENDING row send exactly once", async () => {
  const { svc, rows, sends } = makeHarness([pendingRow()]);
  await Promise.all([svc.processSendRequest("sr1"), svc.processSendRequest("sr1")]);
  // Without the atomic claim both workers pass the status===PENDING guard and
  // both call the adapter -> recipient messaged twice. The claim guard lets
  // only one win.
  assert.equal(sends.length, 1, "only the claim winner may dispatch the adapter");
  assert.equal(rows[0].status, "SENT");
});

test("REGRESSION: resume() does NOT re-send a row left in-doubt by a crash; it reconciles to FAILED", async () => {
  // A previous process claimed the row (wrote the marker) then died before the
  // SENT write — the durable state is PENDING + claim marker.
  const { svc, rows, sends } = makeHarness([
    pendingRow({ status: "PENDING", receiptJson: SEND_CLAIM_MARKER })
  ]);

  // processSendRequest must refuse the in-doubt row outright (the marker means
  // a send may already have physically gone out; re-dispatch is unsafe).
  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 0, "an in-doubt claimed row must never be re-dispatched");
  assert.equal(rows[0].status, "PENDING", "untouched until reconciled");

  // Boot reconciliation flips it to FAILED/INTERRUPTED for operator review.
  const reconciled = await svc.reconcileInterruptedSends();
  assert.equal(reconciled, 1);
  assert.equal(rows[0].status, "FAILED");
  const err = JSON.parse(rows[0].errorJson);
  assert.equal(err.errorKind, "INTERRUPTED");

  // After reconciliation it is terminal — still no send.
  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 0);
});

test("reconcileInterruptedSends leaves a fresh unclaimed PENDING row alone", async () => {
  const { svc, rows } = makeHarness([pendingRow()]);
  const reconciled = await svc.reconcileInterruptedSends();
  assert.equal(reconciled, 0, "a never-claimed PENDING row is a live queue item, not in-doubt");
  assert.equal(rows[0].status, "PENDING");
});
