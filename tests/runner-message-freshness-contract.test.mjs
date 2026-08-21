import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../apps/runner/src/services/scan-queue.ts", import.meta.url),
  "utf8"
);
const syncThread = source.slice(
  source.indexOf("async function syncThread("),
  source.indexOf("  return {\n    enqueueScan", source.indexOf("async function syncThread("))
);

const { persistThreadFreshnessBeforeMessageEvent } = await import(
  "../apps/runner/dist/services/scan-queue.js"
);

test("message persistence is detected by pre-scan keys and verified after writes", () => {
  assert.match(syncThread, /existingScannedMessageKeys/);
  assert.match(syncThread, /candidateNewMessageKeys/);
  assert.match(syncThread, /const newlyPersistedMessageCount = candidateNewMessageKeys\.length/);
});

test("MESSAGES_PERSISTED is emitted for new rows before optional AI work", () => {
  const emitIndex = syncThread.indexOf('type: "MESSAGES_PERSISTED"');
  const summaryIndex = syncThread.indexOf("deps.aiService.updateThreadSummary");
  const classifierIndex = syncThread.indexOf(".classifyThreadCategory");
  assert.ok(emitIndex > 0, "persistence event is present");
  assert.ok(emitIndex < summaryIndex, "event precedes summary generation");
  assert.ok(emitIndex < classifierIndex, "event precedes category classification");
  assert.match(
    syncThread.slice(Math.max(0, emitIndex - 500), emitIndex),
    /newlyPersistedMessageCount > 0/
  );
});

test("the Inbox and Today projection is durable when MESSAGES_PERSISTED fires, while AI is blocked", async () => {
  const threadId = "thread-freshness";
  const storedThread = {
    id: threadId,
    unreadCount: 0,
    needsReply: false,
    lastMessagePreview: "Old message",
    lastMessageDirection: "OUT",
    lastMessageText: "Old message",
    lastMessageAt: new Date("2026-08-20T09:00:00.000Z"),
    lastInboundAt: null,
    lastOutboundAt: new Date("2026-08-20T09:00:00.000Z"),
    riskLevel: "GREEN"
  };
  const inboundAt = new Date("2026-08-21T10:15:00.000Z");
  const projection = {
    threadUrl: "https://example.test/thread-freshness",
    unreadCount: 1,
    isGroup: false,
    groupName: null,
    lastMessagePreview: "Can you send the notes?",
    lastMessageDirection: "IN",
    lastMessageText: "Can you send the notes?",
    lastMessageAt: inboundAt,
    lastInboundAt: inboundAt,
    lastOutboundAt: storedThread.lastOutboundAt,
    riskLevel: "AMBER",
    slaDueAt: new Date("2026-08-22T10:15:00.000Z"),
    riskReason: "Reply due",
    needsReply: true,
    firstFullBackfillAt: inboundAt
  };
  const fakePrisma = {
    thread: {
      async update({ where, data }) {
        assert.equal(where.id, threadId);
        Object.assign(storedThread, data);
        return storedThread;
      }
    }
  };

  let projectionAtEvent;
  let signalEvent;
  const eventSeen = new Promise((resolve) => {
    signalEvent = resolve;
  });
  const eventBus = {
    emit(event) {
      projectionAtEvent = { ...storedThread };
      signalEvent(event);
      return event;
    }
  };
  let releaseAi;
  const blockedAi = new Promise((resolve) => {
    releaseAi = resolve;
  });
  let aiCompleted = false;

  const scanContinuation = (async () => {
    await persistThreadFreshnessBeforeMessageEvent({
      persistProjection: () =>
        fakePrisma.thread.update({ where: { id: threadId }, data: projection }),
      eventBus,
      event: {
        type: "MESSAGES_PERSISTED",
        jobId: "scan-1",
        threadId,
        platform: "IMESSAGE",
        syncTiming: {
          sourceChangedAt: "2026-08-21T10:14:59.000Z",
          persistedAt: "2026-08-21T10:15:00.000Z",
          trigger: "filesystem"
        }
      }
    });
    await blockedAi;
    aiCompleted = true;
  })();

  await eventSeen;
  assert.deepEqual(
    {
      unreadCount: projectionAtEvent.unreadCount,
      needsReply: projectionAtEvent.needsReply,
      lastMessagePreview: projectionAtEvent.lastMessagePreview,
      lastMessageDirection: projectionAtEvent.lastMessageDirection,
      lastMessageText: projectionAtEvent.lastMessageText,
      lastMessageAt: projectionAtEvent.lastMessageAt,
      lastInboundAt: projectionAtEvent.lastInboundAt,
      lastOutboundAt: projectionAtEvent.lastOutboundAt,
      riskLevel: projectionAtEvent.riskLevel
    },
    {
      unreadCount: 1,
      needsReply: true,
      lastMessagePreview: "Can you send the notes?",
      lastMessageDirection: "IN",
      lastMessageText: "Can you send the notes?",
      lastMessageAt: inboundAt,
      lastInboundAt: inboundAt,
      lastOutboundAt: storedThread.lastOutboundAt,
      riskLevel: "AMBER"
    }
  );
  assert.equal(aiCompleted, false, "freshness event must not wait for optional AI");

  releaseAi();
  await scanContinuation;
  assert.equal(aiCompleted, true);
});
