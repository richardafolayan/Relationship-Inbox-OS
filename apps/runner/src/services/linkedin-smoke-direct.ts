import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import type { NormalizedMessage, PlatformName, ThreadStub } from "@inbox-os/core";
import { runnerConfig } from "../config";
import { createSettingsStore } from "./settings";
import { createAuditService } from "./audit";
import { createEventBus } from "./event-bus";
import { createAiService } from "./ai";
import { createAdapters } from "./platform-factory";
import { createScanQueue } from "./scan-queue";
import { createKeyedMutex } from "./keyed-mutex";
import { createRunLogger } from "./run-logger";
import {
  createLinkedInSmokeLogger,
  writeLatestLinkedInSmokePointer
} from "./linkedin-smoke-logger";
import { AdapterFailure } from "../platforms/utils";
import type { LinkedInSmokeIngestResult, LinkedInSmokePersistInput } from "../platforms/linkedin-adapter";

interface LinkedInSmokeSuccess {
  ok: true;
  requestId: string;
  logDir: string;
  result: {
    outcome: LinkedInSmokeIngestResult["outcome"];
    unreadCount: number;
    name: string | null;
    listTimestamp: string | null;
    preview: string | null;
    messagesParsed: number;
    probeArtifacts: LinkedInSmokeIngestResult["probeArtifacts"];
  };
}

interface LinkedInSmokeFailure {
  ok: false;
  requestId: string;
  logDir: string;
  stage: string;
  reason: string;
  error: string;
}

export type LinkedInSmokeResponse = LinkedInSmokeSuccess | LinkedInSmokeFailure;

type ScanQueueWithSmokeIngest = ReturnType<typeof createScanQueue> & {
  syncThreadForIngest: (input: {
    platform: PlatformName;
    candidate: ThreadStub;
    maxMessages: number;
    requestId: string;
    messages?: NormalizedMessage[];
  }) => Promise<{ updatedThreads: number; parsedMessages: number }>;
};

function resolveSmokeFailure(input: { error: unknown }): {
  stage: string;
  reason: string;
  error: string;
} {
  if (input.error instanceof AdapterFailure) {
    const details = (input.error.details ?? {}) as Record<string, unknown>;
    return {
      stage: input.error.stage ?? "smoke_unread",
      reason: typeof details.reason === "string" ? details.reason : "unknown",
      error: input.error.message
    };
  }

  if (input.error instanceof Error) {
    return {
      stage: "smoke_unread",
      reason: "unknown",
      error: input.error.message
    };
  }

  return {
    stage: "smoke_unread",
    reason: "unknown",
    error: String(input.error)
  };
}

async function ensureRuntimeDirs(profileDir: string): Promise<void> {
  await mkdir(runnerConfig.screenshotDir, { recursive: true });
  await mkdir(runnerConfig.domDumpDir, { recursive: true });
  await mkdir(runnerConfig.profileDirs.LINKEDIN, { recursive: true });
  await mkdir(runnerConfig.profileDirs.INSTAGRAM, { recursive: true });
  await mkdir(runnerConfig.profileDirs.TIKTOK, { recursive: true });
  await mkdir(profileDir, { recursive: true });
}

