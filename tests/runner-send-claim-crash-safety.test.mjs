import test from "node:test";
import assert from "node:assert/strict";
import { v5 as uuidv5 } from "uuid";
import {
  createSendService,
  SEND_CLAIM_MARKER,
  isClaimMarker
} from "../apps/runner/dist/services/send.js";
import { AdapterFailure } from "../apps/runner/dist/platforms/utils.js";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";
import { createAdminResetCoordinator } from "../apps/runner/dist/services/admin-reset-coordinator.js";
import { persistedSendRetryEligibility } from "../apps/runner/dist/services/send-failure.js";
import {
  focusAutoAckClientSendId,
  focusManualAckClientSendId
} from "../apps/runner/dist/services/focus-auto-ack.js";

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
      if (expected && Array.isArray(expected.in)) {
        if (!expected.in.includes(row.clientSendId)) return false;
      } else if (row.clientSendId !== expected) {
        return false;
      }
    } else if (key === "status") {
      if (expected && Array.isArray(expected.in)) {
        if (!expected.in.includes(row.status)) return false;
      } else if (row.status !== expected) {
        return false;
      }
    } else if (key === "receiptJson") {
      // Prisma: `receiptJson: null` matches only null/undefined; an explicit
      // string matches that exact string.
      if (expected === null) {
        if (row.receiptJson != null) return false;
      } else if (row.receiptJson !== expected) {
        return false;
      }
    } else if (key === "threadId") {
      if (row.threadId !== expected) return false;
    } else if (key === "source") {
      if (expected && Array.isArray(expected.in)) {
        if (!expected.in.includes(row.source)) return false;
      } else if (row.source !== expected) {
        return false;
      }
    } else if (key === "createdAt") {
      if (expected?.gt && !(row.createdAt > expected.gt)) return false;
      if (expected?.gte && !(row.createdAt >= expected.gte)) return false;
    } else if (key === "errorJson") {
      if (
        expected?.contains &&
        !(row.errorJson ?? "").includes(expected.contains)
      ) {
        return false;
      }
    } else if (key === "NOT") {
      if (matchesWhere(row, expected)) return false;
    } else {
      throw new Error(`unhandled where key in fake prisma: ${key}`);
    }
  }
  return true;
}

function makeHarness(initialRows, opts = {}) {
  let userIntentVersion = opts.userIntentVersion ?? 0;
  const rows = initialRows.map((r) => ({
    focusIntentVersion:
      Object.hasOwn(r, "focusIntentVersion")
        ? r.focusIntentVersion
        : r.source === "focus_ack" || r.source === "focus_auto_ack"
          ? userIntentVersion
          : null,
    ...r
  }));
  const sends = []; // every physical adapter.sendMessage call
  const sentStubs = [];
  const messages = []; // every Message upsert (one per actual persisted send)
  const events = [];
  let threadExists = true;
  let claimAttempts = 0;
  let supersedingQueryCount = 0;

  const prisma = {
    async $transaction(work) {
      return work(prisma);
    },
    sendRequest: {
      async findUnique({ where }) {
        const r = rows.find((x) =>
          where.id != null ? x.id === where.id : x.clientSendId === where.clientSendId
        );
        return r ? { ...r } : null;
      },
      async create({ data }) {
        if (rows.some((row) => row.clientSendId === data.clientSendId)) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = {
          id: `created-${rows.length + 1}`,
          receiptJson: null,
          errorJson: null,
          attachmentsJson: null,
          replyToMessageId: null,
          scheduledFor: null,
          createdAt: new Date(),
          ...data
        };
        rows.push(row);
        return { ...row };
      },
      async findFirst({ where }) {
        if (where.createdAt) {
          supersedingQueryCount += 1;
          await opts.onSupersedingQuery?.(supersedingQueryCount);
        }
        const match = rows.find((r) => matchesWhere(r, where));
        return match ? { ...match } : null;
      },
      async findMany({ where }) {
        return rows
          .filter((row) => {
            if (where.status && row.status !== where.status) return false;
            if (
              where.errorJson?.contains &&
              !(row.errorJson ?? "").includes(where.errorJson.contains)
            ) {
              return false;
            }
            return true;
          })
          .map((row) => ({ ...row }));
      },
      async updateMany({ where, data }) {
        if (data.receiptJson === SEND_CLAIM_MARKER) claimAttempts += 1;
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
        if (opts.failFailedTerminalWrite && data.status === "FAILED") {
          throw new Error("failed terminal write unavailable");
        }
        Object.assign(r, data);
        if (data.status === "SENT") events.push("send-terminal-persisted");
        return { ...r };
      },
      async count({ where }) {
        return rows.filter((r) => matchesWhere(r, where)).length;
      }
    },
    thread: {
      async findUnique({ where }) {
        if (!threadExists) return null;
        return {
          id: where.id,
          personId: opts.personId ?? "p1",
          platform: opts.platform ?? "LINKEDIN",
          category: opts.category ?? "genuine",
          isGroup: opts.isGroup ?? false,
          platformThreadId: "pt1",
          threadUrl: null,
          recipientVerificationLabel: opts.recipientVerificationLabel ?? null,
          lastMessageAt: null,
          lastInboundAt:
            opts.latestInboundAt ?? new Date("2026-08-24T12:00:00.000Z"),
          lastOutboundAt: opts.latestOutboundAt ?? null,
          userIntentVersion,
          person: {
            id: opts.personId ?? "p1",
            displayName: "Test Person",
            birthday: null,
            favouritedAt: new Date("2026-01-01T00:00:00.000Z")
          }
        };
      },
      async update({ data }) {
        if (opts.threadPersistError) throw new Error(opts.threadPersistError);
        opts.onThreadUpdate?.(data);
        return {};
      },
      async updateMany({ where, data }) {
        if (where.id !== "t1") return { count: 0 };
        if (data.userIntentVersion?.increment) {
          userIntentVersion += data.userIntentVersion.increment;
        }
        return { count: 1 };
      }
    },
    message: {
      async upsert({ where, update, create }) {
        if (opts.messagePersistError) throw new Error(opts.messagePersistError);
        const key = where.threadId_platformMessageKey;
        const existing = messages.find(
          (message) =>
            message.threadId === key.threadId &&
            message.platformMessageKey === key.platformMessageKey
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        messages.push(create);
        return { ...create };
      }
    }
  };

  const adapter = {
    async sendMessage(stub, text, _attachments, beforeDispatch) {
      sentStubs.push(stub);
      await opts.beforeAdapterDispatch?.();
      await beforeDispatch?.();
      sends.push(text);
      await opts.onSend?.();
      if (opts.adapterFailure) {
        throw opts.adapterFailure;
      }
      if (opts.adapterError) {
        throw new Error(opts.adapterError);
      }
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
    adapters: { LINKEDIN: adapter, INSTAGRAM: adapter },
    eventBus: {
      emit: (event) => {
        if (opts.failFailureEvent && event.type === "MESSAGE_SEND_FAILED") {
          throw new Error("failure event unavailable");
        }
      },
      nextEventId: () => 1,
      subscribe: () => () => {}
    },
    settingsStore: {
      getSettings: async () => ({
        presenterDemoMode: "off",
        enabledPlatforms: opts.enabledPlatforms ?? ["LINKEDIN", "IMESSAGE"],
        amberHours: 24,
        redHours: 72
      }),
      getOperatorProfile:
        opts.getOperatorProfile ??
        (async () => {
          opts.beforeOperatorProfileReturn?.(rows);
          return {
            focusWindow: {
              active: true,
              autoSendAcknowledgements: true,
              windowId: opts.windowId ?? "focus-1",
              startedAt: "2026-08-24T11:00:00.000Z",
              endsAt: "2099-08-24T13:00:00.000Z",
              ackedPersonIds: [],
              audience: "favourites",
              note: "I am focusing until [until].",
              professionalNote: "I am focusing until 2:00pm.",
              reason: "deep work"
            },
            ackTemplates: {
              close: "I am focusing until [until].",
              professional: "I am focusing until 2:00pm."
            },
            focusSettings: { reasonLabel: false }
          };
        }),
      getDemoSeedManifest: async () => null
    },
    auditLog: async (input) => {
      if (opts.failVerifyAudit && input.stage === "Verify") {
        throw new Error("verify audit unavailable");
      }
      return "audit-id";
    },
    withExternalActionLock:
      opts.withExternalActionLock ?? ((_platform, work) => work()),
    withPlatformLock: opts.withPlatformLock ?? ((_platform, work) => work()),
    prisma
  });

  return {
    svc,
    rows,
    sends,
    sentStubs,
    messages,
    events,
    claimAttempts: () => claimAttempts,
    deleteGraph() {
      events.push("graph-deleted");
      rows.splice(0, rows.length);
      threadExists = false;
    }
  };
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
  scheduledFor: null,
  recoveryPredecessorClientSendId: null,
  source: "manual",
  createdAt: new Date("2026-08-24T12:00:00.000Z"),
  ...over
});

