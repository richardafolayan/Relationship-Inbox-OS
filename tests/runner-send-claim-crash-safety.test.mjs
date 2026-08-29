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
  const sentStubs = [];
  const messages = []; // every Message upsert (one per actual persisted send)
  const events = [];
  let threadExists = true;
  let claimAttempts = 0;

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
          person: {
            id: opts.personId ?? "p1",
            displayName: "Test Person",
            birthday: null,
            favouritedAt: new Date("2026-01-01T00:00:00.000Z")
          }
        };
      },
      async update() {
        return {};
      }
    },
    message: {
      async upsert({ create }) {
        if (opts.messagePersistError) throw new Error(opts.messagePersistError);
        messages.push(create);
        return {};
      }
    }
  };

  const adapter = {
    async sendMessage(stub, text) {
      sentStubs.push(stub);
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
        amberHours: 24,
        redHours: 72
      }),
      getOperatorProfile:
        opts.getOperatorProfile ??
        (async () => ({
          focusWindow: {
            active: true,
            autoSendAcknowledgements: true,
            windowId: opts.windowId ?? "focus-1",
            startedAt: "2026-08-24T11:00:00.000Z",
            endsAt: "2099-08-24T13:00:00.000Z",
            ackedPersonIds: [opts.personId ?? "p1"],
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
        })),
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
  source: "manual",
  ...over
});

function focusAutoAckRow(over = {}) {
  return pendingRow({
    clientSendId: uuidv5("focus-1:p1", uuidv5.URL),
    source: "focus_auto_ack",
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
  const { svc, rows, sends } = makeHarness([pendingRow()], {
    messagePersistError: "local database projection failed"
  });

  await svc.processSendRequest("sr1");

  assert.equal(sends.length, 1);
  assert.equal(rows[0].status, "SENT");
  assert.deepEqual(
    persistedSendRetryEligibility(rows[0].status, rows[0].errorJson),
    { allowed: false, reason: "not_failed" }
  );
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
