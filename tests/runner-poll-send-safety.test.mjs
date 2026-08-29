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
      }
    },
    message: {
      async upsert({ create }) {
        if (overrides.messagePersistError) {
          throw new Error(overrides.messagePersistError);
        }
        const message = { id: `m-${messages.length + 1}`, ...create };
        messages.push(message);
        return message;
      }
    },
    thread: {
      async update() {
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
    eventBus: { emit: (event) => events.push(event) }
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
      if (overrides.adapterError) throw new Error(overrides.adapterError);
      return {
        sentAt: "2026-08-24T12:01:00.000Z",
        platformMessageKey: "poll-1",
        verifiedBy: "platform_acknowledged"
      };
    }
  };

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

test("a poll adapter failure after dispatch begins is never retryable", async () => {
  const h = harness({ adapterError: "navigation timeout after submit" });

  await assert.rejects(() => h.service.send(h.input), /check the conversation/i);

  assert.equal(h.physicalSends(), 1);
  assert.equal(h.rows[0].status, "FAILED");
  assert.equal(JSON.parse(h.rows[0].errorJson).errorKind, "DELIVERY_UNCERTAIN");
  assert.deepEqual(
    persistedSendRetryEligibility(h.rows[0].status, h.rows[0].errorJson),
    { allowed: false, reason: "delivery_uncertain" }
  );
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