function focusAutoAckRow(over = {}) {
  return pendingRow({
    clientSendId: uuidv5("focus-1:p1", uuidv5.URL),
    source: "focus_auto_ack",
    requestText: "I am focusing until 2:00pm.",
    ...over
  });
}

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

test("worker cancels a recovered successor when its predecessor is no longer unsent", async () => {
  const predecessor = pendingRow({
    id: "predecessor",
    clientSendId: "predecessor-client",
    status: "SENT",
    receiptJson: JSON.stringify({
      sentAt: "2026-08-24T12:00:00.000Z",
      verifiedBy: "best_effort"
    })
  });
  const successor = pendingRow({
    id: "successor",
    clientSendId: "successor-client",
    recoveryPredecessorClientSendId: predecessor.clientSendId
  });
  const { svc, rows, sends } = makeHarness([predecessor, successor]);

  await svc.processSendRequest(successor.id);

  assert.equal(sends.length, 0);
  assert.equal(
    rows.find((row) => row.id === successor.id)?.status,
    "CANCELLED"
  );
  assert.equal(
    JSON.parse(rows.find((row) => row.id === successor.id)?.errorJson).reasonCode,
    "recovery_predecessor_not_retryable"
  );
});

test("a policy-cancelled successor cannot dispatch another descendant", async () => {
  const terminalAncestor = pendingRow({
    id: "ancestor",
    clientSendId: "ancestor-client",
    status: "SENT",
    receiptJson: JSON.stringify({
      sentAt: "2026-08-24T12:00:00.000Z",
      verifiedBy: "best_effort"
    })
  });
  const cancelledSuccessor = pendingRow({
    id: "cancelled-successor",
    clientSendId: "cancelled-successor-client",
    status: "CANCELLED",
    errorJson: JSON.stringify({
      errorKind: "POLICY_BLOCKED",
      message: "The earlier send is no longer definitely unsent",
      reasonCode: "recovery_predecessor_not_retryable"
    }),
    recoveryPredecessorClientSendId: terminalAncestor.clientSendId
  });
  const descendant = pendingRow({
    id: "descendant",
    clientSendId: "descendant-client",
    recoveryPredecessorClientSendId: cancelledSuccessor.clientSendId
  });
  const { svc, rows, sends } = makeHarness([
    terminalAncestor,
    cancelledSuccessor,
    descendant
  ]);

  await svc.processSendRequest(descendant.id);

  assert.equal(sends.length, 0);
  const persistedDescendant = rows.find((row) => row.id === descendant.id);
  assert.equal(persistedDescendant?.status, "CANCELLED");
  assert.equal(
    JSON.parse(persistedDescendant?.errorJson).reasonCode,
    "recovery_predecessor_not_retryable"
  );
});

