import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  createSendService,
  recoveryPredecessorIsDefinitelyUnsent
} from "../apps/runner/dist/services/send.js";

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
        const row = rows.find((candidate) =>
          where.clientSendId !== undefined
            ? candidate.clientSendId === where.clientSendId
            : candidate.recoveryPredecessorClientSendId ===
              where.recoveryPredecessorClientSendId
        );
        return row ? { ...row } : null;
      },
      async create({ data }) {
        createCalls += 1;
        if (createRaceWinner) {
          rows.push({ id: "winner", receiptJson: null, errorJson: null, ...createRaceWinner(data) });
          throw uniqueError();
        }
        if (
          data.recoveryPredecessorClientSendId &&
          rows.some(
            (candidate) =>
              candidate.recoveryPredecessorClientSendId ===
              data.recoveryPredecessorClientSendId
          )
        ) {
          throw uniqueError();
        }
        const row = {
          id: `row-${rows.length + 1}`,
          receiptJson: null,
          errorJson: null,
          draftConsumed: false,
          ...data
        };
        rows.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("missing send request");
        Object.assign(row, data);
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
    { replyToMessageId: "message-2" },
    { recoveryPredecessorClientSendId: "11111111-1111-4111-8111-111111111111" }
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

test("a recovered immediate send requires a definitely unsent predecessor", async () => {
  const predecessorId = "11111111-1111-4111-8111-111111111111";
  const predecessor = {
    id: "predecessor",
    clientSendId: predecessorId,
    threadId: "thread-1",
    requestText: "Original text",
    status: "SENT",
    source: "manual",
    scheduledFor: null,
    receiptJson: "{}",
    errorJson: null,
    attachmentsJson: null,
    replyToMessageId: null,
    recoveryPredecessorClientSendId: null,
    draftConsumed: false
  };
  const blocked = harness();
  blocked.rows.push(predecessor);
  await assert.rejects(
    () => blocked.service.enqueueSend(immediateInput({
      clientSendId: "22222222-2222-4222-8222-222222222222",
      recoveryPredecessorClientSendId: predecessorId
    })),
    /no longer definitely unsent/i
  );
  assert.equal(blocked.rows.length, 1);

  const allowed = harness();
  allowed.rows.push({
    ...predecessor,
    status: "FAILED",
    receiptJson: null,
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" })
  });
  const result = await allowed.service.enqueueSend(immediateInput({
    clientSendId: "33333333-3333-4333-8333-333333333333",
    recoveryPredecessorClientSendId: predecessorId
  }));
  assert.equal(result.status, "PENDING");
  assert.equal(allowed.rows[1].recoveryPredecessorClientSendId, predecessorId);
});

test("a policy-cancelled recovered successor cannot become a new retry predecessor", async () => {
  const blockedCancellation = JSON.stringify({
    errorKind: "POLICY_BLOCKED",
    message: "The earlier send is no longer definitely unsent",
    reasonCode: "recovery_predecessor_not_retryable"
  });
  assert.equal(
    recoveryPredecessorIsDefinitelyUnsent("CANCELLED", blockedCancellation),
    false
  );

  const h = harness();
  const cancelledId = "44444444-4444-4444-8444-444444444444";
  h.rows.push({
    id: "cancelled-successor",
    clientSendId: cancelledId,
    threadId: "thread-1",
    requestText: "Original text",
    status: "CANCELLED",
    source: "manual",
    scheduledFor: null,
    receiptJson: null,
    errorJson: blockedCancellation,
    attachmentsJson: null,
    replyToMessageId: null,
    recoveryPredecessorClientSendId: "33333333-3333-4333-8333-333333333333",
    draftConsumed: false
  });

  await assert.rejects(
    () => h.service.enqueueSend(immediateInput({
      clientSendId: "55555555-5555-4555-8555-555555555555",
      recoveryPredecessorClientSendId: cancelledId
    })),
    /no longer definitely unsent/i
  );
  assert.equal(h.rows.length, 1);
});

test("only one successor can claim a retry-safe predecessor", async () => {
  const h = harness();
  const predecessorId = "11111111-1111-4111-8111-111111111111";
  h.rows.push({
    id: "failed-predecessor",
    clientSendId: predecessorId,
    threadId: "thread-1",
    requestText: "Original text",
    status: "FAILED",
    source: "manual",
    scheduledFor: null,
    receiptJson: null,
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" }),
    attachmentsJson: null,
    replyToMessageId: null,
    recoveryPredecessorClientSendId: null,
    draftConsumed: false
  });

  const firstSuccessorId = "22222222-2222-4222-8222-222222222222";
  await h.service.enqueueSend(immediateInput({
    clientSendId: firstSuccessorId,
    recoveryPredecessorClientSendId: predecessorId
  }));
  await assert.rejects(
    () => h.service.enqueueSend(immediateInput({
      clientSendId: "33333333-3333-4333-8333-333333333333",
      recoveryPredecessorClientSendId: predecessorId
    })),
    (error) =>
      error?.reasonCode === "recovery_predecessor_already_claimed" &&
      error?.details?.winningClientSendId === firstSuccessorId &&
      error?.details?.winningStatus === "PENDING" &&
      /already claimed/i.test(error.message)
  );
  assert.equal(h.rows.length, 2);

  h.rows[1].status = "FAILED";
  h.rows[1].errorJson = JSON.stringify({
    errorKind: "TRANSIENT",
    message: "timeout"
  });
  const chained = await h.service.enqueueSend(immediateInput({
    clientSendId: "66666666-6666-4666-8666-666666666666",
    recoveryPredecessorClientSendId: firstSuccessorId
  }));
  assert.equal(chained.status, "PENDING");
  assert.equal(h.rows.length, 3);
});

test("recovered send lineage fails closed on missing, cross-thread, and cyclic ancestors", async () => {
  const successorId = "77777777-7777-4777-8777-777777777777";
  const missing = harness();
  await assert.rejects(
    () => missing.service.enqueueSend(immediateInput({
      clientSendId: successorId,
      recoveryPredecessorClientSendId:
        "88888888-8888-4888-8888-888888888888"
    })),
    /no longer definitely unsent/i
  );

  const crossThread = harness();
  crossThread.rows.push({
    id: "cross-thread",
    clientSendId: "88888888-8888-4888-8888-888888888888",
    threadId: "thread-2",
    status: "FAILED",
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" }),
    recoveryPredecessorClientSendId: null
  });
  await assert.rejects(
    () => crossThread.service.enqueueSend(immediateInput({
      clientSendId: successorId,
      recoveryPredecessorClientSendId:
        "88888888-8888-4888-8888-888888888888"
    })),
    /no longer definitely unsent/i
  );

  const cyclic = harness();
  cyclic.rows.push({
    id: "cyclic-predecessor",
    clientSendId: "88888888-8888-4888-8888-888888888888",
    threadId: "thread-1",
    status: "FAILED",
    errorJson: JSON.stringify({ errorKind: "TRANSIENT", message: "timeout" }),
    recoveryPredecessorClientSendId: successorId
  });
  await assert.rejects(
    () => cyclic.service.enqueueSend(immediateInput({
      clientSendId: successorId,
      recoveryPredecessorClientSendId:
        "88888888-8888-4888-8888-888888888888"
    })),
    /cyclic/i
  );
});

test("creating a send consumes only the exact saved draft revision in the same transaction", async () => {
  const h = harness();
  const expectedUpdatedAt = new Date("2026-08-30T09:00:00.000Z");
  h.drafts.push(
    { threadId: "thread-1", text: "Original text", updatedAt: expectedUpdatedAt },
    { threadId: "thread-2", text: "Keep me", updatedAt: expectedUpdatedAt }
  );

  const result = await h.service.enqueueSend(
    immediateInput({
      consumeDraft: { text: "Original text", updatedAt: expectedUpdatedAt }
    })
  );

  assert.deepEqual(h.drafts, [
    { threadId: "thread-2", text: "Keep me", updatedAt: expectedUpdatedAt }
  ]);
  assert.equal(h.rows.length, 1);
  assert.equal(result.draftConsumed, true);
  assert.equal(h.rows[0].draftConsumed, true);

  const replay = await h.service.enqueueSend(
    immediateInput({
      consumeDraft: { text: "Original text", updatedAt: expectedUpdatedAt }
    })
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.draftConsumed, true);
});

test("a newer saved draft survives an older send's guarded consume", async () => {
  const h = harness();
  const oldUpdatedAt = new Date("2026-08-30T09:00:00.000Z");
  const newUpdatedAt = new Date("2026-08-30T09:01:00.000Z");
  h.drafts.push({ threadId: "thread-1", text: "Newer draft", updatedAt: newUpdatedAt });

  const result = await h.service.enqueueSend(
    immediateInput({
      consumeDraft: { text: "Original text", updatedAt: oldUpdatedAt }
    })
  );

  assert.deepEqual(h.drafts, [
    { threadId: "thread-1", text: "Newer draft", updatedAt: newUpdatedAt }
  ]);
  assert.equal(result.draftConsumed, false);
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
  assert.match(
    indexSource,
    /const stagedAttachmentRequest = createStagedAttachmentRequestLifecycle\(req,[\s\S]*?const uploadedFiles =[\s\S]*?try \{[\s\S]*?\.parse\(req\.body\)/
  );
  assert.match(
    indexSource,
    /stagedAttachmentRequest\.markPersistenceAttempted\(payload\.clientSendId\)/
  );
  assert.match(
    indexSource,
    /stagedAttachmentRequest\.markHandled\(\)/
  );
  assert.match(
    indexSource,
    /finally \{\s*await stagedAttachmentRequest\.finalize\(\)/
  );
  assert.match(
    indexSource,
    /row\.status === "FAILED" \|\| row\.status === "CANCELLED"[\s\S]*?parsePersistedSendFailure\(row\.errorJson\)/
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

test("a recovered scheduled send is rejected after its predecessor becomes sent", async () => {
  const h = harness();
  const predecessorId = "44444444-4444-4444-8444-444444444444";
  h.rows.push({
    id: "scheduled-predecessor",
    clientSendId: predecessorId,
    threadId: "thread-1",
    requestText: "Scheduled text",
    status: "SENT",
    source: "manual",
    scheduledFor: null,
    receiptJson: "{}",
    errorJson: null,
    attachmentsJson: null,
    replyToMessageId: null,
    recoveryPredecessorClientSendId: null,
    draftConsumed: false
  });

  await assert.rejects(
    () => h.service.enqueueScheduledSend({
      threadId: "thread-1",
      text: "Scheduled text",
      clientSendId: "55555555-5555-4555-8555-555555555555",
      recoveryPredecessorClientSendId: predecessorId,
      scheduledFor: new Date(Date.now() + 3_600_000)
    }),
    /no longer definitely unsent/i
  );
  assert.equal(h.rows.length, 1);
});

test("creating a scheduled send atomically consumes only its captured draft revision", async () => {
  const h = harness();
  const updatedAt = new Date("2026-08-30T09:00:00.000Z");
  h.drafts.push({ threadId: "thread-1", text: "Scheduled text", updatedAt });

  const result = await h.service.enqueueScheduledSend({
    threadId: "thread-1",
    text: "Scheduled text",
    clientSendId: "7d7eed73-6437-42e3-9e51-769522640b2a",
    scheduledFor: new Date(Date.now() + 3_600_000),
    consumeDraft: { text: "Scheduled text", updatedAt }
  });

  assert.deepEqual(h.drafts, []);
  assert.equal(h.rows[0].status, "SCHEDULED");
  assert.equal(result.draftConsumed, true);
  assert.equal(h.rows[0].draftConsumed, true);

  const replay = await h.service.enqueueScheduledSend({
    threadId: "thread-1",
    text: "Scheduled text",
    clientSendId: "7d7eed73-6437-42e3-9e51-769522640b2a",
    scheduledFor: new Date(result.scheduledFor),
    consumeDraft: { text: "Scheduled text", updatedAt }
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.draftConsumed, true);
});

test("a scheduled send reports when a newer draft survived its guarded consume", async () => {
  const h = harness();
  const oldUpdatedAt = new Date("2026-08-30T09:00:00.000Z");
  const newUpdatedAt = new Date("2026-08-30T09:01:00.000Z");
  h.drafts.push({ threadId: "thread-1", text: "Newer draft", updatedAt: newUpdatedAt });

  const result = await h.service.enqueueScheduledSend({
    threadId: "thread-1",
    text: "Scheduled text",
    clientSendId: "c13eed73-6437-42e3-9e51-769522640b2a",
    scheduledFor: new Date(Date.now() + 3_600_000),
    consumeDraft: { text: "Scheduled text", updatedAt: oldUpdatedAt }
  });

  assert.deepEqual(h.drafts, [
    { threadId: "thread-1", text: "Newer draft", updatedAt: newUpdatedAt }
  ]);
  assert.equal(result.draftConsumed, false);
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
