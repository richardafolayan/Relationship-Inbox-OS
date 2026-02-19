import type { NormalizedMessage, PlatformAdapter, PlatformName, ThreadStub } from "@inbox-os/core";
import { calculateRisk, stableHash } from "@inbox-os/core";
import { v4 as uuid } from "uuid";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { prisma } from "../db";
import type { AiService, EventBus, ScanJobOutcome, SettingsStore } from "../types/runtime";
import { AdapterFailure, cleanText, humanDelay } from "../platforms/utils";
import { resolveAdapterFailureKind, shouldStopScanForFailureKind } from "./failure-routing";
import type { KeyedMutex } from "./keyed-mutex";
import {
  ScanRetryController,
  type ScanCooldownStatus
} from "./scan-retry-controller";
import { isLinkedInInFlight } from "./linkedin-inflight-guard";
import {
  createRunLogger,
  type RunLogger,
  type RunTraceSummary
} from "./run-logger";
import {
  getDevLoggingFlags,
  getLinkedInDevScanCaps,
  isAutoScanDisabledInDev
} from "../dev-flags";
import {
  isTemporaryLinkedInId,
  normalizeCanonicalLinkedInThreadId
} from "../linkedin/linkedinIdentity.js";
import { parseLinkedInListTimestamp } from "../linkedin/linkedinTime.js";

interface ScanQueueDeps {
  adapters: Record<PlatformName, PlatformAdapter>;
  eventBus: EventBus;
  settingsStore: SettingsStore;
  aiService: AiService;
  platformMutex: Pick<KeyedMutex, "runWithQueueOne" | "getQueueDepth">;
  personKey?: string;
  screenshotDir: string;
  domDumpDir: string;
  auditLog: (input: {
    platform?: PlatformName;
    stage?: string;
    action: string;
    status: "OK" | "FAIL";
    details?: Record<string, unknown>;
    screenshotFile?: string;
    domDumpFile?: string;
  }) => Promise<string>;
}

type ScanJob = {
  jobId: string;
  platform?: PlatformName;
};

interface TraceAwareAdapter {
  setRunLogger?: (logger: RunLogger | null) => void;
}

interface LinkedInScanAdapter extends PlatformAdapter {
  scanUnreadThreads(options?: {
    maxThreads?: number;
    maxOpens?: number;
    disableDeepScroll?: boolean;
    requestId: string;
    runLogger?: RunLogger;
  }): Promise<ThreadStub[]>;
  fetchRecentThreads(limit: number, options?: {
    maxThreads?: number;
    maxOpens?: number;
    disableDeepScroll?: boolean;
    requestId: string;
    runLogger?: RunLogger;
  }): Promise<ThreadStub[]>;
}

const allPlatforms: PlatformName[] = ["LINKEDIN", "INSTAGRAM", "TIKTOK"];

export type EnqueueScanResult =
  | {
      ok: true;
      jobId: string;
      status: "queued" | "running";
      requestId: string;
      platform?: PlatformName;
    }
  | {
      ok: false;
      blocked: true;
      reason: "cooldown_active" | "in_flight";
      retryAfterSeconds: number;
      requestId: string;
      platform?: PlatformName;
    };