test("worker rechecks a recovered predecessor at the physical dispatch boundary", async () => {
  const predecessor = pendingRow({
    id: "predecessor",
    clientSendId: "predecessor-client",
    status: "FAILED",
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" })
  });
  const successor = pendingRow({
    id: "successor",
    clientSendId: "successor-client",
    recoveryPredecessorClientSendId: predecessor.clientSendId
  });
  const h = makeHarness([predecessor, successor], {
    beforeAdapterDispatch() {
      const livePredecessor = h.rows.find((row) => row.id === predecessor.id);
      livePredecessor.status = "SENT";
      livePredecessor.errorJson = null;
      livePredecessor.receiptJson = JSON.stringify({
        sentAt: "2026-08-24T12:00:00.000Z",
        verifiedBy: "best_effort"
      });
    }
  });

  await h.svc.processSendRequest(successor.id);

  assert.equal(h.sends.length, 0);
  assert.equal(
    h.rows.find((row) => row.id === successor.id)?.status,
    "FAILED"
  );
  assert.equal(
    JSON.parse(h.rows.find((row) => row.id === successor.id)?.errorJson).reasonCode,
    "recovery_predecessor_not_retryable"
  );
});

test("worker rechecks the full recovered lineage at the physical dispatch boundary", async () => {
  const ancestor = pendingRow({
    id: "ancestor",
    clientSendId: "ancestor-client",
    status: "FAILED",
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" })
  });
  const predecessor = pendingRow({
    id: "predecessor",
    clientSendId: "predecessor-client",
    status: "FAILED",
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" }),
    recoveryPredecessorClientSendId: ancestor.clientSendId
  });
  const successor = pendingRow({
    id: "successor",
    clientSendId: "successor-client",
    recoveryPredecessorClientSendId: predecessor.clientSendId
  });
  const h = makeHarness([ancestor, predecessor, successor], {
    beforeAdapterDispatch() {
      const liveAncestor = h.rows.find((row) => row.id === ancestor.id);
      liveAncestor.status = "SENT";
      liveAncestor.errorJson = null;
      liveAncestor.receiptJson = JSON.stringify({
        sentAt: "2026-08-24T12:00:00.000Z",
        verifiedBy: "best_effort"
      });
    }
  });

  await h.svc.processSendRequest(successor.id);

  assert.equal(h.sends.length, 0);
  const persistedSuccessor = h.rows.find((row) => row.id === successor.id);
  assert.equal(persistedSuccessor?.status, "FAILED");
  assert.equal(
    JSON.parse(persistedSuccessor?.errorJson).reasonCode,
    "recovery_predecessor_not_retryable"
  );
});

test("send dispatch preserves the last platform-authoritative recipient label", async () => {
  const { svc, sentStubs } = makeHarness([pendingRow()], {
    platform: "INSTAGRAM",
    recipientVerificationLabel: "Current Instagram name"
  });

  await svc.processSendRequest("sr1");

  assert.equal(sentStubs[0].displayName, "Test Person");
  assert.equal(sentStubs[0].recipientVerificationLabel, "Current Instagram name");
});

test("worker refuses a stale scheduled Instagram row before any physical send", async () => {
  const { svc, rows, sends } = makeHarness(
    [pendingRow({ scheduledFor: new Date(Date.now() - 60_000) })],
    { platform: "INSTAGRAM" }
  );

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "instagram_send_policy_rejected");
});

test("worker refuses persisted Instagram auto-ack provenance before any physical send", async () => {
  const { svc, rows, sends } = makeHarness(
    [pendingRow({ source: "focus_auto_ack" })],
    { platform: "INSTAGRAM" }
  );

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "instagram_send_policy_rejected");
});

test("worker revalidates focus auto-ack eligibility inside the platform lease", async () => {
  const opts = {
    category: "genuine",
    withPlatformLock: async (_platform, work) => {
      opts.category = "outreach";
      return work();
    }
  };
  const { svc, rows, sends } = makeHarness(
    [pendingRow({ source: "focus_auto_ack" })],
    opts
  );

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "focus_auto_ack_not_eligible");
});

test("worker refuses a queued focus auto-ack after a newer manual reply", async () => {
  const opts = {
    latestOutboundAt: null,
    withPlatformLock: async (_platform, work) => {
      opts.latestOutboundAt = new Date("2026-08-24T12:01:00.000Z");
      return work();
    }
  };
  const { svc, rows, sends } = makeHarness([focusAutoAckRow()], opts);

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "focus_auto_ack_not_eligible");
});

test("worker refuses a queued focus auto-ack after a newer manual request is queued", async () => {
  const autoAck = focusAutoAckRow({
    id: "auto-ack",
    createdAt: new Date("2026-08-24T12:00:00.000Z")
  });
  const manual = pendingRow({
    id: "manual",
    clientSendId: "manual-1",
    source: "manual",
    createdAt: new Date("2026-08-24T12:01:00.000Z")
  });
  const { svc, rows, sends } = makeHarness([autoAck, manual]);

  await svc.processSendRequest("auto-ack");

  assert.equal(sends.length, 0);
  assert.equal(rows.find((row) => row.id === "auto-ack").status, "FAILED");
  assert.equal(
    JSON.parse(rows.find((row) => row.id === "auto-ack").errorJson).reasonCode,
    "focus_auto_ack_superseded"
  );
  assert.equal(rows.find((row) => row.id === "manual").status, "PENDING");
});

