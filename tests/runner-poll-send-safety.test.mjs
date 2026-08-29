import test from "node:test";
import assert from "node:assert/strict";
import {
  createPollSendService,
  POLL_SEND_SOURCE
} from "../apps/runner/dist/services/poll-send.js";
import { persistedSendRetryEligibility } from "../apps/runner/dist/services/send-failure.js";

function harness(overrides = {}) {
  const rows = [];
  const messages = [];
  const events = [];
  let physicalSends = 0;
  const prisma = {
    sendRequest: {
      async findUnique({ where }) {
        const row = rows.find((candidate) => candidate.clientSendId === where.clientSendId);
        return row ? { ...row } : null;
      },
      async findMany({ where }) {
        return rows
          .filter((row) =>
            row.status === where.status &&
            row.source === where.source &&
            (row.errorJson ?? "").includes(where.errorJson.contains)
          )
          .map((row) => ({ ...row }));
      },
      async create({ data }) {
        if (rows.some((row) => row.clientSendId === data.clientSendId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: `sr-${rows.length + 1}`, errorJson: null, ...data };
        rows.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = rows.find((candidate) => candidate.clientSendId === where.clientSendId);
        if (!row) throw new Error("send request missing");
        Object.assign(row, data);
        return { ...row };
      },
      async updateMany({ where, data }) {
        const row = rows.find((candidate) =>
          candidate.id === where.id &&
          candidate.status === where.status &&
          candidate.receiptJson === where.receiptJson
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }
    },
    message: {
      async upsert({ where, update, create }) {
        if (overrides.messagePersistError) {
          throw new Error(overrides.messagePersistError);
        }
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
        const message = { id: `m-${messages.length + 1}`, ...create };
        messages.push(message);
        return message;
      }
    },
    thread: {
      async findUnique({ where }) {
        if (where.id !== "thread-1") return null;
        return {
          id: "thread-1",
          platform: "WHATSAPP",
          lastInboundAt: new Date("2026-08-24T12:00:00.000Z"),
          lastOutboundAt: null,
          lastMessageAt: null
        };
      },
      async update() {
        if ((overrides.failThreadUpdates ?? 0) > 0) {
          overrides.failThreadUpdates -= 1;
          throw new Error("thread projection failed");
        }
        return {};
      }
    }
  };
  const service = createPollSendService({
    prisma,
    settingsStore: {
      getSettings: async () => ({ amberHours: 24, redHours: 72 })
    },
    auditLog: async (input) => {
      if (overrides.failSuccessAudit && input.action === "POLL_SEND") {
        throw new Error("audit unavailable");
      }
      return "audit-id";
    },
    eventBus: { emit: (event) => events.push(event) },
    withExternalActionLock: async (_platform, work) => work(),
    withPlatformLock: async (_platform, work) => work()
  });

  const input = {
    clientSendId: "4b5b34cb-d782-47c1-b10a-14aae91950d9",
    thread: {
      id: "thread-1",
      platform: "WHATSAPP",
      lastInboundAt: new Date("2026-08-24T12:00:00.000Z")
    },
    threadStub: {
      platformThreadId: "447111222333@c.us",
      displayName: "Alice",
      lastMessagePreview: ""
    },
    question: "Dinner?",
    options: ["Yes", "No"],
    allowMultipleAnswers: false,
    dispatch: async () => {
      physicalSends += 1;
      if (overrides.adapterError) throw overrides.adapterError;
      return {
        sentAt: "2026-08-24T12:01:00.000Z",
        ...(overrides.omitPlatformMessageKey ? {} : { platformMessageKey: "poll-1" }),
        verifiedBy: "platform_acknowledged"
      };
    }
  };
  if (overrides.isPreDispatchFailure) {
    input.isPreDispatchFailure = overrides.isPreDispatchFailure;
  }

  return {
    service,
    input,
    rows,
    messages,
    events,
    physicalSends: () => physicalSends
  };
}

test("replaying a completed poll client id never sends a second poll", async () => {
  const h = harness();

  const first = await h.service.send(h.input);
  const replay = await h.service.send(h.input);

  assert.equal(first.status, "ok");
  assert.equal(replay.status, "ok");
  assert.equal(replay.replayed, true);
  assert.equal(h.physicalSends(), 1);
  assert.equal(h.rows[0].source, POLL_SEND_SOURCE);
  assert.equal(h.rows[0].status, "SENT");
});

test("a poll remains SENT when local projection or success audit fails", async () => {
  for (const overrides of [
    { messagePersistError: "projection failed" },
    { failSuccessAudit: true }
  ]) {
    const h = harness(overrides);

    const result = await h.service.send(h.input);

    assert.equal(result.status, "ok");
    assert.equal(h.physicalSends(), 1);
    assert.equal(h.rows[0].status, "SENT");
    if (overrides.messagePersistError) {
      assert.equal(JSON.parse(h.rows[0].errorJson).reconciliationRequired, true);
    }
    assert.deepEqual(
      persistedSendRetryEligibility(h.rows[0].status, h.rows[0].errorJson),
      { allowed: false, reason: "not_failed" }
    );
  }
});

test("replaying a completed poll repairs local projection without redispatch", async () => {
  const overrides = { messagePersistError: "projection failed" };
  const h = harness(overrides);

  const first = await h.service.send(h.input);
  assert.equal(first.status, "ok");
  assert.equal(h.messages.length, 0);
  assert.equal(JSON.parse(h.rows[0].errorJson).reconciliationRequired, true);

  delete overrides.messagePersistError;
  const replay = await h.service.send(h.input);
  assert.equal(replay.status, "ok");
  assert.equal(replay.replayed, true);
  assert.equal(h.physicalSends(), 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.rows[0].errorJson, null);
});

test("startup poll repair reuses the poll identity and never creates a duplicate bubble", async () => {
  const overrides = { omitPlatformMessageKey: true, failThreadUpdates: 1 };
  const h = harness(overrides);

  const first = await h.service.send(h.input);
  assert.equal(first.status, "ok");
  assert.equal(first.reconciliationPending, true);
  assert.equal(h.messages.length, 1);
  const originalKey = h.messages[0].platformMessageKey;

  assert.equal(await h.service.reconcileSentProjections(), 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].platformMessageKey, originalKey);
  assert.equal(h.rows[0].errorJson, null);
  assert.equal(h.physicalSends(), 1);
});

test("a poll adapter failure after dispatch begins is never retryable", async () => {
  const h = harness({ adapterError: new Error("navigation timeout after submit") });

  await assert.rejects(() => h.service.send(h.input), /check the conversation/i);

  assert.equal(h.physicalSends(), 1);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).errorKind, "DELIVERY_UNCERTAIN");
  assert.deepEqual(
    persistedSendRetryEligibility(h.rows[0].status, h.rows[0].errorJson),
    { allowed: false, reason: "delivery_uncertain" }
  );
});