export function createScanQueue(deps: ScanQueueDeps) {
  const runnerRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const latestLinkedInScanPointerPath = resolve(runnerRootDir, "LATEST_LINKEDIN_SCAN.txt");
  const queue: ScanJob[] = [];
  let processing = false;
  let currentJob: ScanJob | null = null;
  let scheduler: NodeJS.Timeout | undefined;
  let abortVersion = 0;
  let abortReason: string | null = null;
  const activeRunLoggerByPlatform = new Map<PlatformName, RunLogger>();
  const latestRunSummaryByPlatform = new Map<PlatformName, RunTraceSummary>();
  const runTraceBaseDir = resolve(process.env.RUN_TRACE_DIR ?? "./logs/runs");

  const personKey = deps.personKey ?? "default";
  const retryController = new ScanRetryController(undefined, undefined, undefined, (event) => {
    const candidateLoggers = event.platform
      ? [activeRunLoggerByPlatform.get(event.platform)]
      : Array.from(activeRunLoggerByPlatform.values());
    for (const logger of candidateLoggers) {
      if (!logger?.enabled) {
        continue;
      }
      logger.logEvent({
        level: event.action === "reload_guard_blocked" ? "warn" : "info",
        component: "scan-retry-controller",
        stage: "retry_control",
        action: event.action,
        details: event.details
      });
      if (event.action === "reload_guard_blocked") {
        logger.logDecision({
          stage: "retry_control",
          level: "warn",
          decision: "Reload suppressed due to guard/cooldown",
          details: event.details
        });
      }
    }
  });

  function lockKey(platform: PlatformName): string {
    return `${personKey}:${platform}`;
  }

  async function writeLatestLinkedInScanPointer(input: {
    requestId: string;
    logDir: string;
  }): Promise<void> {
    await mkdir(dirname(latestLinkedInScanPointerPath), { recursive: true });
    await writeFile(
      latestLinkedInScanPointerPath,
      `LOG_DIR=${resolve(input.logDir)}\nrequestId=${input.requestId}\n`,
      "utf8"
    );
  }

  function adapterErrorDetails(error: AdapterFailure | undefined): Record<string, unknown> {
    if (!error?.details || typeof error.details !== "object") {
      return {};
    }
    return error.details;
  }

  function extractNestedMessage(value: unknown): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
    return undefined;
  }

  function classifyFailureReason(input: {
    message: string;
    details: Record<string, unknown>;
  }): string {
    const normalized = input.message.toLowerCase();
    const runtimeContext = input.details.runtimeContext;
    const runtimeContextUrl =
      runtimeContext && typeof runtimeContext === "object" && typeof (runtimeContext as Record<string, unknown>).url === "string"
        ? ((runtimeContext as Record<string, unknown>).url as string).toLowerCase()
        : "";

    if (normalized.includes("__name is not defined")) {
      return "evaluate_helper_missing";
    }
    if (normalized.includes("referenceerror")) {
      return "evaluate_reference_error";
    }
    if (normalized.includes("target page, context or browser has been closed")) {
      return "page_closed_mid_stage";
    }
    if (normalized.includes("reload suppressed") || normalized.includes("retry loop")) {
      return "repeated_reload_guard_triggered";
    }
    if (normalized.includes("timeouterror") || normalized.includes("timeout")) {
      return "timeout";
    }
    if (normalized.includes("execution context was destroyed")) {
      return "transient_context_destroyed";
    }
    if (normalized.includes("detached")) {
      return "element_detached";
    }
    if (
      normalized.includes("auth required") ||
      normalized.includes("login required") ||
      normalized.includes("sign in") ||
      runtimeContextUrl.includes("/uas/login")
    ) {
      return "login_required";
    }
    if (normalized.includes("checkpoint") || normalized.includes("verify") || runtimeContextUrl.includes("/checkpoint/")) {
      return "checkpoint_required";
    }
    if (normalized.includes("too many requests") || normalized.includes("rate limit")) {
      return "rate_limited";
    }
    if (normalized.includes("manual refresh required") || normalized.includes("refresh linkedin manually")) {
      return "manual_refresh_required";
    }
    if (normalized.includes("something went wrong") || normalized.includes("overlay")) {
      return "linkedin_error_overlay";
    }
    if (
      normalized.includes("thread list") ||
      normalized.includes("still loading") ||
      normalized.includes("container is missing")
    ) {
      return "thread_list_not_ready";
    }

    return "unknown";
  }

  function extractFailureReason(error: AdapterFailure | undefined, message: string): string | undefined {
    const details = adapterErrorDetails(error);
    if (typeof details.reason === "string" && details.reason.trim()) {
      return details.reason;
    }
    return classifyFailureReason({
      message,
      details
    });
  }

  function extractFailureMessage(error: AdapterFailure | undefined, fallback: string): string {
    if (!error) {
      return fallback;
    }
    const details = adapterErrorDetails(error);
    if (typeof details.message === "string" && details.message.trim()) {
      return details.message;
    }
    const nestedDetailErrorMessage = extractNestedMessage(details.error);
    if (nestedDetailErrorMessage) {
      return nestedDetailErrorMessage;
    }
    const nestedInnerErrorMessage = extractNestedMessage(details.innerError);
    if (nestedInnerErrorMessage) {
      return nestedInnerErrorMessage;
    }
    return fallback;
  }

  function extractInnerError(error: AdapterFailure | undefined): unknown {
    const details = adapterErrorDetails(error);
    return details.error ?? details.innerError;
  }

  function summarizeScanFailure(input: {
    stage?: string;
    reason?: string;
    requestId: string;
    message: string;
  }): string {
    const stage = input.stage ?? "collect_threads";
    const reasonPart = input.reason ? ` · ${input.reason}` : "";
    return `${stage}${reasonPart} · request ${input.requestId}: ${input.message}`;
  }

  function extractRecoveryAttempts(error: AdapterFailure | undefined): number {
    const details = adapterErrorDetails(error);
    const value = details.recoveryAttempts;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    return 0;
  }

  function toTraceAwareAdapter(adapter: PlatformAdapter): TraceAwareAdapter {
    return adapter as unknown as TraceAwareAdapter;
  }

  function resolveFailureArtifactPath(input: {
    artifactName?: string;
    type: "screenshot" | "dom";
  }): string | undefined {
    if (!input.artifactName) {
      return undefined;
    }
    const baseDir = input.type === "screenshot" ? deps.screenshotDir : deps.domDumpDir;
    return join(baseDir, input.artifactName);
  }

  async function markPlatformFailure(input: {
    platform: PlatformName;
    status: "DEGRADED" | "ERROR" | "NOT_CONNECTED";
    failureReason?: string;
    summary: string;
    requestId: string;
    stage: string;
    message: string;
    adapterError?: AdapterFailure;
    error?: unknown;
    action: string;
    failureKind?: string;
    threadDisplayName?: string;
    platformThreadId?: string;
    runLogger?: RunLogger;
  }): Promise<void> {
    const retry = retryController.markFailure(input.platform);
    const reloadGuard = retryController.registerReloadAttempt(
      input.platform,
      extractRecoveryAttempts(input.adapterError)
    );
    const effectiveReason = reloadGuard.blocked ? "repeated_reload_guard_triggered" : input.failureReason ?? "unknown";
    const withCooldown =
      retry.retryAfterSeconds > 0
        ? `${input.summary} (cooldown ${retry.retryAfterSeconds}s)`
        : input.summary;

    input.runLogger?.logError({
      component: "scan-queue",
      stage: input.stage,
      action: input.action,
      error: input.error ?? input.adapterError ?? new Error(input.message),
      details: {
        platform: input.platform,
        failureKind: input.failureKind ?? "UNKNOWN",
        reason: effectiveReason,
        status: input.status,
        retryAfterSeconds: retry.retryAfterSeconds,
        consecutiveFailures: retry.consecutiveFailures,
        reloadGuardBlocked: reloadGuard.blocked,
        reloadGuardRetryAfterSeconds: reloadGuard.retryAfterSeconds
      }
    });
    input.runLogger?.logDecision({
      level: reloadGuard.blocked ? "warn" : "info",
      stage: input.stage,
      decision: reloadGuard.blocked ? "Reload suppressed due to guard/cooldown" : "Failure recorded with cooldown policy",
      details: {
        reason: effectiveReason,
        retryAfterSeconds: retry.retryAfterSeconds,
        consecutiveFailures: retry.consecutiveFailures,
        reloadGuardBlocked: reloadGuard.blocked,
        reloadGuardRetryAfterSeconds: reloadGuard.retryAfterSeconds
      }
    });
    if (input.adapterError) {
      input.runLogger?.copyFailureArtifacts({
        screenshotPath: resolveFailureArtifactPath({
          artifactName: input.adapterError.screenshotFile,
          type: "screenshot"
        }),
        domDumpPath: resolveFailureArtifactPath({
          artifactName: input.adapterError.domDumpFile,
          type: "dom"
        })
      });
    }

    await setPlatformStatus({
      platform: input.platform,
      status: input.status,
      lastError: withCooldown
    });

    await deps.auditLog({
      platform: input.platform,
      stage: "Scan",
      action: input.action,
      status: "FAIL",
      details: {
        jobId: input.requestId,
        requestId: input.requestId,
        stage: input.stage,
        platform: input.platform,
        message: input.message,
        reason: effectiveReason,
        failureKind: input.failureKind ?? "UNKNOWN",
        retryAfterSeconds: retry.retryAfterSeconds,
        consecutiveFailures: retry.consecutiveFailures,
        reloadGuardBlocked: reloadGuard.blocked,
        reloadGuardRetryAfterSeconds: reloadGuard.retryAfterSeconds,
        threadDisplayName: input.threadDisplayName,
        platformThreadId: input.platformThreadId,
        errorStack: input.error instanceof Error ? input.error.stack : undefined,
        innerError: extractInnerError(input.adapterError),
        stageReceipts: adapterErrorDetails(input.adapterError).stageReceipts,
        runtimeContext: adapterErrorDetails(input.adapterError).runtimeContext
      },
      screenshotFile: input.adapterError?.screenshotFile,
      domDumpFile: input.adapterError?.domDumpFile
    });
  }

  function triggerProcessNext(): void {
    void processNext().catch((error) => {
      void deps.auditLog({
        stage: "Scan",
        action: "SCAN_QUEUE_PROCESS_FAIL",
        status: "FAIL",
        details: {
          personKey,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }
      });
    });
  }

  function getQueueDepth(): number {
    return queue.length + (processing ? 1 : 0) + deps.platformMutex.getQueueDepth();
  }

  async function setPlatformStatus(input: {
    platform: PlatformName;
    status: "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
    lastError?: string;
    connected?: boolean;
  }): Promise<void> {
    const resolvedLastError = input.status === "CONNECTED" ? null : input.lastError;

    await prisma.platform.upsert({
      where: { name: input.platform },
      update: {
        status: input.status,
        lastError: resolvedLastError,
        connectedAt: input.connected ? new Date() : undefined,
        lastScanAt: input.status === "CONNECTED" ? new Date() : undefined
      },
      create: {
        name: input.platform,
        status: input.status,
        lastError: resolvedLastError,
        connectedAt: input.connected ? new Date() : undefined,
        lastScanAt: input.status === "CONNECTED" ? new Date() : undefined
      }
    });

    deps.eventBus.emit({
      type: "PLATFORM_STATUS_CHANGED",
      jobId: uuid(),
      platform: input.platform,
      status: input.status
    });
  }

  async function ensurePlatformRows(): Promise<void> {
    for (const platform of allPlatforms) {
      await prisma.platform.upsert({
        where: { name: platform },
        update: {},
        create: {
          name: platform,
          status: "NOT_CONNECTED"
        }
      });
    }
  }

  function enqueueScan(
    platform?: PlatformName,
    options?: { respectCooldown?: boolean; requestId?: string }
  ): EnqueueScanResult {
    const requestId = options?.requestId ?? uuid();
    if (isLinkedInInFlight({
      requestedPlatform: platform,
      currentJob,
      queuedJobs: queue
    })) {
      return {
        ok: false,
        blocked: true,
        reason: "in_flight",
        retryAfterSeconds: 30,
        requestId,
        platform
      };
    }
    const cooldown = options?.respectCooldown === false
      ? { blocked: false, retryAfterSeconds: 0, platform }
      : retryController.getCooldown(platform);
    if (cooldown.blocked) {
      const blockedLogger = createRunLogger({
        requestId,
        platform: platform ?? "ALL",
        runType: "scan",
        outDirBase: runTraceBaseDir
      });
      blockedLogger.logDecision({
        stage: "enqueue",
        level: "warn",
        decision: "Scan request blocked by cooldown",
        details: {
          platform: platform ?? "ALL",
          retryAfterSeconds: cooldown.retryAfterSeconds
        }
      });
      const blockedSummary = blockedLogger.flush({
        success: false,
        stopReason: "cooldown_active",
        counters: {
          retryAfterSeconds: cooldown.retryAfterSeconds
        }
      });
      if (platform) {
        latestRunSummaryByPlatform.set(platform, blockedSummary);
      }
      return {
        ok: false,
        blocked: true,
        reason: "cooldown_active",
        retryAfterSeconds: cooldown.retryAfterSeconds,
        requestId,
        platform
      };
    }

    const job: ScanJob = {
      jobId: requestId,
      platform
    };

    queue.push(job);
    triggerProcessNext();

    return {
      ok: true,
      jobId: job.jobId,
      status: processing ? "queued" : "running",
      requestId: job.jobId,
      platform
    };
  }

  function startScheduler(): void {
    if (isAutoScanDisabledInDev()) {
      if (scheduler) {
        clearInterval(scheduler);
        scheduler = undefined;
      }
      return;
    }

    if (scheduler) {
      clearInterval(scheduler);
    }

    let lastRunAt = 0;

    scheduler = setInterval(() => {
      void (async () => {
        const settings = await deps.settingsStore.getSettings();
        if (settings.demoMode) {
          return;
        }

        const now = Date.now();
        const intervalMs = settings.scanIntervalSeconds * 1000;
        if (processing || now - lastRunAt < intervalMs) {
          return;
        }

        lastRunAt = now;
        enqueueScan(undefined, { respectCooldown: true });
      })().catch((error) => {
        void deps.auditLog({
          stage: "Scan",
          action: "SCHEDULER_TICK_FAIL",
          status: "FAIL",
          details: {
            personKey,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          }
        });
      });
    }, 1000);
  }

  async function processNext(): Promise<void> {
    if (processing) {
      return;
    }

    const next = queue.shift();
    if (!next) {
      return;
    }

    processing = true;
    currentJob = next;

    try {
      await runJob(next);
    } finally {
      processing = false;
      currentJob = null;
      if (queue.length > 0) {
        triggerProcessNext();
      }
    }
  }

  async function runJob(job: ScanJob): Promise<ScanJobOutcome> {
    deps.eventBus.emit({
      type: "SCAN_STARTED",
      jobId: job.jobId,
      platform: job.platform
    });

    await ensurePlatformRows();
    const settings = await deps.settingsStore.getSettings();
    const scanPlatforms = job.platform
      ? [job.platform]
      : settings.enabledPlatforms.filter((platform) => allPlatforms.includes(platform));

    let updatedThreads = 0;
    const jobAbortVersion = abortVersion;
    let aborted = false;

    const shouldAbort = (): boolean => abortVersion !== jobAbortVersion;
    const resolveAbortReason = (): string => abortReason ?? "session_preempt";

    const markAborted = async (
      checkpoint: string,
      platform?: PlatformName,
      thread?: ThreadStub
    ): Promise<boolean> => {
      if (!shouldAbort()) {
        return false;
      }
      if (aborted) {
        return true;
      }

      aborted = true;
      if (platform) {
        const runLogger = activeRunLoggerByPlatform.get(platform);
        runLogger?.logDecision({
          stage: "scan_abort",
          level: "warn",
          decision: "Scan aborted",
          details: {
            checkpoint,
            reason: resolveAbortReason(),
            threadDisplayName: thread?.displayName,
            platformThreadId: thread?.platformThreadId
          }
        });
      }
      await deps.auditLog({
        platform,
        stage: "Scan",
        action: "SCAN_ABORTED",
        status: "OK",
        details: {
          reason: resolveAbortReason(),
          checkpoint,
          updatedThreads,
          threadDisplayName: thread?.displayName,
          platformThreadId: thread?.platformThreadId
        }
      });
      return true;
    };

    for (const platform of scanPlatforms) {
      await deps.platformMutex.runWithQueueOne(lockKey(platform), async () => {
        const runLogger = createRunLogger({
          requestId: job.jobId,
          platform,
          runType: "scan",
          outDirBase: runTraceBaseDir,
          createLogDirWhenDisabled: platform === "LINKEDIN"
        });
        activeRunLoggerByPlatform.set(platform, runLogger);

        const linkedInDevCaps = platform === "LINKEDIN" ? getLinkedInDevScanCaps() : { disableDeepScroll: false };
        const stageHeadlinesEnabled = platform === "LINKEDIN" && getDevLoggingFlags().stageHeadlines;
        const logDir = runLogger.runDir ?? null;
        const headline = (stage: string, message: string, details?: Record<string, unknown>): void => {
          if (!stageHeadlinesEnabled) {
            return;
          }
          runLogger.headline({
            platform: "LI",
            requestId: job.jobId,
            stage,
            message,
            details
          });
        };

        const adapter = deps.adapters[platform];
        const linkedInAdapter = platform === "LINKEDIN" ? (adapter as LinkedInScanAdapter) : null;
        const traceAwareAdapter = toTraceAwareAdapter(adapter);
        traceAwareAdapter.setRunLogger?.(runLogger);

        let platformUpdatedThreads = 0;
        let threadFailures = 0;
        const threadFailureKinds: Record<string, number> = {};
        let authInterrupted = false;
        let openedThreadsCount = 0;
        let messagesParsedCount = 0;
        let candidatesCount = 0;
        let unreadCandidatesCount = 0;
        let runSuccess = false;
        let runStopReason: string | undefined;
        let runError: unknown;

        runLogger.logEvent({
          level: "info",
          component: "scan-queue",
          stage: "scan_start",
          action: "platform_scan_start",
          details: {
            requestId: job.jobId,
            platform,
            scope: job.platform ?? "ALL",
            queueDepth: getQueueDepth()
          }
        });
        if (platform === "LINKEDIN" && logDir) {
          await writeLatestLinkedInScanPointer({
            requestId: job.jobId,
            logDir
          }).catch(() => undefined);
        }
        headline("SCAN_START", "scan run started", {
          LOG_DIR: logDir,
          caps: linkedInDevCaps
        });
        if (logDir) {
          headline("SCAN_START", `LOG_DIR: ${logDir}`);
        }

        try {
          if (await markAborted("before_platform_loop", platform)) {
            runStopReason = "aborted";
            return;
          }
          const cooldown = retryController.getCooldown(platform);
          if (cooldown.blocked) {
            runStopReason = "cooldown_active";
            runLogger.logDecision({
              stage: "collect_threads",
              decision: "Scan blocked because cooldown is active",
              details: {
                retryAfterSeconds: cooldown.retryAfterSeconds,
                platform
              }
            });
            const cooldownMessage = `collect_threads · cooldown_active · request ${job.jobId}: Cooling down — next retry in ${cooldown.retryAfterSeconds}s`;
            await setPlatformStatus({
              platform,
              status: "DEGRADED",
              lastError: cooldownMessage
            });
            await deps.auditLog({
              platform,
              stage: "Scan",
              action: "SCAN_COOLDOWN_ACTIVE",
              status: "OK",
              details: {
                jobId: job.jobId,
                requestId: job.jobId,
                stage: "collect_threads",
                platform,
                reason: "cooldown_active",
                retryAfterSeconds: cooldown.retryAfterSeconds
              }
            });
            headline("SCAN_END_FAIL", "scan blocked by cooldown", {
              reason: "cooldown_active",
              retryAfterSeconds: cooldown.retryAfterSeconds,
              LOG_DIR: logDir
            });
            if (logDir) {
              headline("SCAN_END_FAIL", `LOG_DIR: ${logDir}`);
            }
            return;
          }

          deps.eventBus.emit({
            type: "SCAN_PROGRESS",
            jobId: job.jobId,
            platform,
            stage: "Connecting"
          });
          headline("CONNECT_START", "connecting to platform", {
            platform
          });

          if (await markAborted("before_connect", platform)) {
            runStopReason = "aborted";
            return;
          }
          await adapter.ensureConnected();
          runLogger.logAction({
            stage: "connect",
            action: "ensure_connected",
            result: "ok"
          });
          if (await markAborted("after_connect", platform)) {
            runStopReason = "aborted";
            return;
          }
          await setPlatformStatus({ platform, status: "CONNECTED", connected: true });
          headline("CONNECT_OK", "connection ready", {
            platform
          });

          deps.eventBus.emit({
            type: "SCAN_PROGRESS",
            jobId: job.jobId,
            platform,
            stage: "Collecting candidates"
          });
          headline("COLLECT_UNREAD_START", "collecting unread + needs-reply candidates", {
            disableDeepScroll: linkedInDevCaps.disableDeepScroll,
            maxThreads: linkedInDevCaps.maxThreads ?? null,
            maxOpens: linkedInDevCaps.maxOpens ?? null
          });

          if (await markAborted("before_scan_unread", platform)) {
            runStopReason = "aborted";
            return;
          }
          const unread = linkedInAdapter
            ? await linkedInAdapter.scanUnreadThreads({
                maxThreads: linkedInDevCaps.maxThreads,
                maxOpens: linkedInDevCaps.maxOpens,
                disableDeepScroll: linkedInDevCaps.disableDeepScroll,
                requestId: job.jobId,
                runLogger
              })
            : await adapter.scanUnreadThreads();
          unreadCandidatesCount = unread.length;
          runLogger.logAction({
            stage: "collect_threads",
            action: "scan_unread_threads",
            result: "ok",
            counts: {
              unreadCandidatesCount
            }
          });
          if (await markAborted("after_scan_unread", platform)) {
            runStopReason = "aborted";
            return;
          }
          if (await markAborted("before_scan_recent", platform)) {
            runStopReason = "aborted";
            return;
          }
          const recent = linkedInAdapter
            ? await linkedInAdapter.fetchRecentThreads(settings.recentThreadSweepCount, {
                maxThreads: linkedInDevCaps.maxThreads,
                maxOpens: linkedInDevCaps.maxOpens,
                disableDeepScroll: linkedInDevCaps.disableDeepScroll,
                requestId: job.jobId,
                runLogger
              })
            : await adapter.fetchRecentThreads(settings.recentThreadSweepCount);
          runLogger.logAction({
            stage: "collect_threads",
            action: "scan_recent_threads",
            result: "ok",
            counts: {
              recentCandidatesCount: recent.length
            }
          });
          if (await markAborted("after_scan_recent", platform)) {
            runStopReason = "aborted";
            return;
          }

          const merged = new Map<string, ThreadStub>();
          for (const thread of unread) {
            merged.set(thread.platformThreadId, thread);
          }
          for (const thread of recent) {
            if (!merged.has(thread.platformThreadId)) {
              merged.set(thread.platformThreadId, thread);
            }
          }
          const candidatesBeforeCap = merged.size;
          const mergedCandidates = Array.from(merged.values());
          const cappedCandidates =
            typeof linkedInDevCaps.maxThreads === "number" && linkedInDevCaps.maxThreads > 0
              ? mergedCandidates.slice(0, linkedInDevCaps.maxThreads)
              : mergedCandidates;
          candidatesCount = cappedCandidates.length;
          runLogger.logDecision({
            stage: "collect_threads",
            decision: "Merged unread and recent candidates",
            details: {
              unreadCandidatesCount,
              recentCandidatesCount: recent.length,
              mergedCandidatesCount: candidatesBeforeCap,
              cappedCandidatesCount: candidatesCount
            }
          });
          const metricsProvider = adapter as unknown as {
            getLastCollectionMetrics?: () => Record<string, unknown> | null;
          };
          const collectionMetrics =
            typeof metricsProvider.getLastCollectionMetrics === "function"
              ? metricsProvider.getLastCollectionMetrics()
              : null;

          deps.eventBus.emit({
            type: "SCAN_PROGRESS",
            jobId: job.jobId,
            platform,
            stage: `Syncing ${candidatesCount} thread(s)`
          });
          headline("COLLECT_UNREAD_OK", "candidate collection complete", {
            rows: candidatesBeforeCap,
            candidates: candidatesCount,
            stopReason:
              typeof collectionMetrics?.stopReason === "string" ? (collectionMetrics.stopReason as string) : undefined
          });

          const maxOpens = linkedInDevCaps.maxOpens;
          const maxOpenCount = typeof maxOpens === "number" && maxOpens > 0 ? maxOpens : cappedCandidates.length;

          for (const thread of cappedCandidates) {
            if (openedThreadsCount >= maxOpenCount) {
              break;
            }
            if (await markAborted("before_thread_sync", platform, thread)) {
              runStopReason = "aborted";
              break;
            }

            openedThreadsCount += 1;
            headline("OPEN_THREAD_START", "opening candidate thread", {
              index: openedThreadsCount,
              total: Math.min(cappedCandidates.length, maxOpenCount),
              name: thread.displayName,
              listTimestamp: thread.lastMessageAt ?? null,
              url: thread.threadUrl ?? null
            });
            runLogger.logAction({
              stage: "open_thread",
              action: "thread_sync_start",
              result: "ok",
              counts: {
                openedThreadsCount
              },
              note: `${thread.displayName} (${thread.platformThreadId})`
            });

            try {
              const syncResult = await syncThread(platform, thread, settings.maxMessagesPerThread, job.jobId, runLogger);
              updatedThreads += syncResult.updatedThreads;
              platformUpdatedThreads += syncResult.updatedThreads;
              messagesParsedCount += syncResult.parsedMessages;
              headline("OPEN_THREAD_OK", "thread opened and synced", {
                index: openedThreadsCount,
                total: Math.min(cappedCandidates.length, maxOpenCount),
                name: thread.displayName
              });
              headline("PARSE_MESSAGES_OK", "thread messages parsed", {
                name: thread.displayName,
                messagesParsed: syncResult.parsedMessages
              });
              headline("PERSIST_OK", "thread persisted", {
                name: thread.displayName,
                threadsUpserted: syncResult.updatedThreads,
                messagesUpserted: syncResult.parsedMessages
              });
              runLogger.logAction({
                stage: "read_thread",
                action: "thread_sync_complete",
                result: "ok",
                counts: {
                  openedThreadsCount,
                  messagesParsedCount,
                  updatedThreads: platformUpdatedThreads
                },
                note: thread.displayName
              });
            } catch (error) {
              runError = error;
              if (await markAborted("thread_sync_error", platform, thread)) {
                runStopReason = "aborted";
                break;
              }

              const failureKind = resolveAdapterFailureKind(error);
              const baseMessage = error instanceof Error ? error.message : String(error);
              const resolvedFailureKind = failureKind ?? "UNKNOWN";
              const adapterError = error instanceof AdapterFailure ? error : undefined;
              const message = extractFailureMessage(adapterError, baseMessage);
              const failureReason = extractFailureReason(adapterError, message);
              const failureStage = adapterError?.stage ?? "parse";
              const requestId = job.jobId;
              const summarizedFailure = summarizeScanFailure({
                stage: failureStage,
                reason: failureReason,
                requestId,
                message
              });

              runLogger.logError({
                component: "scan-queue",
                stage: failureStage,
                action: "thread_sync_fail",
                error,
                details: {
                  reason: failureReason ?? "unknown",
                  failureKind: resolvedFailureKind,
                  threadDisplayName: thread.displayName,
                  platformThreadId: thread.platformThreadId
                }
              });

              if (adapterError) {
                runLogger.copyFailureArtifacts({
                  screenshotPath: resolveFailureArtifactPath({
                    artifactName: adapterError.screenshotFile,
                    type: "screenshot"
                  }),
                  domDumpPath: resolveFailureArtifactPath({
                    artifactName: adapterError.domDumpFile,
                    type: "dom"
                  })
                });
              }

              if (shouldStopScanForFailureKind(failureKind)) {
                runStopReason = failureReason ?? "auth_required";
                await setPlatformStatus({
                  platform,
                  status: "NOT_CONNECTED",
                  lastError: summarizedFailure
                });

                await deps.auditLog({
                  platform,
                  stage: "Scan",
                  action: "SCAN_AUTH_REQUIRED",
                  status: "FAIL",
                  details: {
                    jobId: job.jobId,
                    requestId,
                    stage: failureStage,
                    platform,
                    message,
                    reason: failureReason ?? "unknown",
                    failureKind: resolvedFailureKind,
                    threadDisplayName: thread.displayName,
                    platformThreadId: thread.platformThreadId,
                    errorStack: error instanceof Error ? error.stack : undefined,
                    innerError: extractInnerError(adapterError),
                    stageReceipts: adapterErrorDetails(adapterError).stageReceipts,
                    runtimeContext: adapterErrorDetails(adapterError).runtimeContext
                  },
                  screenshotFile: adapterError?.screenshotFile,
                  domDumpFile: adapterError?.domDumpFile
                });

                authInterrupted = true;
                break;
              }

              threadFailures += 1;
              threadFailureKinds[resolvedFailureKind] = (threadFailureKinds[resolvedFailureKind] ?? 0) + 1;

              await deps.auditLog({
                platform,
                stage: "Scan",
                action: "THREAD_SYNC_FAIL",
                status: "FAIL",
                details: {
                  jobId: job.jobId,
                  requestId,
                  stage: failureStage,
                  platform,
                  message,
                  reason: failureReason ?? "unknown",
                  failureKind: resolvedFailureKind,
                  threadDisplayName: thread.displayName,
                  platformThreadId: thread.platformThreadId,
                  errorStack: error instanceof Error ? error.stack : undefined,
                  innerError: extractInnerError(adapterError),
                  stageReceipts: adapterErrorDetails(adapterError).stageReceipts,
                  runtimeContext: adapterErrorDetails(adapterError).runtimeContext
                },
                screenshotFile: adapterError?.screenshotFile,
                domDumpFile: adapterError?.domDumpFile
              });
            }

            if (await markAborted("after_thread_sync", platform, thread)) {
              runStopReason = "aborted";
              break;
            }

            await humanDelay();
          }

          if (aborted) {
            runStopReason = runStopReason ?? "aborted";
            return;
          }

          if (authInterrupted) {
            runSuccess = false;
            runStopReason = runStopReason ?? "auth_required";
            return;
          }

          await prisma.platform.update({
            where: { name: platform },
            data: {
              status: "CONNECTED",
              lastScanAt: new Date(),
              lastError: null
            }
          });

          runStopReason =
            typeof collectionMetrics?.stopReason === "string" ? (collectionMetrics.stopReason as string) : runStopReason;
          runLogger.setStopReason(runStopReason ?? "scan_complete");
          headline("SCAN_END_OK", "scan completed", {
            stopReason: runStopReason ?? "scan_complete",
            updatedThreads: platformUpdatedThreads,
            LOG_DIR: logDir
          });
          if (logDir) {
            headline("SCAN_END_OK", `LOG_DIR: ${logDir}`);
          }

          await deps.auditLog({
            platform,
            stage: "Scan",
            action: "SCAN_END",
            status: "OK",
            details: {
              jobId: job.jobId,
              requestId: job.jobId,
              stage: "persist",
              platform,
              updatedThreads: platformUpdatedThreads,
              processed: platformUpdatedThreads,
              skipped: Math.max(0, candidatesCount - platformUpdatedThreads),
              totalFound:
                typeof collectionMetrics?.totalFound === "number"
                  ? (collectionMetrics.totalFound as number)
                  : candidatesBeforeCap,
              unreadFound:
                typeof collectionMetrics?.unreadFound === "number"
                  ? (collectionMetrics.unreadFound as number)
                  : candidatesCount,
              iterations:
                typeof collectionMetrics?.iterations === "number" ? (collectionMetrics.iterations as number) : undefined,
              stopReason:
                typeof collectionMetrics?.stopReason === "string" ? (collectionMetrics.stopReason as string) : undefined,
              candidates: candidatesCount,
              threadFailures,
              threadFailureKinds
            }
          });
          retryController.markSuccess(platform);
          runError = undefined;
          runSuccess = true;
        } catch (error) {
          runError = error;
          if (await markAborted("platform_error", platform)) {
            runStopReason = "aborted";
            return;
          }
          const firstStackLine =
            error instanceof Error && typeof error.stack === "string"
              ? error.stack.split("\n")[0] ?? error.message
              : String(error);

          if (error instanceof AdapterFailure) {
            runLogger.copyFailureArtifacts({
              screenshotPath: resolveFailureArtifactPath({
                artifactName: error.screenshotFile,
                type: "screenshot"
              }),
              domDumpPath: resolveFailureArtifactPath({
                artifactName: error.domDumpFile,
                type: "dom"
              })
            });

            const failureKind = resolveAdapterFailureKind(error);
            const resolvedFailureKind = failureKind ?? "UNKNOWN";
            const message = extractFailureMessage(error, error.message);
            const failureReason = extractFailureReason(error, message);
            const failureStage = error.stage ?? "collect_threads";
            const requestId = job.jobId;
            const summarizedFailure = summarizeScanFailure({
              stage: failureStage,
              reason: failureReason,
              requestId,
              message
            });
            runStopReason = failureReason ?? "scan_fail";
            headline("SCAN_END_FAIL", "scan failed", {
              stage: failureStage,
              reason: runStopReason,
              error: firstStackLine,
              LOG_DIR: logDir
            });
            if (logDir) {
              headline("SCAN_END_FAIL", `LOG_DIR: ${logDir}`);
            }

            if (shouldStopScanForFailureKind(failureKind)) {
              await setPlatformStatus({
                platform,
                status: "NOT_CONNECTED",
                lastError: summarizedFailure
              });

              await deps.auditLog({
                platform,
                stage: "Scan",
                action: "SCAN_AUTH_REQUIRED",
                status: "FAIL",
                details: {
                  jobId: job.jobId,
                  requestId,
                  stage: failureStage,
                  platform,
                  message,
                  reason: failureReason ?? "unknown",
                  failureKind: resolvedFailureKind,
                  errorStack: error.stack,
                  innerError: extractInnerError(error),
                  stageReceipts: adapterErrorDetails(error).stageReceipts,
                  runtimeContext: adapterErrorDetails(error).runtimeContext
                },
                screenshotFile: error.screenshotFile,
                domDumpFile: error.domDumpFile
              });
              return;
            }

            await markPlatformFailure({
              platform,
              status: "DEGRADED",
              failureReason,
              summary: summarizedFailure,
              requestId,
              stage: failureStage,
              message,
              adapterError: error,
              error,
              action: resolvedFailureKind === "SELECTOR_MISMATCH" ? "SELECTOR_FAIL" : "SCAN_FAIL",
              failureKind: resolvedFailureKind,
              runLogger
            });
          } else {
            const message = error instanceof Error ? error.message : String(error);
            const requestId = job.jobId;
            const reason = classifyFailureReason({
              message,
              details: {}
            });
            runStopReason = reason;
            const summarizedFailure = summarizeScanFailure({
              stage: "collect_threads",
              reason,
              requestId,
              message
            });
            headline("SCAN_END_FAIL", "scan failed", {
              stage: "collect_threads",
              reason,
              error: firstStackLine,
              LOG_DIR: logDir
            });
            if (logDir) {
              headline("SCAN_END_FAIL", `LOG_DIR: ${logDir}`);
            }
            await markPlatformFailure({
              platform,
              status: "ERROR",
              failureReason: reason,
              summary: summarizedFailure,
              requestId,
              stage: "collect_threads",
              message,
              error,
              action: "SCAN_FAIL",
              failureKind: "UNKNOWN",
              runLogger
            });
          }
        } finally {
          traceAwareAdapter.setRunLogger?.(null);
          activeRunLoggerByPlatform.delete(platform);
          runLogger.mergeCounters({
            candidatesToOpenCount: candidatesCount,
            openedThreadsCount,
            messagesParsedCount,
            threadFailures,
            threadFailureKinds,
            updatedThreads: platformUpdatedThreads,
            unreadCandidatesCount
          });
          if (runStopReason) {
            runLogger.setStopReason(runStopReason);
          }
          const summary = runLogger.flush({
            success: runSuccess,
            stopReason: runStopReason,
            error: runError
          });
          latestRunSummaryByPlatform.set(platform, summary);
        }
      });

      if (aborted) {
        break;
      }
    }

    if (aborted) {
      clearAbort();
    }

    deps.eventBus.emit({
      type: "SCAN_FINISHED",
      jobId: job.jobId,
      platform: job.platform,
      updatedThreads
    });

    return {
      jobId: job.jobId,
      updatedThreads
    };
  }

  const minValidTimestampMs = Date.UTC(2005, 0, 1, 0, 0, 0, 0);
  const maxFutureSkewMs = 5 * 60 * 1_000;

  function isPlausibleTimestamp(date: Date): boolean {
    const value = date.getTime();
    if (Number.isNaN(value)) {
      return false;
    }
    if (value < minValidTimestampMs) {
      return false;
    }
    if (value > Date.now() + maxFutureSkewMs) {
      return false;
    }
    return true;
  }

  function parseCandidateListTimestamp(raw: string | undefined): Date | null {
    if (!raw) {
      return null;
    }
    const parsedList = parseLinkedInListTimestamp(raw, new Date());
    if (parsedList && isPlausibleTimestamp(parsedList)) {
      return parsedList;
    }
    const parsed = new Date(raw);
    if (!isPlausibleTimestamp(parsed)) {
      return null;
    }
    return parsed;
  }

  function normalizeMessageTimestamp(raw: string | undefined, fallback: Date): Date {
    const normalized = (raw ?? "").trim();
    if (!normalized) {
      return fallback;
    }

    if (/^-?\d+(\.\d+)?$/.test(normalized)) {
      const numeric = Number(normalized);
      if (Number.isFinite(numeric)) {
        const asMs = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
        const parsedNumeric = new Date(asMs);
        if (isPlausibleTimestamp(parsedNumeric)) {
          return parsedNumeric;
        }
      }
    }

    const parsed = new Date(normalized);
    if (isPlausibleTimestamp(parsed)) {
      return parsed;
    }

    const parsedList = parseLinkedInListTimestamp(normalized, new Date());
    if (parsedList && isPlausibleTimestamp(parsedList)) {
      return parsedList;
    }

    return fallback;
  }

  function resolvePlatformThreadId(platform: PlatformName, candidate: ThreadStub): string | null {
    const rawCandidateId = cleanText(candidate.platformThreadId);
    if (!rawCandidateId) {
      return null;
    }

    if (platform !== "LINKEDIN") {
      return rawCandidateId;
    }

    const canonical = normalizeCanonicalLinkedInThreadId({
      platformThreadId: rawCandidateId,
      threadUrl: candidate.threadUrl,
      activeKey: rawCandidateId
    });
    if (!canonical || isTemporaryLinkedInId(canonical)) {
      return null;
    }
    return canonical;
  }

  async function syncThread(
    platform: PlatformName,
    candidate: ThreadStub,
    maxMessages: number,
    jobId: string,
    runLogger?: RunLogger,
    preParsedMessages?: NormalizedMessage[]
  ): Promise<{ updatedThreads: number; parsedMessages: number }> {
    const candidateListTimestamp = parseCandidateListTimestamp(candidate.lastMessageAt);
    const adapter = deps.adapters[platform];

    await deps.auditLog({
      platform,
      stage: "Parse",
      action: "THREAD_PARSE_START",
      status: "OK",
      details: {
        requestId: jobId,
        jobId,
        stage: "parse",
        candidatePlatformThreadId: candidate.platformThreadId,
        candidateThreadUrl: candidate.threadUrl ?? null,
        candidateDisplayName: candidate.displayName
      }
    });
    runLogger?.logAction({
      stage: "read_thread",
      action: "thread_parse_start",
      result: "ok",
      note: `${candidate.displayName} (${candidate.platformThreadId})`
    });

    const messages = preParsedMessages ?? (await adapter.fetchThreadMessages(candidate, maxMessages));
    const canonicalPlatformThreadId = resolvePlatformThreadId(platform, candidate);

    if (platform === "LINKEDIN" && !canonicalPlatformThreadId) {
      await deps.auditLog({
        platform,
        stage: "Persist",
        action: "THREAD_SKIPPED",
        status: "FAIL",
        details: {
          requestId: jobId,
          jobId,
          stage: "persist",
          reason: "unresolved_thread_id_after_open",
          candidatePlatformThreadId: candidate.platformThreadId,
          candidateThreadUrl: candidate.threadUrl ?? null,
          candidateDisplayName: candidate.displayName
        }
      });
      runLogger?.logDecision({
        stage: "persist",
        level: "warn",
        decision: "Skipped LinkedIn persistence due to unresolved canonical thread ID after open",
        details: {
          reason: "unresolved_thread_id_after_open",
          candidatePlatformThreadId: candidate.platformThreadId,
          candidateThreadUrl: candidate.threadUrl ?? null
        }
      });
      return {
        updatedThreads: 0,
        parsedMessages: 0
      };
    }

    if (canonicalPlatformThreadId) {
      candidate.platformThreadId = canonicalPlatformThreadId;
    }

    const person =
      (await prisma.person.findFirst({ where: { displayName: candidate.displayName, platform } })) ??
      (await prisma.person.create({
        data: {
          displayName: candidate.displayName,
          platform
        }
      }));

    const existing = await prisma.thread.findUnique({
      where: {
        platform_platformThreadId: {
          platform,
          platformThreadId: candidate.platformThreadId
        }
      }
    });

    const thread =
      existing ??
      (await prisma.thread.create({
        data: {
          platform,
          platformThreadId: candidate.platformThreadId,
          personId: person.id,
          threadUrl: candidate.threadUrl,
          unreadCount: candidate.unreadCount ?? 0,
          lastMessagePreview: cleanText(candidate.lastMessagePreview ?? ""),
          lastMessageAt: candidateListTimestamp ?? undefined,
          needsReply: Boolean(candidate.needsReplyFromList)
        }
      }));

    await deps.auditLog({
      platform,
      stage: "Parse",
      action: "THREAD_PARSE_COLLECTED",
      status: "OK",
      details: {
        requestId: jobId,
        jobId,
        stage: "parse",
        threadId: thread.id,
        platformThreadId: candidate.platformThreadId,
        collectedCount: messages.length
      }
    });
    runLogger?.logAction({
      stage: "read_thread",
      action: "thread_parse_collected",
      result: "ok",
      counts: {
        messageCount: messages.length
      },
      note: candidate.displayName
    });

    const timestampFallback = candidateListTimestamp ?? new Date();
    for (const message of messages) {
      const safeTimestamp = normalizeMessageTimestamp(message.timestamp, timestampFallback);
      const key =
        message.platformMessageKey ??
        stableHash(`${thread.id}|${safeTimestamp.toISOString()}|${message.direction}|${cleanText(message.text)}`);

      await prisma.message.upsert({
        where: {
          threadId_platformMessageKey: {
            threadId: thread.id,
            platformMessageKey: key
          }
        },
        update: {
          text: cleanText(message.text),
          direction: message.direction,
          timestamp: safeTimestamp,
          attachmentsJson: message.attachments.length ? JSON.stringify(message.attachments) : null,
          senderName: message.senderName ?? null,
          rawJson: message.raw ? JSON.stringify(message.raw) : null
        },
        create: {
          threadId: thread.id,
          platformMessageKey: key,
          direction: message.direction,
          timestamp: safeTimestamp,
          text: cleanText(message.text),
          attachmentsJson: message.attachments.length ? JSON.stringify(message.attachments) : null,
          senderName: message.senderName ?? null,
          rawJson: message.raw ? JSON.stringify(message.raw) : null
        }
      });
    }

    const [latestMessagesDesc, aggregateAny, aggregateInbound, aggregateOutbound, lastInboundMessage] = await Promise.all([
      prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { timestamp: "desc" },
        take: maxMessages
      }),
      prisma.message.aggregate({
        where: { threadId: thread.id },
        _max: { timestamp: true }
      }),
      prisma.message.aggregate({
        where: { threadId: thread.id, direction: "IN" },
        _max: { timestamp: true }
      }),
      prisma.message.aggregate({
        where: { threadId: thread.id, direction: "OUT" },
        _max: { timestamp: true }
      }),
      prisma.message.findFirst({
        where: { threadId: thread.id, direction: "IN" },
        orderBy: { timestamp: "desc" }
      })
    ]);

    const latestMessages = [...latestMessagesDesc].reverse();
    const resolvedLastMessageAt = aggregateAny._max.timestamp ?? candidateListTimestamp;
    const resolvedLastInboundAt = aggregateInbound._max.timestamp ?? null;
    const resolvedLastOutboundAt = aggregateOutbound._max.timestamp ?? null;
    const hasPersistedMessages = Boolean(aggregateAny._max.timestamp);
    const messageDerivedNeedsReply = Boolean(
      resolvedLastInboundAt && (!resolvedLastOutboundAt || resolvedLastInboundAt > resolvedLastOutboundAt)
    );
    const resolvedNeedsReply = hasPersistedMessages ? messageDerivedNeedsReply : Boolean(candidate.needsReplyFromList);
    const lastMessage = latestMessagesDesc[0];
    const resolvedLastMessagePreview = cleanText(
      candidate.lastMessagePreview ?? lastMessage?.text ?? thread.lastMessagePreview ?? ""
    );

    const settings = await deps.settingsStore.getSettings();
    const risk = calculateRisk({
      lastInboundAt: resolvedLastInboundAt,
      lastOutboundAt: resolvedLastOutboundAt,
      amberHours: settings.amberHours,
      redHours: settings.redHours
    });

    const lastInboundHash = lastInboundMessage
      ? stableHash(`${lastInboundMessage.timestamp.toISOString()}|${cleanText(lastInboundMessage.text)}`)
      : null;

    const shouldRefreshSummary = !!lastInboundHash && lastInboundHash !== thread.lastInboundHash;

    let summary = thread.rollingSummary;
    let whatTheyWant = thread.whatTheyWant;
    let openLoopsJson = thread.openLoopsJson;
    let toneNotesJson = thread.toneNotesJson;

    if (shouldRefreshSummary) {
      const aiSummary = await deps.aiService.updateThreadSummary({
        displayName: person.displayName,
        previousSummary: thread.rollingSummary ?? undefined,
        previousOpenLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
        messages: latestMessages.map((message) => ({
          direction: message.direction,
          text: message.text,
          timestamp: message.timestamp.toISOString()
        }))
      });

      summary = aiSummary.summary;
      whatTheyWant = aiSummary.what_they_want;
      openLoopsJson = JSON.stringify(aiSummary.open_loops);
      toneNotesJson = JSON.stringify(aiSummary.tone_notes);
    }

    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        personId: person.id,
        threadUrl: candidate.threadUrl ?? thread.threadUrl,
        unreadCount: candidate.unreadCount ?? thread.unreadCount,
        lastMessagePreview: resolvedLastMessagePreview || null,
        lastMessageAt: resolvedLastMessageAt,
        lastInboundAt: resolvedLastInboundAt,
        lastOutboundAt: resolvedLastOutboundAt,
        lastInboundHash,
        riskLevel: risk.level,
        slaDueAt: risk.slaDueAt,
        riskReason: hasPersistedMessages
          ? risk.riskReason
          : resolvedNeedsReply
            ? "Awaiting reply (list preview signal)"
            : risk.riskReason,
        needsReply: resolvedNeedsReply,
        rollingSummary: summary,
        whatTheyWant,
        openLoopsJson,
        toneNotesJson
      }
    });

    deps.eventBus.emit({
      type: "THREAD_UPDATED",
      jobId,
      threadId: thread.id
    });

    await deps.auditLog({
      platform,
      stage: "Parse",
      action: "THREAD_UPDATED",
      status: "OK",
      details: {
        requestId: jobId,
        jobId,
        stage: "persist",
        threadId: thread.id,
        platformThreadId: candidate.platformThreadId,
        messageCount: latestMessages.length,
        needsReply: resolvedNeedsReply
      }
    });
    runLogger?.logAction({
      stage: "persist",
      action: "thread_updated",
      result: "ok",
      counts: {
        messageCount: latestMessages.length,
        needsReply: resolvedNeedsReply
      },
      note: candidate.displayName
    });

    return {
      updatedThreads: 1,
      parsedMessages: messages.length
    };
  }

  return {
    enqueueScan,
    getCooldownStatus: (platform?: PlatformName) => retryController.getCooldown(platform),
    isRunTraceEnabled: () => process.env.RUN_TRACE === "1" || process.env.RUN_TRACE?.toLowerCase() === "true",
    getRunTraceBaseDir: () => runTraceBaseDir,
    getLatestRunSummary: (platform?: PlatformName): RunTraceSummary | undefined => {
      if (platform) {
        return latestRunSummaryByPlatform.get(platform);
      }
      const first = allPlatforms
        .map((name) => latestRunSummaryByPlatform.get(name))
        .find((summary) => Boolean(summary));
      return first;
    },
    processNext,
    getQueueDepth,
    isScanning: () => processing,
    startScheduler,
    runJob,
    requestAbort: (reason: string) => {
      abortVersion += 1;
      abortReason = reason;
      queue.length = 0;
    },
    syncThreadForIngest: (
      input: {
        platform: PlatformName;
        candidate: ThreadStub;
        maxMessages: number;
        requestId: string;
        runLogger?: RunLogger;
        messages?: NormalizedMessage[];
      }
    ) =>
      syncThread(
        input.platform,
        input.candidate,
        input.maxMessages,
        input.requestId,
        input.runLogger,
        input.messages
      ),
    clearAbort
  };

  function clearAbort(): void {
    abortReason = null;
  }
}