test("worker checks again when a manual reply arrives during auto-ack revalidation", async () => {
  const manual = pendingRow({
    id: "manual",
    clientSendId: "manual-1",
    source: "manual",
    createdAt: new Date("2026-08-24T12:01:00.000Z")
  });
  const { svc, rows, sends } = makeHarness([focusAutoAckRow()], {
    beforeOperatorProfileReturn(currentRows) {
      currentRows.push(manual);
    }
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows.find((row) => row.id === "sr1").status, "FAILED");
  assert.equal(
    JSON.parse(rows.find((row) => row.id === "sr1").errorJson).reasonCode,
    "focus_auto_ack_superseded"
  );
});

test("an in-flight user send intent supersedes auto-ack before its row is persisted", async () => {
  const { svc, rows, sends } = makeHarness([focusAutoAckRow()]);

  await svc.withUserTriggeredIntent("t1", () => svc.processSendRequest("sr1"));

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("manual intent arriving during the final database guard still supersedes auto-ack", async () => {
  let releaseFinalQuery;
  let finalQueryStarted;
  const finalQuery = new Promise((resolve) => { releaseFinalQuery = resolve; });
  const reachedFinalQuery = new Promise((resolve) => { finalQueryStarted = resolve; });
  const h = makeHarness([focusAutoAckRow()], {
    async onSupersedingQuery(count) {
      if (count !== 2) return;
      finalQueryStarted();
      await finalQuery;
    }
  });

  const processing = h.svc.processSendRequest("sr1");
  await reachedFinalQuery;
  const releaseIntent = h.svc.registerUserTriggeredIntent("t1");
  releaseFinalQuery();
  await processing;
  releaseIntent();

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("a completed manual request during boundary revalidation still supersedes auto-ack", async () => {
  let releaseFinalQuery;
  let finalQueryStarted;
  const finalQuery = new Promise((resolve) => { releaseFinalQuery = resolve; });
  const reachedFinalQuery = new Promise((resolve) => { finalQueryStarted = resolve; });
  const h = makeHarness([focusAutoAckRow()], {
    async onSupersedingQuery(count) {
      if (count !== 2) return;
      finalQueryStarted();
      await finalQuery;
    }
  });

  const processing = h.svc.processSendRequest("sr1");
  await reachedFinalQuery;
  const releaseIntent = h.svc.registerUserTriggeredIntent("t1");
  releaseIntent();
  releaseFinalQuery();
  await processing;

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("a focus-policy write at the physical-send boundary supersedes auto-ack", async () => {
  let releaseFinalQuery;
  let finalQueryStarted;
  const finalQuery = new Promise((resolve) => { releaseFinalQuery = resolve; });
  const reachedFinalQuery = new Promise((resolve) => { finalQueryStarted = resolve; });
  const h = makeHarness([focusAutoAckRow()], {
    async onSupersedingQuery(count) {
      if (count !== 2) return;
      finalQueryStarted();
      await finalQuery;
    }
  });

  const processing = h.svc.processSendRequest("sr1");
  await reachedFinalQuery;
  const releasePolicyMutation = h.svc.registerFocusPolicyMutationIntent();
  releaseFinalQuery();
  await processing;
  releasePolicyMutation();

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("a completed focus-policy write during boundary revalidation still supersedes auto-ack", async () => {
  let releaseFinalQuery;
  let finalQueryStarted;
  const finalQuery = new Promise((resolve) => { releaseFinalQuery = resolve; });
  const reachedFinalQuery = new Promise((resolve) => { finalQueryStarted = resolve; });
  const h = makeHarness([focusAutoAckRow()], {
    async onSupersedingQuery(count) {
      if (count !== 2) return;
      finalQueryStarted();
      await finalQuery;
    }
  });

  const processing = h.svc.processSendRequest("sr1");
  await reachedFinalQuery;
  const releasePolicyMutation = h.svc.registerFocusPolicyMutationIntent();
  releasePolicyMutation();
  releaseFinalQuery();
  await processing;

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("a completed manual intent between the two dispatch guards still supersedes auto-ack", async () => {
  let h;
  h = makeHarness([focusAutoAckRow()], {
    async beforeAdapterDispatch() {
      const releaseIntent = h.svc.registerUserTriggeredIntent("t1");
      releaseIntent();
    }
  });

  await h.svc.processSendRequest("sr1");

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("an unreconciled earlier manual send blocks auto-ack dispatch", async () => {
  const autoAck = focusAutoAckRow({ id: "auto-ack" });
  const unresolvedManual = pendingRow({
    id: "manual-sent",
    clientSendId: "manual-sent-client",
    source: "manual",
    status: "SENT",
    createdAt: new Date("2026-08-24T11:00:00.000Z"),
    receiptJson: JSON.stringify({
      sentAt: "2026-08-24T11:00:00.000Z",
      verifiedBy: "best_effort"
    }),
    errorJson: JSON.stringify({
      reconciliationRequired: true,
      reason: "local_projection_required"
    })
  });
  const h = makeHarness([autoAck, unresolvedManual]);

  await h.svc.processSendRequest("auto-ack");

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("manual focus acknowledgements require deterministic window and person identity", async () => {
  const h = makeHarness([]);

  await assert.rejects(
    h.svc.enqueueSend({
      threadId: "t1",
      text: "I am focusing until 2:00pm.",
      clientSendId: "00000000-0000-4000-8000-000000000000",
      source: "focus_ack",
      focusWindowId: "focus-1",
      focusIntentVersion: 0
    }),
    /identity does not match/
  );
  assert.equal(h.rows.length, 0);
});

test("manual focus acknowledgements reject a stale focus window", async () => {
  const h = makeHarness([], { windowId: "focus-current" });

  await assert.rejects(
    h.svc.enqueueSend({
      threadId: "t1",
      text: "I am focusing until 2:00pm.",
      clientSendId: focusManualAckClientSendId("focus-stale", "p1"),
      source: "focus_ack",
      focusWindowId: "focus-stale",
      focusIntentVersion: 0
    }),
    /no longer eligible/
  );
  assert.equal(h.rows.length, 0);
});

test("manual focus acknowledgement supersedes an unclaimed automatic row", async () => {
  const h = makeHarness([]);
  const automaticId = focusAutoAckClientSendId("focus-1", "p1");
  const manualId = focusManualAckClientSendId("focus-1", "p1");

  await h.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId: automaticId,
    source: "focus_auto_ack",
    focusWindowId: "focus-1"
  });
  await h.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId: manualId,
    source: "focus_ack",
    focusWindowId: "focus-1",
    focusIntentVersion: 0
  });

  assert.equal(h.rows.find((row) => row.clientSendId === automaticId)?.status, "CANCELLED");
  assert.equal(h.rows.find((row) => row.clientSendId === manualId)?.status, "PENDING");
  assert.equal(h.rows.filter((row) => row.status === "PENDING").length, 1);
});

test("manual focus acknowledgement does not adopt a claimed automatic row", async () => {
  const automaticId = focusAutoAckClientSendId("focus-1", "p1");
  const manualId = focusManualAckClientSendId("focus-1", "p1");
  const h = makeHarness([
    focusAutoAckRow({
      id: "claimed-auto",
      clientSendId: automaticId,
      requestText: "I am unavailable until 2:00pm.",
      receiptJson: SEND_CLAIM_MARKER
    })
  ]);

  await assert.rejects(
    h.svc.enqueueSend({
      threadId: "t1",
      text: "I am focusing until 2:00pm.",
      clientSendId: manualId,
      source: "focus_ack",
      focusWindowId: "focus-1",
      focusIntentVersion: 0
    }),
    /already being processed/
  );

  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].clientSendId, automaticId);
  assert.equal(h.rows[0].status, "PENDING");
});

test("manual focus acknowledgement does not adopt an in-doubt automatic row", async () => {
  const automaticId = focusAutoAckClientSendId("focus-1", "p1");
  const manualId = focusManualAckClientSendId("focus-1", "p1");
  const h = makeHarness([
    focusAutoAckRow({
      id: "uncertain-auto",
      clientSendId: automaticId,
      status: "FAILED",
      receiptJson: SEND_CLAIM_MARKER,
      errorJson: JSON.stringify({
        errorKind: "DELIVERY_UNCERTAIN",
        message: "Delivery could not be confirmed"
      })
    })
  ]);

  await assert.rejects(
    h.svc.enqueueSend({
      threadId: "t1",
      text: "I am focusing until 2:00pm.",
      clientSendId: manualId,
      source: "focus_ack",
      focusWindowId: "focus-1",
      focusIntentVersion: 0
    }),
    /could not be confirmed/
  );

  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].clientSendId, automaticId);
  assert.equal(h.rows[0].status, "FAILED");
});

test("a cancelled automatic row cannot shadow the manual acknowledgement on replay", async () => {
  const h = makeHarness([]);
  const automaticId = focusAutoAckClientSendId("focus-1", "p1");
  const manualId = focusManualAckClientSendId("focus-1", "p1");
  const automatic = {
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId: automaticId,
    source: "focus_auto_ack",
    focusWindowId: "focus-1"
  };
  const manual = {
    ...automatic,
    clientSendId: manualId,
    source: "focus_ack",
    focusIntentVersion: 0
  };
  await h.svc.enqueueSend(automatic);
  await h.svc.enqueueSend(manual);

  const pendingReplay = await h.svc.enqueueSend(manual);
  assert.equal(pendingReplay.clientSendId, manualId);
  assert.equal(pendingReplay.status, "PENDING");
  const manualRow = h.rows.find((row) => row.clientSendId === manualId);
  manualRow.status = "SENT";
  manualRow.receiptJson = JSON.stringify({
    sentAt: "2026-08-24T12:01:00.000Z",
    verifiedBy: "best_effort"
  });

  const sentReplay = await h.svc.enqueueSend(manual);
  assert.equal(sentReplay.clientSendId, manualId);
  assert.equal(sentReplay.status, "SENT");
});

test("focus retry validates and re-arms the failed manual row without a pending leak", async () => {
  const automaticId = focusAutoAckClientSendId("focus-1", "p1");
  const manualId = focusManualAckClientSendId("focus-1", "p1");
  const h = makeHarness([
    focusAutoAckRow({
      id: "auto",
      clientSendId: automaticId,
      status: "CANCELLED",
      createdAt: new Date("2026-08-24T11:59:00.000Z")
    }),
    pendingRow({
      id: "manual",
      clientSendId: manualId,
      source: "focus_ack",
      status: "FAILED",
      errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" }),
      createdAt: new Date("2026-08-24T12:00:00.000Z")
    })
  ]);

  const retried = await h.svc.enqueueSend({
    threadId: "t1",
    text: "hello there",
    clientSendId: manualId,
    source: "focus_ack",
    focusWindowId: "focus-1",
    focusIntentVersion: 0,
    retryFailedFocusAcknowledgement: true
  });

  assert.equal(retried.status, "PENDING");
  assert.equal(h.rows.find((row) => row.id === "manual").status, "PENDING");
  assert.equal(h.rows.filter((row) => row.status === "PENDING").length, 1);
});

test("a manual focus acknowledgement does not supersede itself while its request is active", async () => {
  const h = makeHarness([]);
  const clientSendId = focusManualAckClientSendId("focus-1", "p1");
  const releaseIntent = h.svc.registerUserTriggeredIntent("t1");
  await h.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId,
    source: "focus_ack",
    focusWindowId: "focus-1",
    focusIntentVersion: 0
  });

  await h.svc.processSendRequest(h.rows[0].id);
  releaseIntent();

  assert.deepEqual(h.sends, ["I am focusing until 2:00pm."]);
  assert.equal(h.rows[0].status, "SENT");
});

test("an intent completed after auto-ack enqueue still blocks later dispatch", async () => {
  const h = makeHarness([]);
  const clientSendId = focusAutoAckClientSendId("focus-1", "p1");
  await h.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId,
    source: "focus_auto_ack",
    focusWindowId: "focus-1"
  });
  const releaseIntent = h.svc.registerUserTriggeredIntent("t1");
  releaseIntent();

  await h.svc.processSendRequest(h.rows[0].id);

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("replaying an existing auto-ack cannot adopt a newer durable intent version", async () => {
  const h = makeHarness([]);
  const input = {
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId: focusAutoAckClientSendId("focus-1", "p1"),
    source: "focus_auto_ack",
    focusWindowId: "focus-1"
  };
  await h.svc.enqueueSend(input);
  const laterIntent = h.svc.registerDurableUserTriggeredIntent("t1");
  assert.equal(await laterIntent.ready, 1);
  laterIntent.release();

  await h.svc.enqueueSend(input);
  assert.equal(h.rows[0].focusIntentVersion, 0);
  await h.svc.processSendRequest(h.rows[0].id);

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_superseded");
});

test("replaying a legacy manual focus row cannot invent its missing durable baseline", async () => {
  const clientSendId = focusManualAckClientSendId("focus-1", "p1");
  const h = makeHarness([
    pendingRow({
      clientSendId,
      source: "focus_ack",
      requestText: "I am focusing until 2:00pm.",
      focusIntentVersion: null
    })
  ], { userIntentVersion: 3 });

  await assert.rejects(
    h.svc.enqueueSend({
      threadId: "t1",
      text: "I am focusing until 2:00pm.",
      clientSendId,
      source: "focus_ack",
      focusWindowId: "focus-1",
      focusIntentVersion: 3
    }),
    /safety state is unavailable/
  );
  assert.equal(h.rows[0].focusIntentVersion, null);

  await h.svc.processSendRequest(h.rows[0].id);
  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_ack_superseded");
});

test("replaying a superseded manual focus row preserves its original durable baseline", async () => {
  const clientSendId = focusManualAckClientSendId("focus-1", "p1");
  const h = makeHarness([
    pendingRow({
      clientSendId,
      source: "focus_ack",
      requestText: "I am focusing until 2:00pm.",
      focusIntentVersion: 1
    })
  ], { userIntentVersion: 3 });

  await assert.rejects(
    h.svc.enqueueSend({
      threadId: "t1",
      text: "I am focusing until 2:00pm.",
      clientSendId,
      source: "focus_ack",
      focusWindowId: "focus-1",
      focusIntentVersion: 3
    }),
    /superseded/
  );
  assert.equal(h.rows[0].focusIntentVersion, 1);

  await h.svc.processSendRequest(h.rows[0].id);
  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_ack_superseded");
});

test("a fresh manual action can re-arm a safely policy-blocked focus acknowledgement", async () => {
  const clientSendId = focusManualAckClientSendId("focus-1", "p1");
  const h = makeHarness([]);
  const originalIntent = h.svc.registerDurableUserTriggeredIntent("t1");
  assert.equal(await originalIntent.ready, 1);
  await h.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId,
    source: "focus_ack",
    focusWindowId: "focus-1",
    focusIntentVersion: 1
  });
  originalIntent.release();

  const supersedingIntent = h.svc.registerDurableUserTriggeredIntent("t1");
  assert.equal(await supersedingIntent.ready, 2);
  supersedingIntent.release();
  await h.svc.processSendRequest(h.rows[0].id);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).errorKind, "POLICY_BLOCKED");

  const freshIntent = h.svc.registerDurableUserTriggeredIntent("t1");
  assert.equal(await freshIntent.ready, 3);
  const rearmed = await h.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 3:00pm.",
    clientSendId,
    source: "focus_ack",
    focusWindowId: "focus-1",
    focusIntentVersion: 3,
    rearmPolicyBlockedFocusAcknowledgement: true
  });
  freshIntent.release();

  assert.equal(rearmed.status, "PENDING");
  assert.equal(h.rows[0].status, "PENDING");
  assert.equal(h.rows[0].requestText, "I am focusing until 3:00pm.");
  assert.equal(h.rows[0].focusIntentVersion, 3);
  await h.svc.processSendRequest(h.rows[0].id);
  assert.deepEqual(h.sends, ["I am focusing until 3:00pm."]);
  assert.equal(h.rows[0].status, "SENT");
});

