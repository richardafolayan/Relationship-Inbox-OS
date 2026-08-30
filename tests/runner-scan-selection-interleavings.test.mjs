import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const tempDir = mkdtempSync(join(tmpdir(), "tovi-scan-selection-"));
process.env.DATABASE_URL = `file:${join(tempDir, "scan.sqlite")}`;

const platformRows = new Map();
let transactionHook = () => {};
let persistedMessage = null;
const baseThread = {
  id: "thread-1",
  platform: "LINKEDIN",
  platformThreadId: "platform-thread-1",
  personId: "person-1",
  threadUrl: null,
  recipientVerificationLabel: null,
  unreadCount: 1,
  isGroup: false,
  groupName: null,
  handledAt: null,
  snoozedUntil: null,
  lastMessageDirection: null,
  lastMessageText: null,
  lastMessagePreview: null,
  lastMessageAt: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastInboundHash: null,
  category: null,
  closedStatusCacheKey: null,
  rollingSummary: null,
  whatTheyWant: null,
  openLoopsJson: null,
  toneNotesJson: null,
  rememberJson: null,
  replyBriefJson: null,
  firstFullBackfillAt: null
};
const prisma = {
  platform: {
    upsert: async ({ where, create, update }) => {
      const next = { ...(platformRows.get(where.name) ?? create), ...update };
      platformRows.set(where.name, next);
      return next;
    },
    findUnique: async ({ where }) => platformRows.get(where.name) ?? null
  },
  person: {
    findFirst: async () => ({
      id: "person-1",
      displayName: "Alex",
      displayNameSource: "auto",
      profileUrl: null,
      profileUrlSource: null,
      avatarUrl: null,
      inferredName: null
    }),
    create: async () => { throw new Error("person already exists"); },
    update: async () => undefined
  },
  thread: {
    count: async () => 0,
    findUnique: async () => ({ ...baseThread }),
    create: async () => { throw new Error("thread already exists"); },
    update: async () => ({ ...baseThread })
  },
  message: {
    upsert: async ({ create }) => {
      persistedMessage = {
        id: "message-1",
        ...create,
        timestamp: create.timestamp,
        audioTranscription: null,
        sentVia: null,
        replyToMessageId: null
      };
      return persistedMessage;
    },
    findMany: async () => persistedMessage ? [persistedMessage] : [],
    findFirst: async () => persistedMessage,
    findUnique: async () => null,
    aggregate: async ({ where }) => ({
      _max: {
        timestamp:
          persistedMessage && (!where.direction || where.direction === "IN")
            ? persistedMessage.timestamp
            : null
      }
    }),
    deleteMany: async () => ({ count: 0 }),
    delete: async () => undefined,
    update: async () => undefined
  },
  setting: {
    findUnique: async () => null,
    upsert: async () => undefined
  },
  $transaction: async (writes) => {
    await Promise.all(writes);
    transactionHook();
  }
};
globalThis.__inboxPrisma = prisma;

const { createScanQueue } = await import("../apps/runner/dist/services/scan-queue.js");

test.after(() => {
  delete globalThis.__inboxPrisma;
  rmSync(tempDir, { recursive: true, force: true });
});

function adapter(platform, overrides = {}) {
  return {
    platform,
    ensureConnected: async () => undefined,
    collectChangedThreads: async () => ({ stubs: [], fullSweepRequired: true }),
    scanUnreadThreads: async () => [],
    fetchRecentThreads: async () => [],
    fetchThreadMessages: async () => [],
    sendMessage: async () => { throw new Error("not used"); },
    openThread: async () => undefined,
    closeSession: async () => undefined,
    ...overrides
  };
}

function mutex() {
  return {
    runWithQueueOne: async (_key, work) => work(),
    getQueueDepth: () => 0
  };
}

test("an ALL scan rechecks selection before a future platform can reconnect", async () => {
  const enteredLinkedIn = deferred();
  const releaseLinkedIn = deferred();
  let instagramConnects = 0;
  let enabledPlatforms = ["LINKEDIN", "INSTAGRAM"];
  const queue = createScanQueue({
    adapters: {
      LINKEDIN: adapter("LINKEDIN", {
        ensureConnected: async () => {
          enteredLinkedIn.resolve();
          await releaseLinkedIn.promise;
        }
      }),
      INSTAGRAM: adapter("INSTAGRAM", {
        ensureConnected: async () => { instagramConnects += 1; }
      })
    },
    eventBus: { emit: () => undefined },
    settingsStore: {
      getSettings: async () => ({
        demoMode: false,
        recentThreadSweepCount: 10,
        maxMessagesPerThread: 20,
        scanIntervalSeconds: 60,
        enabledPlatforms
      })
    },
    aiService: {},
    platformMutex: mutex(),
    screenshotDir: tempDir,
    domDumpDir: tempDir,
    auditLog: async () => "audit"
  });

  const running = queue.runJob({ jobId: "all-selection", scope: "update" });
  await enteredLinkedIn.promise;
  enabledPlatforms = ["LINKEDIN"];
  releaseLinkedIn.resolve();
  await running;
  assert.equal(instagramConnects, 0);
});

test("revocation after message commit emits durable visibility but skips audio and AI", async () => {
  persistedMessage = null;
  const events = [];
  let audioCalls = 0;
  let aiCalls = 0;
  const settings = {
    demoMode: false,
    recentThreadSweepCount: 10,
    maxMessagesPerThread: 20,
    scanIntervalSeconds: 60,
    enabledPlatforms: ["LINKEDIN"],
    amberHours: 6,
    redHours: 18
  };
  const queue = createScanQueue({
    adapters: { LINKEDIN: adapter("LINKEDIN") },
    eventBus: { emit: (event) => events.push(event.type) },
    settingsStore: {
      getSettings: async () => settings,
      getOperatorProfile: async () => ({ aiHelpLevel: "writing_support" })
    },
    aiService: {
      updateThreadSummary: async () => { aiCalls += 1; throw new Error("must not run"); },
      classifyThreadCategory: async () => { aiCalls += 1; throw new Error("must not run"); },
      classifyThreadClosed: async () => { aiCalls += 1; throw new Error("must not run"); }
    },
    platformMutex: mutex(),
    screenshotDir: tempDir,
    domDumpDir: tempDir,
    auditLog: async () => "audit",
    onAudioMessage: () => { audioCalls += 1; }
  });
  const shouldContinue = queue.createContinueGate();
  transactionHook = () => queue.requestAbort("platform_selection_changed");

  const result = await queue.syncThreadForIngest({
    platform: "LINKEDIN",
    candidate: {
      platformThreadId: "platform-thread-1",
      displayName: "Alex",
      lastMessagePreview: "Voice note"
    },
    maxMessages: 20,
    requestId: "persist-then-revoke",
    messages: [{
      platformMessageKey: "message-key-1",
      direction: "IN",
      timestamp: new Date("2026-08-30T10:00:00.000Z").toISOString(),
      text: "Voice note",
      senderName: "Alex",
      attachments: [{ kind: "voice_note", url: "file:///tmp/voice.m4a" }]
    }],
    trigger: {
      kind: "platform_event",
      sourceChangedAt: "2026-08-30T09:59:59.000Z",
      reason: "message"
    },
    shouldContinue
  });

  assert.equal(result.updatedThreads, 1);
  assert.equal(audioCalls, 0);
  assert.equal(aiCalls, 0);
  assert.ok(events.includes("MESSAGES_PERSISTED"));
  assert.ok(events.includes("THREAD_UPDATED"));
  transactionHook = () => {};
});
