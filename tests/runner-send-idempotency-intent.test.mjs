import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { createSendService } from "../apps/runner/dist/services/send.js";

const noopEventBus = { emit: () => {}, nextEventId: () => 1, subscribe: () => () => {} };

function uniqueError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate client send id", {
    code: "P2002",
    clientVersion: "test"
  });
}

function harness({ createRaceWinner } = {}) {
  const rows = [];
  let createCalls = 0;
  const prisma = {
    thread: {
      async findUnique({ where }) {
        return { id: where.id, platform: "LINKEDIN" };
      }
    },
    sendRequest: {
      async findUnique({ where }) {
        const row = rows.find((candidate) => candidate.clientSendId === where.clientSendId);
        return row ? { ...row } : null;
      },
      async create({ data }) {
        createCalls += 1;
        if (createRaceWinner) {
          rows.push({ id: "winner", receiptJson: null, errorJson: null, ...createRaceWinner(data) });
          throw uniqueError();
        }
        const row = { id: `row-${rows.length + 1}`, receiptJson: null, errorJson: null, ...data };
        rows.push(row);
        return { ...row };
      }
    }
  };
  const service = createSendService({
    adapters: {},
    eventBus: noopEventBus,
    settingsStore: {},
    auditLog: async () => "audit-id",
    withExternalActionLock: async (_platform, work) => work(),
    withPlatformLock: async (_platform, work) => work(),
    prisma
  });
  return { service, rows, createCalls: () => createCalls };
}

const immediateInput = (overrides = {}) => ({
  threadId: "thread-1",
  text: "Original text",
  clientSendId: "44c44306-517c-484b-9076-9915fa21163e",
  source: "manual",
  attachments: [
    { absolutePath: "/tmp/photo.jpg", displayName: "photo.jpg", mimeType: "image/jpeg", kind: "photo" }
  ],
  replyToMessageId: "message-1",
  ...overrides
});

test("immediate clientSendId replay is bound to the complete immutable intent", async () => {
  const dimensions = [
    { text: "Changed text" },
    { source: "focus_ack" },
    { attachments: [{ absolutePath: "/tmp/other.jpg", displayName: "other.jpg" }] },
    { replyToMessageId: "message-2" }
  ];

  for (const changed of dimensions) {
    const h = harness();
    await h.service.enqueueSend(immediateInput());
    await assert.rejects(
      () => h.service.enqueueSend(immediateInput(changed)),
      /different send intent/i
    );
    assert.equal(h.rows.length, 1);
  }
});

test("identical attachment content replays across different staging paths", async () => {
  const h = harness();
  const first = immediateInput({
    attachments: [{
      absolutePath: "/tmp/upload-a/photo.jpg",
      displayName: "photo.jpg",
      mimeType: "image/jpeg",
      kind: "photo",
      contentDigest: "sha256-same-content"
    }]
  });
  const replay = immediateInput({
    attachments: [{
      absolutePath: "/tmp/upload-b/photo.jpg",
      displayName: "photo.jpg",
      mimeType: "image/jpeg",
      kind: "photo",
      contentDigest: "sha256-same-content"
    }]
  });

  assert.equal((await h.service.enqueueSend(first)).replayed, false);
  assert.equal((await h.service.enqueueSend(replay)).replayed, true);
  assert.equal(h.rows.length, 1);
});

test("attachment replay rejects different content at the same display name", async () => {
  const h = harness();
  await h.service.enqueueSend(immediateInput({
    attachments: [{
      absolutePath: "/tmp/upload-a/photo.jpg",
      displayName: "photo.jpg",
      contentDigest: "sha256-first"
    }]
  }));

  await assert.rejects(
    () => h.service.enqueueSend(immediateInput({
      attachments: [{
        absolutePath: "/tmp/upload-b/photo.jpg",
        displayName: "photo.jpg",
        contentDigest: "sha256-second"
      }]
    })),
    /different send intent/i
  );
});

test("a concurrent immediate-send uniqueness loser rereads and rejects the winner's different intent", async () => {
  const h = harness({
    createRaceWinner: (loser) => ({
      ...loser,
      requestText: "Winner text",
      status: "PENDING"
    })
  });

  await assert.rejects(
    () => h.service.enqueueSend(immediateInput({ text: "Loser text" })),
    /different send intent/i
  );
  assert.equal(h.createCalls(), 1);
  assert.equal(h.rows.length, 1);
});

test("scheduled clientSendId replay is bound to text, time, attachments, and reply parent", async () => {
  const scheduledFor = new Date(Date.now() + 3_600_000);
  const base = {
    threadId: "thread-1",
    text: "Scheduled text",
    clientSendId: "77b77643-2b7b-4d77-aa60-59823701a7cf",
    scheduledFor,
    attachments: [{ absolutePath: "/tmp/file.pdf", displayName: "file.pdf", kind: "pdf" }],
    replyToMessageId: "message-1"
  };
  const dimensions = [
    { text: "Changed text" },
    { scheduledFor: new Date(scheduledFor.getTime() + 60_000) },
    { attachments: [{ absolutePath: "/tmp/other.pdf", displayName: "other.pdf", kind: "pdf" }] },
    { replyToMessageId: "message-2" }
  ];

  for (const changed of dimensions) {
    const h = harness();
    await h.service.enqueueScheduledSend(base);
    await assert.rejects(
      () => h.service.enqueueScheduledSend({ ...base, ...changed }),
      /different send intent/i
    );
    assert.equal(h.rows.length, 1);
  }
});

test("a concurrent scheduled-send uniqueness loser returns the authoritative timestamp only for identical intent", async () => {
  const scheduledFor = new Date(Date.now() + 3_600_000);
  const h = harness({
    createRaceWinner: (loser) => ({
      ...loser,
      requestText: "Winner text",
      status: "SCHEDULED",
      scheduledFor: new Date(scheduledFor.getTime() + 60_000)
    })
  });

  await assert.rejects(
    () =>
      h.service.enqueueScheduledSend({
        threadId: "thread-1",
        text: "Loser text",
        clientSendId: "80dafc4d-06c7-4d21-8545-a9885ca99065",
        scheduledFor
      }),
    /different send intent/i
  );
  assert.equal(h.rows.length, 1);
});