test("a later durable intent supersedes an older focus request regardless of enqueue order", async () => {
  const h = makeHarness([]);
  const focusIntent = h.svc.registerDurableUserTriggeredIntent("t1");
  assert.equal(await focusIntent.ready, 1);
  const laterIntent = h.svc.registerDurableUserTriggeredIntent("t1");
  assert.equal(await laterIntent.ready, 2);
  laterIntent.release();

  const clientSendId = focusManualAckClientSendId("focus-1", "p1");
  await h.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId,
    source: "focus_ack",
    focusWindowId: "focus-1",
    focusIntentVersion: 1
  });
  focusIntent.release();
  await h.svc.processSendRequest(h.rows[0].id);

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_ack_superseded");
});

test("a restarted service rejects a pending focus row with an older durable intent version", async () => {
  const beforeRestart = makeHarness([]);
  await beforeRestart.svc.enqueueSend({
    threadId: "t1",
    text: "I am focusing until 2:00pm.",
    clientSendId: focusAutoAckClientSendId("focus-1", "p1"),
    source: "focus_auto_ack",
    focusWindowId: "focus-1"
  });
  const laterIntent = beforeRestart.svc.registerDurableUserTriggeredIntent("t1");
  assert.equal(await laterIntent.ready, 1);
  laterIntent.release();

  const afterRestart = makeHarness(beforeRestart.rows, { userIntentVersion: 1 });
  await afterRestart.svc.processSendRequest(afterRestart.rows[0].id);

  assert.equal(afterRestart.sends.length, 0);
  assert.equal(afterRestart.rows[0].status, "FAILED");
  assert.equal(
    JSON.parse(afterRestart.rows[0].errorJson).reasonCode,
    "focus_auto_ack_superseded"
  );
});

