import assert from "node:assert/strict";
import test from "node:test";
import { createSendService } from "../apps/runner/dist/services/send.js";

function row(overrides = {}) {
  return {
    id: "request-1",
    clientSendId: "11111111-1111-4111-8111-111111111111",
    threadId: "thread-1",
    status: "PENDING",
    requestText: "hello",
    requestKind: "MESSAGE",
    requestPayloadJson: null,
    retryOfClientSendId: null,
    scheduledFor: null,
    receiptJson: null,
    errorJson: null,
    attachmentsJson: null,
    replyToMessageId: null,
    createdAt: new Date("2026-08-21T10:00:00.000Z"),
    updatedAt: new Date("2026-08-21T10:00:00.000Z"),
    ...overrides
  };
}

function matches(rowValue, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "receiptJson" && expected === null) return rowValue[key] == null;
    return rowValue[key] === expected;
  });
}

function harness(initialRows = [], options = {}) {
  const rows = initialRows.map((entry) => ({ ...entry }));
  const sends = [];
  const polls = [];
  const messages = [];
  const events = [];
  let nextId = rows.length + 1;
  let injectedRace = false;
  let platformLockHeld = false;
  let terminalizedWhileLocked = false;

  const prisma = {
    sendRequest: {
      async findUnique({ where }) {
        const found = rows.find((entry) =>
          where.id ? entry.id === where.id : entry.clientSendId === where.clientSendId
        );
        return found ? { ...found } : null;
      },
      async create({ data }) {
        if (options.raceWinner && !injectedRace) {
          injectedRace = true;
          rows.push(row({ id: `request-${nextId++}`, ...options.raceWinner }));
          throw { code: "P2002" };
        }
        if (
          rows.some(
            (entry) =>
              entry.clientSendId === data.clientSendId ||
              (data.retryOfClientSendId && entry.retryOfClientSendId === data.retryOfClientSendId)
          )
        ) {
          throw { code: "P2002" };
        }
        const created = row({ id: `request-${nextId++}`, ...data });
        rows.push(created);
        return { ...created };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const entry of rows) {
          if (matches(entry, where)) {
            Object.assign(entry, data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
      async update({ where, data }) {
        const found = rows.find((entry) =>
          where.id ? entry.id === where.id : entry.clientSendId === where.clientSendId
        );
        if (!found) throw new Error("request not found");
        if (data.status === "SENT" && platformLockHeld) terminalizedWhileLocked = true;
        Object.assign(found, data, { updatedAt: new Date() });
        return { ...found };
      }
    },
    thread: {
      async findUnique({ where }) {
        if (where.id !== "thread-1") return null;
        return {
          id: "thread-1",
          platform: "WHATSAPP",
          platformThreadId: "447700900000@c.us",
          threadUrl: null,
          lastMessageAt: null,
          lastInboundAt: null,
          person: { displayName: "Ada" }
        };
      },
      async update() {
        if (options.failThreadProjection) throw new Error("thread projection unavailable");
        return {};
      }
    },
    message: {
      async upsert({ create }) {
        if (options.failMessageProjection) throw new Error("message projection unavailable");
        messages.push(create);
        return { id: `message-${messages.length}`, ...create };
      }
    }
  };

  const adapter = {
    async sendMessage(_thread, text, attachments) {
      sends.push({ text, attachments });
      return {
        sentAt: "2026-08-21T10:01:00.000Z",
        platformMessageKey: "platform-message-1",
        verifiedBy: "platform_acknowledged"
      };
    },
    async sendPoll(_thread, poll) {
      polls.push(poll);
      return {
        sentAt: "2026-08-21T10:02:00.000Z",
        platformMessageKey: "platform-poll-1",
        verifiedBy: "platform_acknowledged",
        raw: { poll }
      };
    }
  };
  const service = createSendService({
    adapters: { WHATSAPP: adapter },
    eventBus: {
      emit(event) {
        events.push(event);
        return event;
      },
      subscribe: () => () => {},
      nextEventId: () => 1,
      listSince: () => [],
      newestEventId: () => 0,
      oldestEventId: () => 0
    },
    settingsStore: {
      getSettings: async () => ({ presenterDemoMode: "off", amberHours: 24, redHours: 72 }),
      getDemoSeedManifest: async () => null
    },
    auditLog: async () => "audit-1",
    async withPlatformLock(_platform, work) {
      platformLockHeld = true;
      try {
        return await work();
      } finally {
        platformLockHeld = false;
      }
    },
    prisma
  });
  return {
    service,
    rows,
    sends,
    polls,
    messages,
    events,
    terminalizedWhileLocked: () => terminalizedWhileLocked
  };
}

test("a proven delivery stays SENT when the local Message projection fails", async () => {
  const attachmentsJson = JSON.stringify([
    { absolutePath: "/staged/private.jpg", displayName: "private.jpg", kind: "photo" }
  ]);
  const h = harness([row({ attachmentsJson })], { failMessageProjection: true });
  await h.service.processSendRequest("request-1");

  assert.equal(h.sends.length, 1);
  assert.equal(h.rows[0].status, "SENT");
  assert.equal(h.terminalizedWhileLocked(), true);
  assert.equal(JSON.parse(h.rows[0].receiptJson).platformMessageKey, "platform-message-1");
  assert.equal(h.rows[0].attachmentsJson, attachmentsJson, "staged retry evidence remains referenced");
  assert.equal(h.events.filter((event) => event.type === "MESSAGE_SEND_FAILED").length, 0);

  await h.service.processSendRequest("request-1");
  assert.equal(h.sends.length, 1, "terminal replay cannot dispatch the adapter again");
});

test("a P2002 enqueue race rereads and reports the winner's terminal truth", async () => {
  const clientSendId = "22222222-2222-4222-8222-222222222222";
  const receiptJson = JSON.stringify({
    sentAt: "2026-08-21T10:00:00.000Z",
    verifiedBy: "platform_acknowledged"
  });
  const h = harness([], {
    raceWinner: {
      clientSendId,
      threadId: "thread-1",
      requestText: "same payload",
      status: "SENT",
      receiptJson
    }
  });
  const result = await h.service.enqueueSend({
    threadId: "thread-1",
    text: "same payload",
    clientSendId
  });
  assert.equal(result.status, "SENT");
  assert.equal(result.replayed, true);
  assert.equal(result.result.sentAt, "2026-08-21T10:00:00.000Z");
});

test("a P2002 enqueue race never treats a different canonical payload as replay", async () => {
  const clientSendId = "33333333-3333-4333-8333-333333333333";
  const h = harness([], {
    raceWinner: {
      clientSendId,
      threadId: "thread-1",
      requestText: "different payload"
    }
  });
  await assert.rejects(
    () =>
      h.service.enqueueSend({
        threadId: "thread-1",
        text: "expected payload",
        clientSendId
      }),
    /payload does not match persisted request.*text/
  );
});

test("concurrent retry clicks reserve one deterministic recovery attempt and one external send", async () => {
  const original = row({
    status: "FAILED",
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" }),
    attachmentsJson: JSON.stringify([
      { absolutePath: "/staged/voice.m4a", displayName: "voice.m4a", kind: "voice_note" }
    ]),
    replyToMessageId: "parent-message"
  });
  const h = harness([original]);
  const [left, right] = await Promise.all([
    h.service.reserveRetry({ threadId: "thread-1", clientSendId: original.clientSendId }),
    h.service.reserveRetry({ threadId: "thread-1", clientSendId: original.clientSendId })
  ]);
  assert.equal(left.accepted, true);
  assert.equal(right.accepted, true);
  assert.equal(left.result.clientSendId, right.result.clientSendId);
  assert.equal(h.rows.length, 2);
  const recovery = h.rows.find((entry) => entry.retryOfClientSendId === original.clientSendId);
  assert.ok(recovery);
  assert.equal(recovery.attachmentsJson, original.attachmentsJson);
  assert.equal(recovery.replyToMessageId, "parent-message");

  await Promise.all([
    h.service.processSendRequest(recovery.id),
    h.service.processSendRequest(recovery.id)
  ]);
  assert.equal(h.sends.length, 1);
  assert.equal(recovery.status, "SENT");
});

test("retry refuses non-failed, delivery-uncertain, and recovery-attempt requests", async () => {
  const cases = [
    [row({ status: "SENT" }), "not_failed:SENT"],
    [row({ status: "PENDING" }), "not_failed:PENDING"],
    [
      row({
        status: "FAILED",
        errorJson: JSON.stringify({ errorKind: "DELIVERY_UNCERTAIN", message: "unknown" })
      }),
      "retry_not_safe"
    ],
    [
      row({
        status: "FAILED",
        retryOfClientSendId: "original",
        errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" })
      }),
      "recovery_attempt_not_retryable"
    ]
  ];
  for (const [candidate, reason] of cases) {
    const h = harness([candidate]);
    assert.deepEqual(
      await h.service.reserveRetry({
        threadId: candidate.threadId,
        clientSendId: candidate.clientSendId
      }),
      { accepted: false, reason }
    );
  }
});

test("poll is durable before dispatch and replays its persisted receipt after restart", async () => {
  const h = harness();
  const input = {
    threadId: "thread-1",
    text: "Lunch?\n1. Cafe\n2. Park",
    clientSendId: "44444444-4444-4444-8444-444444444444",
    poll: {
      question: "Lunch?",
      options: ["Cafe", "Park"],
      allowMultipleAnswers: false
    }
  };
  const queued = await h.service.enqueuePoll(input);
  assert.equal(queued.status, "PENDING");
  assert.equal(h.polls.length, 0, "the durable row exists before the adapter side effect");
  const persisted = h.rows[0];
  assert.equal(persisted.requestKind, "POLL");
  assert.deepEqual(JSON.parse(persisted.requestPayloadJson), input.poll);

  await h.service.processSendRequest(persisted.id);
  assert.equal(h.polls.length, 1);
  assert.equal(persisted.status, "SENT");
  assert.equal(JSON.parse(persisted.receiptJson).platformMessageKey, "platform-poll-1");

  const replay = await h.service.enqueuePoll(input);
  assert.equal(replay.status, "SENT");
  assert.equal(replay.replayed, true);
  await h.service.processSendRequest(persisted.id);
  assert.equal(h.polls.length, 1, "restart/replay cannot create a second platform poll");
});