test("a proven pre-dispatch poll failure releases its claim for the same-id retry", async () => {
  const safeFailure = new Error("adapter not connected");
  const overrides = {
    adapterError: safeFailure,
    isPreDispatchFailure: (error) => error === safeFailure
  };
  const h = harness(overrides);

  await assert.rejects(() => h.service.send(h.input), /not sent/i);
  assert.equal(h.rows[0].status, "PENDING");
  assert.equal(h.rows[0].receiptJson, null);

  delete overrides.adapterError;
  const retried = await h.service.send(h.input);
  assert.equal(retried.status, "ok");
  assert.equal(retried.replayed, false);
  assert.equal(h.physicalSends(), 2);
  assert.equal(h.rows[0].status, "SENT");
});

test("an in-doubt claimed poll is replayed as pending without dispatch", async () => {
  const h = harness();
  h.rows.push({
    id: "sr-existing",
    clientSendId: h.input.clientSendId,
    threadId: h.input.thread.id,
    status: "PENDING",
    requestText: "📊 Poll: Dinner?\n• Yes\n• No",
    source: POLL_SEND_SOURCE,
    attachmentsJson: JSON.stringify({
      kind: "poll",
      question: "Dinner?",
      options: ["Yes", "No"],
      allowMultipleAnswers: false
    }),
    receiptJson: "__SEND_CLAIMED__",
    errorJson: null
  });

  const result = await h.service.send(h.input);

  assert.equal(result.status, "pending");
  assert.equal(result.replayed, true);
  assert.equal(h.physicalSends(), 0);
});

test("a reused poll client id with different payload fails closed", async () => {
  const h = harness();
  await h.service.send(h.input);

  await assert.rejects(
    () => h.service.send({ ...h.input, options: ["Maybe", "No"] }),
    /different external action/i
  );
  assert.equal(h.physicalSends(), 1);
});