test("focus-policy intent leases are counted and each release is idempotent", async () => {
  const h = makeHarness([focusAutoAckRow({ id: "auto-ack" })]);
  const releaseFirst = h.svc.registerFocusPolicyMutationIntent();
  const releaseSecond = h.svc.registerFocusPolicyMutationIntent();

  releaseFirst();
  releaseFirst();
  await h.svc.processSendRequest("auto-ack");
  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");

  releaseSecond();
  Object.assign(h.rows[0], { status: "PENDING", receiptJson: null, errorJson: null });
  await h.svc.processSendRequest("auto-ack");
  assert.deepEqual(h.sends, ["I am focusing until 2:00pm."]);
  assert.equal(h.rows[0].status, "SENT");
});

test("ending the focus window during the final database guard prevents auto-ack", async () => {
  let active = true;
  const h = makeHarness([focusAutoAckRow()], {
    async onSupersedingQuery(count) {
      if (count === 2) active = false;
    },
    getOperatorProfile: async () => ({
      focusWindow: {
        active,
        autoSendAcknowledgements: true,
        windowId: "focus-1",
        startedAt: "2026-08-24T11:00:00.000Z",
        endsAt: "2099-08-24T13:00:00.000Z",
        ackedPersonIds: ["p1"],
        audience: "favourites",
        note: "I am focusing until [until].",
        professionalNote: "I am focusing until [until].",
        reason: "deep work"
      },
      ackTemplates: {
        close: "I am focusing until [until].",
        professional: "I am focusing until [until]."
      },
      focusSettings: { reasonLabel: false }
    })
  });

  await h.svc.processSendRequest("sr1");

  assert.equal(h.sends.length, 0);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).reasonCode, "focus_auto_ack_not_eligible");
});

