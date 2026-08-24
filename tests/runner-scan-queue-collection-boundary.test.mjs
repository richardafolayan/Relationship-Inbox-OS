import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("scan queue keeps bounded adapter freshness degraded without advancing lastScanAt", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "scan-boundary-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "queue.sqlite")}`;

  const platformState = new Map();
  const applyDefined = (target, values) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (value !== undefined) target[key] = value;
    }
  };
  const prisma = {
    platform: {
      upsert: async ({ where, update, create }) => {
        const current = platformState.get(where.name) ?? { ...create };
        applyDefined(current, update);
        platformState.set(where.name, current);
        return current;
      },
      findUnique: async ({ where }) => platformState.get(where.name) ?? null
    },
    setting: {
      findUnique: async () => null,
      upsert: async () => ({})
    }
  };
  globalThis.__inboxPrisma = prisma;

  const [{ createScanQueue }, { PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR }] =
    await Promise.all([
      import("../apps/runner/dist/services/scan-queue.js"),
      import("../apps/runner/dist/services/message-identity-reconciliation.js")
    ]);

  const originalLastScanAt = new Date("2026-08-20T10:00:00.000Z");
  platformState.set("INSTAGRAM", {
    name: "INSTAGRAM",
    status: "CONNECTED",
    lastError: null,
    lastScanAt: originalLastScanAt
  });
  let began = false;
  const adapter = {
    platform: "INSTAGRAM",
    collectionBoundary: {
      beginCycle: () => {
        began = true;
      },
      getMetrics: () => ({
        totalFound: 0,
        unreadFound: 0,
        completeness: "incomplete",
        nativeStopReason: "bounded_snapshot"
      })
    },
    ensureConnected: async () => undefined,
    scanUnreadThreads: async () => [],
    fetchRecentThreads: async () => [],
    fetchThreadMessages: async () => [],
    sendMessage: async () => {
      throw new Error("not used");
    },
    openThread: async () => undefined,
    closeSession: async () => undefined
  };
  const queue = createScanQueue({
    adapters: { INSTAGRAM: adapter },
    eventBus: { emit: () => undefined },
    settingsStore: {
      getSettings: async () => ({
        demoMode: false,
        recentThreadSweepCount: 10,
        maxMessagesPerThread: 20,
        scanIntervalSeconds: 60
      })
    },
    aiService: {},
    platformMutex: {
      runWithQueueOne: async (_key, run) => run(),
      getQueueDepth: () => 0
    },
    screenshotDir: tempDir,
    domDumpDir: tempDir,
    auditLog: async () => "audit"
  });

  await queue.runJob({
    jobId: "bounded-instagram",
    platform: "INSTAGRAM",
    scope: "full"
  });

  const finalState = platformState.get("INSTAGRAM");
  assert.equal(began, true);
  assert.equal(finalState.status, "DEGRADED");
  assert.equal(finalState.lastError, PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR);
  assert.equal(finalState.lastScanAt, originalLastScanAt);
});
