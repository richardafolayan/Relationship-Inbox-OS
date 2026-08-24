import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("scan queue keeps incomplete and capped adapters degraded without advancing freshness", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "scan-boundary-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "queue.sqlite")}`;

  const platformState = new Map();
  const settingWrites = [];
  const watermarkReads = new Map();
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
      upsert: async (input) => {
        settingWrites.push(input);
        return {};
      }
    }
  };
  globalThis.__inboxPrisma = prisma;

  const [
    { createScanQueue },
    {
      PLATFORM_SCAN_CANDIDATE_CAP_ERROR,
      PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR
    }
  ] =
    await Promise.all([
      import("../apps/runner/dist/services/scan-queue.js"),
      import("../apps/runner/dist/services/message-identity-reconciliation.js")
    ]);

  const originalLastScanAt = new Date("2026-08-20T10:00:00.000Z");
  const began = new Set();
  const createAdapter = (platform, completeness, nativeStopReason) => ({
    platform,
    collectionBoundary: {
      beginCycle: () => {
        began.add(platform);
      },
      getMetrics: () => ({
        totalFound: 0,
        unreadFound: 0,
        completeness,
        nativeStopReason
      })
    },
    ensureConnected: async () => undefined,
    getScanWatermark: async () => {
      watermarkReads.set(platform, (watermarkReads.get(platform) ?? 0) + 1);
      return `${platform.toLowerCase()}-watermark`;
    },
    collectChangedThreads: async () => ({ stubs: [], fullSweepRequired: true }),
    scanUnreadThreads: async () => [],
    fetchRecentThreads: async () => [],
    fetchThreadMessages: async () => [],
    sendMessage: async () => {
      throw new Error("not used");
    },
    openThread: async () => undefined,
    closeSession: async () => undefined
  });
  const adapters = {
    INSTAGRAM: createAdapter("INSTAGRAM", "incomplete", "bounded_snapshot"),
    IMESSAGE: createAdapter("IMESSAGE", "candidate_cap", "imessage_recent_limit_reached")
  };
  for (const platform of Object.keys(adapters)) {
    platformState.set(platform, {
      name: platform,
      status: "CONNECTED",
      lastError: null,
      lastScanAt: originalLastScanAt
    });
  }
  const queue = createScanQueue({
    adapters,
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

  for (const platform of Object.keys(adapters)) {
    await queue.runJob({
      jobId: `bounded-${platform.toLowerCase()}`,
      platform,
      scope: "full"
    });

    const finalState = platformState.get(platform);
    assert.equal(began.has(platform), true);
    assert.equal(finalState.status, "DEGRADED");
    assert.equal(
      finalState.lastError,
      platform === "IMESSAGE"
        ? PLATFORM_SCAN_CANDIDATE_CAP_ERROR
        : PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR
    );
    assert.equal(finalState.lastScanAt, originalLastScanAt);
    assert.equal(watermarkReads.get(platform), 1);
  }
  assert.deepEqual(settingWrites, []);
});