test("worker treats an equal-timestamp manual request as superseding auto-ack", async () => {
  const createdAt = new Date("2026-08-24T12:00:00.000Z");
  const autoAck = focusAutoAckRow({ id: "auto-ack", createdAt });
  const manual = pendingRow({
    id: "manual",
    clientSendId: "manual-1",
    source: "manual",
    createdAt
  });
  const { svc, rows, sends } = makeHarness([autoAck, manual]);

  await svc.processSendRequest("auto-ack");

  assert.equal(sends.length, 0);
  assert.equal(rows.find((row) => row.id === "auto-ack").status, "FAILED");
  assert.equal(
    JSON.parse(rows.find((row) => row.id === "auto-ack").errorJson).reasonCode,
    "focus_auto_ack_superseded"
  );
});

test("worker refuses queued auto-ack text after the active note changes", async () => {
  const { svc, rows, sends } = makeHarness([focusAutoAckRow()], {
    getOperatorProfile: async () => ({
      focusWindow: {
        active: true,
        autoSendAcknowledgements: true,
        windowId: "focus-1",
        startedAt: "2026-08-24T11:00:00.000Z",
        endsAt: "2099-08-24T13:00:00.000Z",
        ackedPersonIds: ["p1"],
        audience: "favourites",
        note: "My focus note changed. I will reply after [until].",
        professionalNote: "My focus note changed. I will reply after [until].",
        reason: "deep work"
      },
      ackTemplates: {
        close: "My focus note changed. I will reply after [until].",
        professional: "My focus note changed. I will reply after [until]."
      },
      focusSettings: { reasonLabel: false }
    })
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "focus_auto_ack_not_eligible");
});

test("worker refuses a queued focus auto-ack after its focus window ends", async () => {
  const { svc, rows, sends } = makeHarness([focusAutoAckRow()], {
    getOperatorProfile: async () => ({
      focusWindow: {
        active: false,
        autoSendAcknowledgements: true,
        windowId: "focus-1",
        startedAt: "2026-08-24T11:00:00.000Z",
        endsAt: "2026-08-24T13:00:00.000Z",
        ackedPersonIds: ["p1"],
        audience: "favourites",
        note: "I am focusing until [until].",
        professionalNote: "I am focusing until [until].",
        reason: "deep work"
      },
      ackTemplates: {
        close: "I am focusing until [until].",
        professional: "I am focusing until [until]."
      },
      focusSettings: { reasonLabel: false }
    })
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "focus_auto_ack_not_eligible");
});

test("worker binds queued focus auto-ack provenance to the exact active window", async () => {
  const { svc, rows, sends } = makeHarness([focusAutoAckRow()], {
    windowId: "focus-2"
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 0);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, "focus_auto_ack_not_eligible");
});

test("Instagram send failures never persist private platform URLs", async () => {
  const privateUrl = "https://www.instagram.com/direct/t/private-thread-id/";
  const { svc, rows } = makeHarness(
    [pendingRow()],
    { platform: "INSTAGRAM", adapterError: `navigation failed at ${privateUrl}` }
  );

  await svc.processSendRequest("sr1");

  assert.equal(rows[0].status, "FAILED");
  assert.equal(rows[0].errorJson.includes(privateUrl), false);
  assert.equal(rows[0].errorJson.includes("private-thread-id"), false);
});

test("Instagram send failures discard diagnostic artifacts and unsafe reason values", async () => {
  const privateSentinel = "PRIVATE_ARTIFACT_AND_REASON";
  const { svc, rows } = makeHarness(
    [pendingRow()],
    {
      platform: "INSTAGRAM",
      adapterFailure: new AdapterFailure("Instagram send failed", {
        kind: "THREAD_FETCH_FAILED",
        platform: "INSTAGRAM",
        stage: "persist",
        screenshotFile: `${privateSentinel}.png`,
        domDumpFile: `${privateSentinel}.html`,
        details: { reason: privateSentinel }
      })
    }
  );

  await svc.processSendRequest("sr1");

  assert.equal(rows[0].status, "FAILED");
  assert.equal(rows[0].errorJson.includes(privateSentinel), false);
  assert.equal(JSON.parse(rows[0].errorJson).reasonCode, undefined);
});

test("a successful physical send stays SENT when its verification audit fails", async () => {
  const { svc, rows, sends } = makeHarness([pendingRow()], {
    failVerifyAudit: true
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 1);
  assert.equal(rows[0].status, "SENT");
  assert.deepEqual(
    persistedSendRetryEligibility(rows[0].status, rows[0].errorJson),
    { allowed: false, reason: "not_failed" }
  );
});

test("a successful physical send stays SENT when local message projection fails", async () => {
  const options = { messagePersistError: "local database projection failed" };
  const { svc, rows, sends, messages } = makeHarness([pendingRow()], options);

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 1);
  assert.equal(rows[0].status, "SENT");
  assert.equal(JSON.parse(rows[0].errorJson).reconciliationRequired, true);
  assert.deepEqual(
    persistedSendRetryEligibility(rows[0].status, rows[0].errorJson),
    { allowed: false, reason: "not_failed" }
  );

  delete options.messagePersistError;
  assert.equal(await svc.reconcileSentProjections(), 1);
  assert.equal(rows[0].errorJson, null);
  assert.equal(messages.length, 1);
});

test("startup send repair preserves a newer edit and reaction projection", async () => {
  const options = { threadPersistError: "thread projection failed" };
  const { svc, rows, sends, messages } = makeHarness([pendingRow()], options);

  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 1);
  assert.equal(rows[0].status, "SENT");
  assert.equal(messages.length, 1);

  messages[0].text = "Edited after send";
  messages[0].rawJson = JSON.stringify({ reactions: [{ emoji: "heart" }] });
  delete options.threadPersistError;
  let repairedThread;
  options.onThreadUpdate = (data) => {
    repairedThread = data;
  };

  assert.equal(await svc.reconcileSentProjections(), 1);
  assert.equal(messages[0].text, "Edited after send");
  assert.deepEqual(JSON.parse(messages[0].rawJson), {
    reactions: [{ emoji: "heart" }]
  });
  assert.equal(repairedThread.lastMessageText, "Edited after send");
  assert.equal(rows[0].errorJson, null);
});

test("send keeps the platform lease through durable local projection", async () => {
  const mutex = createKeyedMutex();
  const order = [];
  let scanProjection;
  const h = makeHarness([pendingRow()], {
    withPlatformLock: (platform, work) =>
      mutex.runExclusive(`platform:${platform}`, work),
    onSend: async () => {
      scanProjection = mutex.runExclusive("platform:LINKEDIN", async () => {
        order.push("newer-inbound-scan");
      });
    },
    onThreadUpdate: () => order.push("send-projection")
  });

  await h.svc.processSendRequest("sr1");
  await scanProjection;

  assert.deepEqual(order, ["send-projection", "newer-inbound-scan"]);
});

test("an adapter failure after dispatch begins is delivery-uncertain and cannot retry", async () => {
  const { svc, rows, sends } = makeHarness([pendingRow()], {
    adapterError: "navigation timeout after the first attachment was acknowledged"
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 1);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).errorKind, "DELIVERY_UNCERTAIN");
  assert.deepEqual(
    persistedSendRetryEligibility(rows[0].status, rows[0].errorJson),
    { allowed: false, reason: "delivery_uncertain" }
  );
});