export async function runLinkedInSmokeDirect(): Promise<LinkedInSmokeResponse> {
  const settingsStore = createSettingsStore();
  const auditService = createAuditService();
  const eventBus = createEventBus();
  const aiService = createAiService(settingsStore);
  const { adapters, sessionManager } = createAdapters({
    settingsStore
  });
  const operationMutex = createKeyedMutex();
  const defaultPersonKey = "default";

  await ensureRuntimeDirs(sessionManager.getProfileDir(defaultPersonKey));

  const scanQueue = createScanQueue({
    adapters,
    eventBus,
    settingsStore,
    aiService,
    platformMutex: operationMutex,
    personKey: defaultPersonKey,
    screenshotDir: runnerConfig.screenshotDir,
    domDumpDir: runnerConfig.domDumpDir,
    auditLog: (input) => auditService.log(input)
  }) as ScanQueueWithSmokeIngest;

  const requestId = uuid();
  const runTraceBaseDir = scanQueue.getRunTraceBaseDir();
  const runLogger = createRunLogger({
    requestId,
    platform: "LINKEDIN",
    runType: "linkedin-smoke",
    outDirBase: runTraceBaseDir,
    forceEnabled: true,
    emitConsole: false
  });
  const logDir =
    runLogger.runDir ??
    join(runTraceBaseDir, new Date().toISOString().slice(0, 10), "linkedin", requestId);
  const smokeLogger = await createLinkedInSmokeLogger({
    requestId,
    logDir,
    runLogger
  });

  await writeLatestLinkedInSmokePointer({
    runTraceBaseDir,
    requestId,
    logDir
  });
  await smokeLogger.logLogDir();

  const linkedInAdapter = adapters.LINKEDIN as typeof adapters.LINKEDIN & {
    setRunLogger?: (logger: typeof runLogger | null) => void;
    smokeUnreadIngest: (input: {
      requestId: string;
      logDir: string;
      persist: (input: LinkedInSmokePersistInput) => Promise<{ updatedThreads: number; parsedMessages: number }>;
      logStep?: (input: {
        step: number;
        totalSteps: number;
        stepName: string;
        message: string;
        details?: Record<string, unknown>;
      }) => void | Promise<void>;
      logLine?: (line: string) => Promise<void>;
      maxMessages?: number;
    }) => Promise<LinkedInSmokeIngestResult>;
  };

  try {
    const settings = await settingsStore.getSettings();
    const result = await operationMutex.runExclusive(`${defaultPersonKey}:LINKEDIN`, async () => {
      linkedInAdapter.setRunLogger?.(runLogger);
      return linkedInAdapter.smokeUnreadIngest({
        requestId,
        logDir,
        maxMessages: settings.maxMessagesPerThread,
        logLine: (line) => smokeLogger.logLine(line),
        logStep: (stepInput) => smokeLogger.logStep(stepInput),
        persist: async (persistInput) =>
          scanQueue.syncThreadForIngest({
            platform: "LINKEDIN",
            candidate: persistInput.thread,
            maxMessages: settings.maxMessagesPerThread,
            requestId,
            messages: persistInput.messages
          })
      });
    });

    const smokeSummaryLine =
      `[LI][SMOKE][req=${requestId}] SMOKE_OK ` +
      `outcome=${result.outcome} ` +
      `name=${result.summary.name ?? ""} ` +
      `listTimestamp=${result.summary.listTimestamp ?? ""} ` +
      `messagesParsed=${result.messagesParsed}`;
    await smokeLogger.logLine(smokeSummaryLine);
    await smokeLogger.logLogDir();

    runLogger.mergeCounters({
      messagesParsedCount: result.messagesParsed,
      updatedThreads: result.persisted?.updatedThreads ?? 0
    });
    runLogger.setStopReason("smoke_ok");
    runLogger.flush({
      success: true,
      stopReason: "smoke_ok"
    });

    return {
      ok: true,
      requestId,
      logDir,
      result: {
        outcome: result.outcome,
        unreadCount: result.unreadCount,
        name: result.summary.name,
        listTimestamp: result.summary.listTimestamp ?? null,
        preview: result.summary.previewSnippet ?? null,
        messagesParsed: result.messagesParsed,
        probeArtifacts: result.probeArtifacts
      }
    };
  } catch (error) {
    const failure = resolveSmokeFailure({ error });
    runLogger.logError({
      component: "linkedin-smoke",
      stage: failure.stage,
      action: "smoke_unread_failed",
      error,
      details: {
        reason: failure.reason
      }
    });
    runLogger.flush({
      success: false,
      stopReason: failure.reason,
      error
    });
    await smokeLogger.logLine(
      `[LI][SMOKE][req=${requestId}] SMOKE_FAIL stage=${failure.stage} reason=${failure.reason} error=${failure.error}`
    );
    await smokeLogger.logLogDir();

    return {
      ok: false,
      requestId,
      logDir,
      stage: failure.stage,
      reason: failure.reason,
      error: failure.error
    };
  } finally {
    linkedInAdapter.setRunLogger?.(null);
  }
}
