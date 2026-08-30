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
  const drafts = [];
  let createCalls = 0;
  const prisma = {
    async $transaction(work) {
      return work(prisma);
    },
    draft: {
      async deleteMany({ where }) {
        const before = drafts.length;
        for (let index = drafts.length - 1; index >= 0; index -= 1) {
          const draft = drafts[index];
          if (
            draft.threadId === where.threadId &&
            draft.text === where.text &&
            draft.updatedAt.getTime() === where.updatedAt.getTime()
          ) {
            drafts.splice(index, 1);
          }
        }
        return { count: before - drafts.length };
      }
    },
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
  return { service, rows, drafts, createCalls: () => createCalls };
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

test("creating a send consumes only the exact saved draft revision in the same transaction", async () => {
  const h = harness();
  const expectedUpdatedAt = new Date("2026-08-30T09:00:00.000Z");
  h.drafts.push(
    { threadId: "thread-1", text: "Original text", updatedAt: expectedUpdatedAt },
    { threadId: "thread-2", text: "Keep me", updatedAt: expectedUpdatedAt }
  );

  await h.service.enqueueSend(
    immediateInput({
      consumeDraft: { text: "Original text", updatedAt: expectedUpdatedAt }
    })
  );

  assert.deepEqual(h.drafts, [
    { threadId: "thread-2", text: "Keep me", updatedAt: expectedUpdatedAt }
  ]);
  assert.equal(h.rows.length, 1);
});

test("a newer saved draft survives an older send's guarded consume", async () => {
  const h = harness();
  const oldUpdatedAt = new Date("2026-08-30T09:00:00.000Z");
  const newUpdatedAt = new Date("2026-08-30T09:01:00.000Z");
  h.drafts.push({ threadId: "thread-1", text: "Newer draft", updatedAt: newUpdatedAt });

  await h.service.enqueueSend(
    immediateInput({
      consumeDraft: { text: "Original text", updatedAt: oldUpdatedAt }
    })
  );

  assert.deepEqual(h.drafts, [
    { threadId: "thread-1", text: "Newer draft", updatedAt: newUpdatedAt }
  ]);
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

test("route cleanup discards newly uploaded files after an attachment replay", async () => {
  const { readFile } = await import("node:fs/promises");
  const indexSource = await readFile(
    new URL("../apps/runner/src/index.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    indexSource,
    /if \(queueResult\.replayed\) \{\s*await discardStagedAttachments\(stagedAttachments\);/s
  );
  assert.match(
    indexSource,
    /if \(scheduleResult\.replayed\) \{\s*await discardStagedAttachments\(stagedAttachments\);/s
  );
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

test("creating a scheduled send atomically consumes only its captured draft revision", async () => {
  const h = harness();
  const updatedAt = new Date("2026-08-30T09:00:00.000Z");
  h.drafts.push({ threadId: "thread-1", text: "Scheduled text", updatedAt });

  await h.service.enqueueScheduledSend({
    threadId: "thread-1",
    text: "Scheduled text",
    clientSendId: "7d7eed73-6437-42e3-9e51-769522640b2a",
    scheduledFor: new Date(Date.now() + 3_600_000),
    consumeDraft: { text: "Scheduled text", updatedAt }
  });

  assert.deepEqual(h.drafts, []);
  assert.equal(h.rows[0].status, "SCHEDULED");
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