test("a failed delivery-uncertain write leaves the durable claim in doubt", async () => {
  const { svc, rows, sends } = makeHarness([pendingRow()], {
    adapterError: "navigation timeout after submit",
    failFailedTerminalWrite: true
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 1);
  assert.equal(rows[0].status, "PENDING");
  assert.equal(isClaimMarker(rows[0].receiptJson), true);
});

test("a failed observer cannot erase delivery-uncertain retry protection", async () => {
  const { svc, rows } = makeHarness([pendingRow()], {
    adapterError: "navigation timeout after submit",
    failFailureEvent: true
  });

  await svc.processSendRequest("sr1");

  assert.equal(rows[0].status, "FAILED");
  assert.equal(JSON.parse(rows[0].errorJson).errorKind, "DELIVERY_UNCERTAIN");
  assert.deepEqual(
    persistedSendRetryEligibility(rows[0].status, rows[0].errorJson),
    { allowed: false, reason: "delivery_uncertain" }
  );
});

test("re-dispatch of an already-SENT row does NOT re-send (resume after a completed send)", async () => {
  const { svc, rows, sends } = makeHarness([pendingRow()]);
  await svc.processSendRequest("sr1");
  assert.equal(rows[0].status, "SENT");
  // Simulate resume()/a re-kick re-reading the same row id.
  await svc.processSendRequest("sr1");
  assert.equal(sends.length, 1, "must not re-send an already-terminal row");
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

test("a reset that owns the external-action fence deletes before an unclaimed worker", async () => {
  const mutex = createKeyedMutex();
  let releaseReset;
  let markResetReady;
  const resetReady = new Promise((resolve) => {
    markResetReady = resolve;
  });
  const reset = mutex.runExclusive("LINKEDIN:SEND", async () => {
    markResetReady();
    await new Promise((resolve) => {
      releaseReset = resolve;
    });
  });
  await resetReady;

  const h = makeHarness([pendingRow()], {
    withExternalActionLock: (_platform, work) =>
      mutex.runExclusive("LINKEDIN:SEND", work)
  });
  const worker = h.svc.processSendRequest("sr1");
  await new Promise((resolve) => setImmediate(resolve));
  const claimsBeforeResetDelete = h.claimAttempts();

  h.deleteGraph();
  releaseReset();
  await reset;
  await worker;

  assert.equal(claimsBeforeResetDelete, 0);
  assert.equal(h.sends.length, 0);
});

test("an active send persists terminal state before admin reset deletes its graph", async () => {
  const mutex = createKeyedMutex();
  let releaseAdapter;
  let markAdapterStarted;
  const adapterStarted = new Promise((resolve) => {
    markAdapterStarted = resolve;
  });
  let h;
  h = makeHarness([pendingRow()], {
    withExternalActionLock: (platform, work) =>
      mutex.runExclusive(`external:${platform}`, work),
    withPlatformLock: (platform, work) =>
      mutex.runExclusive(`platform:${platform}`, work),
    onSend: async () => {
      markAdapterStarted();
      await new Promise((resolve) => {
        releaseAdapter = resolve;
      });
    }
  });
  const coordinator = createAdminResetCoordinator({
    platforms: ["LINKEDIN"],
    requestAbort: () => undefined,
    clearAbort: () => undefined,
    clearInFlight: () => undefined,
    withGlobalResetLock: (work) => mutex.runExclusive("global", work),
    withExternalActionLock: (platform, work) =>
      mutex.runExclusive(`external:${platform}`, work),
    withPlatformLock: (platform, work) =>
      mutex.runExclusive(`platform:${platform}`, work),
    resetGraph: async (platform) => {
      h.deleteGraph();
      return {
        platform,
        matchedThreadCount: 1,
        deleted: {
          sendRequests: 1,
          drafts: 0,
          messages: 1,
          threads: 1,
          orphanPeople: 1
        }
      };
    },
    auditLog: async () => undefined
  });

  const worker = h.svc.processSendRequest("sr1");
  await adapterStarted;
  const reset = coordinator.reset({ platform: "LINKEDIN", requestId: "reset-active" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.includes("graph-deleted"), false);

  releaseAdapter();
  await worker;
  await reset;

  assert.equal(h.sends.length, 1);
  assert.ok(
    h.events.indexOf("send-terminal-persisted") < h.events.indexOf("graph-deleted")
  );
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
