import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { NormalizedMessage, PlatformName, SelectorRegistry, ThreadStub } from "@inbox-os/core";
import { prisma } from "./db";
import { resolveConnectTimeoutMs, runnerConfig } from "./config";
import { ensurePathInside } from "./utils/fs";
import { createSettingsStore } from "./services/settings";
import { createAuditService } from "./services/audit";
import { createEventBus } from "./services/event-bus";
import { createAiService } from "./services/ai";
import { createSelectorTestStore } from "./services/selector-report-store";
import { createSelectorTestService, isSelectorTestServiceError } from "./services/selector-tests";
import { extractFailureUrl, resolveConnectFailureResponse } from "./services/failure-routing";
import { createAdapters } from "./services/platform-factory";
import { createScanQueue } from "./services/scan-queue";
import { createSendService } from "./services/send";
import { createSendQueue } from "./services/send-queue";
import {
  AdminResetGuardError,
  resetPlatformInboxGraph,
  validateAdminResetGuards
} from "./services/admin-reset";
import { cleanupDemoData, seedDemoData } from "./services/demo";
import { createKeyedMutex } from "./services/keyed-mutex";
import { createRunLogger } from "./services/run-logger";
import {
  createLinkedInSmokeLogger,
  writeLatestLinkedInSmokePointer
} from "./services/linkedin-smoke-logger";
import { AdapterFailure } from "./platforms/utils";
import type { LinkedInSmokeIngestResult, LinkedInSmokePersistInput } from "./platforms/linkedin-adapter";
import {
  shapeThreadRows,
  toInboxRow,
  type ThreadRowSource
} from "./services/thread-row-shaping";

const app = express();
app.use(express.json({ limit: "1mb" }));

const settingsStore = createSettingsStore();
const auditService = createAuditService();
const eventBus = createEventBus();
const aiService = createAiService();
const selectorReports = createSelectorTestStore();

const { adapters, resolveSelectorsForPlatform, sessionManager } = createAdapters({
  settingsStore,
  onConnectStep: async (input) => {
    await auditService.log({
      platform: input.platform,
      stage: "Connect",
      action: input.action,
      status: input.status,
      details: input.details
    });
  },
  onPersonalProfileFallback: async (input) => {
    await auditService.log({
      platform: input.platform,
      stage: "Connect",
      action: "PERSONAL_PROFILE_FALLBACK",
      status: "OK",
      details: {
        reason: input.reason,
        personalChromeUserDataDir: input.personalChromeUserDataDir,
        personalChromeLaunchUserDataDir: input.personalChromeLaunchUserDataDir,
        personalChromeProfileDirectory: input.personalChromeProfileDirectory,
        personalChromeProfileName: input.personalChromeProfileName,
        personalChromeProfileResolutionStrategy: input.personalChromeProfileResolutionStrategy,
        mirrorResult: input.mirrorResult,
        fallbackProfileDir: input.fallbackProfileDir
      }
    });

    eventBus.emit({
      type: "PERSONAL_PROFILE_FALLBACK",
      jobId: uuid(),
      platform: input.platform,
      reason: input.reason
    });
  }
});

const selectorTestService = createSelectorTestService({
  resolveSelectors: resolveSelectorsForPlatform,
  sessionManager,
  screenshotDir: runnerConfig.screenshotDir,
  domDumpDir: runnerConfig.domDumpDir,
});

const operationMutex = createKeyedMutex();
const defaultPersonKey = "default";
const allPlatforms: PlatformName[] = ["LINKEDIN", "INSTAGRAM", "TIKTOK"];

type ScanQueueWithSmokeIngest = ReturnType<typeof createScanQueue> & {
  syncThreadForIngest: (input: {
    platform: PlatformName;
    candidate: ThreadStub;
    maxMessages: number;
    requestId: string;
    messages?: NormalizedMessage[];
  }) => Promise<{ updatedThreads: number; parsedMessages: number }>;
};

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

const sendService = createSendService({
  adapters,
  eventBus,
  settingsStore,
  auditLog: (input) => auditService.log(input)
});

// Async send worker. The /control/thread/:id/send endpoint inserts a PENDING
// SendRequest and kicks the worker; the worker drains the queue serially in
// the background. This decouples the dashboard's request (must return in
// <30s due to Next.js's rewrite proxy timeout) from the runner's actual
// send (can take 30s+ when an auto-login is needed first).
const sendQueue = createSendQueue({
  sendService,
  eventBus
});
// Pick up any SendRequests left in PENDING from a previous runner process
// (e.g. crashed mid-send, or restarted while a send was queued behind a
// scan). The queue's `running` guard prevents duplicate processing.
sendQueue.resume();

const connectInFlight = new Map<PlatformName, Promise<void>>();

function platformLockKey(platform: PlatformName): string {
  return `${defaultPersonKey}:${platform}`;
}

function globalResetLockKey(): string {
  return `${defaultPersonKey}:GLOBAL_RESET`;
}

async function withPlatformControlLock<T>(platform: PlatformName, work: () => Promise<T>): Promise<T> {
  return operationMutex.runExclusive(platformLockKey(platform), work);
}

async function withGlobalResetLock<T>(work: () => Promise<T>): Promise<T> {
  return operationMutex.runExclusive(globalResetLockKey(), work);
}

function parsePlatform(value: unknown): PlatformName {
  const parsed = z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]).parse(value);
  return parsed;
}

interface ControlTraceContext {
  requestId: string;
  startedAt: number;
  stage: string;
  platform?: PlatformName;
  method: string;
  path: string;
}

function maybeParsePlatform(value: unknown): PlatformName | undefined {
  if (value !== "LINKEDIN" && value !== "INSTAGRAM" && value !== "TIKTOK") {
    return undefined;
  }
  return value;
}

function normalizeOptionalPositiveNumber(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeControlPath(path: string): string {
  return path.replace(/\/thread\/[^/]+/g, "/thread/:threadId");
}

function stageForControlPath(path: string): string {
  if (path.startsWith("/platform/connect") || path.startsWith("/platform/open-browser") || path.startsWith("/platform/reset-session")) {
    return "Connect";
  }
  if (
    path.startsWith("/platform/test-selectors") ||
    path.startsWith("/platform/save-selector-override") ||
    path.startsWith("/platform/reset-selector-override")
  ) {
    return "Scan";
  }
  if (path.startsWith("/thread/") && path.endsWith("/transform")) {
    return "AI";
  }
  if (path.startsWith("/thread/") && (path.endsWith("/send") || path.endsWith("/mark-done"))) {
    return "Send";
  }
  if (path.startsWith("/thread/") && path.endsWith("/open")) {
    return "Connect";
  }
  return "Scan";
}

function buildControlAction(method: string, path: string, phase: "START" | "END" | "ABORT" | "ERROR"): string {
  const normalized = normalizeControlPath(path)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  const suffix = normalized || "ROOT";
  return `${method.toUpperCase()}_${suffix}_${phase}`;
}

function summarizeControlBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { bodyType: typeof body };
  }

  const record = body as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    bodyKeys: Object.keys(record).slice(0, 12)
  };

  if (typeof record.platform === "string") {
    summary.platform = record.platform;
  }
  if (typeof record.mode === "string") {
    summary.mode = record.mode;
  }
  if (typeof record.key === "string") {
    summary.key = record.key;
  }
  if (typeof record.hours === "number") {
    summary.hours = record.hours;
  }
  if (typeof record.selector === "string") {
    summary.selectorLength = record.selector.length;
  }
  if (typeof record.text === "string") {
    summary.textLength = record.text.length;
  }
  if (typeof record.clientSendId === "string") {
    summary.hasClientSendId = true;
  }

  return summary;
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const rawCause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
    const cause = rawCause === undefined ? undefined : summarizeError(rawCause);
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause
    };
  }

  return {
    message: String(error)
  };
}

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

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function summarizeFailureDetails(details: Record<string, unknown> | undefined): {
  requestId?: string;
  stage?: string;
  reason?: string;
  errorSummary?: string;
} {
  if (!details) {
    return {};
  }

  const nestedMessage = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
    return undefined;
  };

  const message =
    (typeof details.message === "string" && details.message.trim() ? details.message : undefined) ??
    nestedMessage(details.innerError) ??
    nestedMessage(details.error);
  const stage = typeof details.stage === "string" ? details.stage : undefined;
  const reason = typeof details.reason === "string" ? details.reason : undefined;
  const requestId = typeof details.requestId === "string" ? details.requestId : undefined;

  return {
    requestId,
    stage,
    reason,
    errorSummary: message
  };
}

function connectTimeoutMsForCurrentProfile(): number {
  return resolveConnectTimeoutMs(runnerConfig.browserProfile.mode, process.env);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function getControlTrace(res: express.Response): ControlTraceContext | undefined {
  return res.locals.controlTrace as ControlTraceContext | undefined;
}

function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function rankRisk(level: string): number {
  if (level === "RED") {
    return 3;
  }
  if (level === "AMBER") {
    return 2;
  }
  return 1;
}

async function ensureRuntimeDirs(): Promise<void> {
  await mkdir(runnerConfig.screenshotDir, { recursive: true });
  await mkdir(runnerConfig.domDumpDir, { recursive: true });
  await mkdir(runnerConfig.profileDirs.LINKEDIN, { recursive: true });
  await mkdir(runnerConfig.profileDirs.INSTAGRAM, { recursive: true });
  await mkdir(runnerConfig.profileDirs.TIKTOK, { recursive: true });
  await mkdir(sessionManager.getProfileDir(defaultPersonKey), { recursive: true });
}

async function getThreadStub(threadId: string): Promise<{
  threadId: string;
  platform: PlatformName;
  platformThreadId: string;
  threadUrl?: string;
  displayName: string;
}> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { person: true }
  });

  if (!thread) {
    throw new Error("Thread not found");
  }

  return {
    threadId: thread.id,
    platform: thread.platform as PlatformName,
    platformThreadId: thread.platformThreadId,
    threadUrl: thread.threadUrl ?? undefined,
    displayName: thread.person.displayName
  };
}

async function loadVisibleThreadRows(options?: {
  /** When true, return ONLY archived threads. When false/undefined, return ONLY non-archived. */
  archived?: boolean;
}): Promise<ReturnType<typeof shapeThreadRows>> {
  const threads = await prisma.thread.findMany({
    where: options?.archived
      ? { archivedAt: { not: null } }
      : { archivedAt: null },
    include: {
      person: true,
      _count: {
        select: {
          messages: true
        }
      }
    }
  });

  return shapeThreadRows(threads as ThreadRowSource[]);
}

app.post("/admin/reset", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]).default("LINKEDIN"),
      confirm: z.string().trim().min(1),
      token: z.string().trim().optional()
    })
    .parse(req.body ?? {});

  const headerToken = req.header("x-admin-reset-token");
  try {
    validateAdminResetGuards({
      token: headerToken ?? payload.token,
      confirm: payload.confirm
    });
  } catch (error) {
    if (error instanceof AdminResetGuardError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code
      });
      return;
    }
    throw error;
  }

  const requestId = uuid();
  const resetResult = await withGlobalResetLock(async () => {
    scanQueue.requestAbort(`admin_reset:${payload.platform.toLowerCase()}`);
    connectInFlight.clear();
    try {
      for (const platform of allPlatforms) {
        await operationMutex.runExclusive(platformLockKey(platform), async () => undefined);
      }

      const result = await resetPlatformInboxGraph(payload.platform);
      await auditService.log({
        platform: payload.platform,
        stage: "System",
        action: "ADMIN_RESET",
        status: "OK",
        details: {
          requestId,
          platform: payload.platform,
          matchedThreadCount: result.matchedThreadCount,
          deleted: result.deleted
        }
      });

      return result;
    } finally {
      scanQueue.clearAbort();
    }
  });

  res.json({
    status: "ok",
    requestId,
    ...resetResult
  });
}));

app.use("/control", (req, res, next) => {
  const requestId = uuid();
  const startedAt = Date.now();
  const path = normalizeControlPath(req.path);
  const stage = stageForControlPath(path);
  const platform = maybeParsePlatform((req.body as Record<string, unknown> | undefined)?.platform);
  const requestMeta: ControlTraceContext = {
    requestId,
    startedAt,
    stage,
    platform,
    method: req.method,
    path
  };
  res.locals.controlTrace = requestMeta;

  const baseDetails = {
    requestId,
    method: req.method,
    path,
    stage,
    platform: platform ?? null,
    params: req.params,
    body: summarizeControlBody(req.body)
  };

  void auditService.log({
    platform,
    stage,
    action: buildControlAction(req.method, path, "START"),
    status: "OK",
    details: baseDetails
  });

  // eslint-disable-next-line no-console
  console.info(`[control:${requestId}] start ${req.method} ${path}${platform ? ` platform=${platform}` : ""}`);

  let settled = false;
  const finalize = (phase: "END" | "ABORT", status: "OK" | "FAIL"): void => {
    if (settled) {
      return;
    }
    settled = true;

    const durationMs = Date.now() - startedAt;
    void auditService.log({
      platform,
      stage,
      action: buildControlAction(req.method, path, phase),
      status,
      details: {
        ...baseDetails,
        durationMs,
        statusCode: res.statusCode
      }
    });

    // eslint-disable-next-line no-console
    console.info(
      `[control:${requestId}] ${phase.toLowerCase()} status=${status} code=${res.statusCode} durationMs=${durationMs}`
    );
  };

  res.on("finish", () => finalize("END", res.statusCode >= 400 ? "FAIL" : "OK"));
  res.on("close", () => {
    if (!res.writableEnded) {
      finalize("ABORT", "FAIL");
    }
  });

  next();
});

app.get("/health", asyncRoute(async (_req, res) => {
  const platforms = await prisma.platform.findMany();
  const lastScanAt = platforms
    .map((platform) => platform.lastScanAt)
    .filter(Boolean)
    .sort((a, b) => (a!.getTime() > b!.getTime() ? -1 : 1))[0];

  const runnerStatus = scanQueue.isScanning() ? "SCANNING" : "ONLINE";
  const connectedPlatforms = platforms.filter((platform) => platform.status === "CONNECTED").length;

  res.json({
    runnerStatus,
    lastScanAt: lastScanAt?.toISOString() ?? null,
    queueDepth: scanQueue.getQueueDepth(),
    connectedPlatforms
  });
}));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sinceEventId = Number(req.query.sinceEventId ?? req.header("last-event-id") ?? 0);
  const oldest = eventBus.oldestEventId();

  function writeEvent(event: unknown, eventId?: number, eventName?: string): void {
    if (eventId) {
      res.write(`id: ${eventId}\n`);
    }
    if (eventName) {
      res.write(`event: ${eventName}\n`);
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (sinceEventId > 0 && oldest > 0 && sinceEventId < oldest - 1) {
    const resyncEvent = eventBus.emit({
      type: "RESYNC_REQUIRED",
      jobId: uuid(),
      reason: "Event replay window exceeded"
    });
    writeEvent(resyncEvent, resyncEvent.eventId, resyncEvent.type);
  }

  const replayEvents = eventBus.listSince(sinceEventId);
  for (const event of replayEvents) {
    writeEvent(event, event.eventId, event.type);
  }

  const unsubscribe = eventBus.subscribe((event) => {
    writeEvent(event, event.eventId, event.type);
  });

  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

app.get("/artifacts/:type/:name", (req, res) => {
  const type = req.params.type;
  const name = req.params.name;

  let baseDir: string;
  if (type === "screenshots") {
    baseDir = runnerConfig.screenshotDir;
  } else if (type === "dom_dumps") {
    baseDir = runnerConfig.domDumpDir;
  } else {
    res.status(400).json({ error: "Invalid artifact type" });
    return;
  }

  try {
    const resolved = ensurePathInside(baseDir, name);
    if (!existsSync(resolved)) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }

    const contentType = resolved.endsWith(".png")
      ? "image/png"
      : resolved.endsWith(".jpg") || resolved.endsWith(".jpeg")
        ? "image/jpeg"
        : "text/html; charset=utf-8";

    res.setHeader("Content-Type", contentType);
    createReadStream(resolved).pipe(res);
  } catch {
    res.status(400).json({ error: "Invalid artifact name" });
  }
});

app.get("/data/settings", asyncRoute(async (_req, res) => {
  const settings = await settingsStore.getSettings();
  res.json(settings);
}));

app.post("/control/settings", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      scanIntervalSeconds: z.number().int().min(10).max(3600).optional(),
      amberHours: z.number().int().min(1).max(72).optional(),
      redHours: z.number().int().min(1).max(168).optional(),
      headless: z.boolean().optional(),
      maxMessagesPerThread: z.number().int().min(5).max(100).optional(),
      enabledPlatforms: z.array(z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"])).optional(),
      demoMode: z.boolean().optional(),
      recentThreadSweepCount: z.number().int().min(5).max(100).optional()
    })
    .parse(req.body);

  const previous = await settingsStore.getSettings();
  const next = await settingsStore.updateSettings(payload);

  if (!previous.demoMode && next.demoMode) {
    const previousManifest = await settingsStore.getDemoSeedManifest();
    if (previousManifest) {
      await cleanupDemoData(previousManifest, {
        screenshotDir: runnerConfig.screenshotDir,
        domDumpDir: runnerConfig.domDumpDir
      });
      await settingsStore.setDemoSeedManifest(null);
    }

    const manifest = await seedDemoData({
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir
    });
    await settingsStore.setDemoSeedManifest(manifest);
  }

  if (previous.demoMode && !next.demoMode) {
    const manifest = await settingsStore.getDemoSeedManifest();
    if (manifest) {
      await cleanupDemoData(manifest, {
        screenshotDir: runnerConfig.screenshotDir,
        domDumpDir: runnerConfig.domDumpDir
      });
      await settingsStore.setDemoSeedManifest(null);
    }
  }

  res.json(next);
}));

app.post("/control/scan", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]).optional(),
      maxThreads: z.number().nullable().optional(),
      maxOpens: z.number().nullable().optional(),
      forceFallback: z.boolean().nullable().optional()
    })
    .parse(req.body ?? {});

  const maxThreads = normalizeOptionalPositiveNumber(payload.maxThreads);
  const maxOpens = normalizeOptionalPositiveNumber(payload.maxOpens);
  const forceFallback = process.env.NODE_ENV !== "production" && payload.forceFallback === true;

  const requestId = getControlTrace(res)?.requestId ?? uuid();
  const queued = scanQueue.enqueueScan(payload.platform, {
    requestId,
    respectCooldown: true,
    maxThreads,
    maxOpens,
    forceFallback
  });
  const traceMeta = {
    runTraceEnabled: scanQueue.isRunTraceEnabled(),
    runTraceDir: scanQueue.isRunTraceEnabled() ? scanQueue.getRunTraceBaseDir() : null
  };
  if (!queued.ok) {
    await auditService.log({
      platform: payload.platform,
      stage: "Scan",
      action: queued.reason === "in_flight" ? "SCAN_BLOCKED_IN_FLIGHT" : "SCAN_BLOCKED_COOLDOWN",
      status: "OK",
      details: {
        requestId,
        reason: queued.reason,
        retryAfterSeconds: queued.retryAfterSeconds,
        scope: payload.platform ?? "ALL"
      }
    });

    res.status(200).json({
      ...queued,
      ...traceMeta
    });
    return;
  }

  await auditService.log({
    platform: payload.platform,
    stage: "Scan",
    action: "SCAN_START",
    status: "OK",
    details: {
      jobId: queued.jobId,
      requestId,
      scope: payload.platform ?? "ALL",
      lockPolicy: "queue_one"
    }
  });

  res.json({
    ...queued,
    ...traceMeta
  });
}));

app.post("/control/platform/connect", asyncRoute(async (req, res) => {
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]) }).parse(req.body);
  const platform = parsePlatform(payload.platform);
  const requestId = getControlTrace(res)?.requestId ?? uuid();
  const startedAt = Date.now();
  const connectTimeoutMs = connectTimeoutMsForCurrentProfile();

  await withPlatformControlLock(platform, async () => {
    await auditService.log({
      platform,
      stage: "Connect",
      action: "CONNECT_START",
      status: "OK",
      details: {
        requestId,
        profileMode: runnerConfig.browserProfile.mode,
        fallbackBehavior: runnerConfig.browserProfile.fallbackBehavior,
        syncMode: runnerConfig.browserProfile.personalProfileSyncMode,
        sourceUserDataDir: runnerConfig.browserProfile.personalChromeUserDataDir,
        launchUserDataDir: sessionManager.getProfileDir(defaultPersonKey),
        profileDirectory: runnerConfig.browserProfile.personalChromeProfileDirectory,
        profileName: runnerConfig.browserProfile.personalChromeProfileName,
        profileResolutionStrategy: runnerConfig.browserProfile.personalChromeProfileResolutionStrategy,
        timeoutBudgetMs: connectTimeoutMs
      }
    });

    try {
      const existingConnect = connectInFlight.get(platform);
      let connectPromise: Promise<void>;
      let reusedInFlight = false;

      if (existingConnect) {
        connectPromise = existingConnect;
        reusedInFlight = true;
      } else {
        let trackedPromise: Promise<void>;
        trackedPromise = adapters[platform].ensureConnected().finally(() => {
          if (connectInFlight.get(platform) === trackedPromise) {
            connectInFlight.delete(platform);
          }
        });
        connectInFlight.set(platform, trackedPromise);
        connectPromise = trackedPromise;
      }

      if (reusedInFlight) {
        await auditService.log({
          platform,
          stage: "Connect",
          action: "CONNECT_JOIN_INFLIGHT",
          status: "OK",
          details: {
            requestId,
            timeoutBudgetMs: connectTimeoutMs
          }
        });
      }

      await withTimeout(connectPromise, connectTimeoutMs, `CONNECT_${platform}`);
      const connectedAt = new Date();

      await prisma.platform.upsert({
        where: { name: platform },
        update: {
          status: "CONNECTED",
          connectedAt,
          lastError: null
        },
        create: {
          name: platform,
          status: "CONNECTED",
          connectedAt
        }
      });

      eventBus.emit({
        type: "PLATFORM_STATUS_CHANGED",
        jobId: uuid(),
        platform,
        status: "CONNECTED"
      });

      await auditService.log({
        platform,
        stage: "Connect",
        action: "CONNECT_OK",
        status: "OK",
        details: {
          requestId,
          durationMs: Date.now() - startedAt,
          profileMode: runnerConfig.browserProfile.mode,
          fallbackBehavior: runnerConfig.browserProfile.fallbackBehavior,
          syncMode: runnerConfig.browserProfile.personalProfileSyncMode,
          sourceUserDataDir: runnerConfig.browserProfile.personalChromeUserDataDir,
          launchUserDataDir: sessionManager.getProfileDir(defaultPersonKey),
          profileDirectory: runnerConfig.browserProfile.personalChromeProfileDirectory,
          profileName: runnerConfig.browserProfile.personalChromeProfileName,
          profileResolutionStrategy: runnerConfig.browserProfile.personalChromeProfileResolutionStrategy,
          timeoutBudgetMs: connectTimeoutMs
        }
      });

      res.json({
        status: "CONNECTED",
        connectedAt: connectedAt.toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = resolveConnectFailureResponse({
        message,
        error
      });
      const failureUrl = extractFailureUrl(error, message);

      await prisma.platform.upsert({
        where: { name: platform },
        update: {
          status: failure.platformStatus,
          lastError: message
        },
        create: {
          name: platform,
          status: failure.platformStatus,
          lastError: message
        }
      });

      await auditService.log({
        platform,
        stage: "Connect",
        action: "CONNECT_FAIL",
        status: "FAIL",
        details: {
          requestId,
          durationMs: Date.now() - startedAt,
          failureKind: failure.failureKind ?? "UNKNOWN",
          failureType: failure.failureType,
          failureUrl: failureUrl ?? null,
          profileMode: runnerConfig.browserProfile.mode,
          fallbackBehavior: runnerConfig.browserProfile.fallbackBehavior,
          syncMode: runnerConfig.browserProfile.personalProfileSyncMode,
          sourceUserDataDir: runnerConfig.browserProfile.personalChromeUserDataDir,
          launchUserDataDir: sessionManager.getProfileDir(defaultPersonKey),
          profileDirectory: runnerConfig.browserProfile.personalChromeProfileDirectory,
          profileName: runnerConfig.browserProfile.personalChromeProfileName,
          profileResolutionStrategy: runnerConfig.browserProfile.personalChromeProfileResolutionStrategy,
          timeoutBudgetMs: connectTimeoutMs,
          ...summarizeError(error)
        }
      });

      res.status(failure.httpStatus).json({
        error: message,
        failureType: failure.failureType
      });
    }
  });
}));

app.post("/control/platform/test-selectors", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]),
      key: z
        .enum([
          "thread_list",
          "thread_item",
          "unread_badge",
          "thread_snippet",
          "message_container",
          "message_item",
          "message_text",
          "composer_input",
          "send_button"
        ])
        .optional(),
      selector: z.string().min(1).optional()
    })
    .parse(req.body);

  await withPlatformControlLock(payload.platform, async () => {
    try {
      const report = await selectorTestService.run({
        platform: payload.platform,
        key: payload.key,
        selector: payload.selector
      });
      const { receipts, ...reportForStore } = report;

      selectorReports.setReport(reportForStore);

      await auditService.log({
        platform: payload.platform,
        stage: "Scan",
        action: "SELECTOR_TEST",
        status: report.results.every((result) => result.status === "PASS") ? "OK" : "FAIL",
        details: {
          reportId: report.reportId,
          requestId: report.reportId,
          stage: "persist",
          receipts: report.receipts,
          results: report.results
        }
      });

      eventBus.emit({
        type: "SELECTOR_TEST_RESULT",
        jobId: uuid(),
        platform: payload.platform,
        reportId: report.reportId
      });

      res.status(200).json({
        ok: true,
        reportId: report.reportId,
        platform: report.platform,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        results: report.results,
        receipts
      });
    } catch (error) {
      const defaultPayload = {
        ok: false as const,
        platform: payload.platform,
        stage: "persist",
        error: error instanceof Error ? error.message : String(error),
        requestId: uuid(),
        reason: undefined as string | undefined,
        receipts: [] as Array<Record<string, unknown>>
      };
      const failurePayload = isSelectorTestServiceError(error)
        ? error.payload
        : defaultPayload;

      await auditService.log({
        platform: payload.platform,
        stage: "Scan",
        action: "SELECTOR_FAIL",
        status: "FAIL",
        details: {
          ...failurePayload,
          source: "selector-test",
          stack: error instanceof Error ? error.stack : undefined,
          failureKind:
            error instanceof Error && "kind" in error
              ? (error as Record<string, unknown>).kind
              : failurePayload.reason ?? "UNKNOWN"
        }
      });

      const status = isSelectorTestServiceError(error)
        ? error.statusCode
        : /profile.*in use|already in use|singleton/i.test(defaultPayload.error)
          ? 409
          : /auth|login|required/i.test(defaultPayload.error)
            ? 401
            : 500;

      res.status(status).json(failurePayload);
    }
  });
}));

app.post("/control/platform/save-selector-override", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]),
      key: z.enum([
        "thread_list",
        "thread_item",
        "unread_badge",
        "thread_snippet",
        "message_container",
        "message_item",
        "message_text",
        "composer_input",
        "send_button"
      ]),
      selector: z.string().min(1)
    })
    .parse(req.body);

  await settingsStore.saveSelectorOverride(payload.platform, payload.key as keyof SelectorRegistry, payload.selector);
  res.json({ status: "ok" });
}));

app.post("/control/platform/reset-selector-override", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]),
      key: z.enum([
        "thread_list",
        "thread_item",
        "unread_badge",
        "thread_snippet",
        "message_container",
        "message_item",
        "message_text",
        "composer_input",
        "send_button"
      ])
    })
    .parse(req.body);

  await settingsStore.resetSelectorOverride(payload.platform, payload.key as keyof SelectorRegistry);
  res.json({ status: "ok" });
}));

app.post("/control/thread/:threadId/send", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z
    .object({
      text: z.string().min(1),
      clientSendId: z.string().uuid()
    })
    .parse(req.body);

  // Enqueue + kick. Returns in ~50ms (just inserting/checking a SendRequest
  // row) regardless of whether a scan is currently holding the platform
  // lease. The worker drains the row in the background and emits
  // MESSAGE_SENT / MESSAGE_SEND_FAILED events with the matching clientSendId
  // so the dashboard's optimistic UI can update without polling. Closing
  // the dashboard tab does not lose the send — the row is in the DB and
  // the worker keeps draining.
  try {
    const queueResult = await sendQueue.enqueueAndKick({
      threadId,
      text: payload.text,
      clientSendId: payload.clientSendId
    });
    res.json(queueResult);
  } catch (error) {
    await auditService.log({
      platform: "LINKEDIN",
      stage: "Send",
      action: "SEND_ENQUEUE_FAIL",
      status: "FAIL",
      details: {
        threadId,
        stage: "enqueue",
        ...summarizeError(error)
      }
    });
    throw error;
  }
}));

app.post("/control/thread/:threadId/open", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const target = await getThreadStub(threadId);

  await withPlatformControlLock(target.platform, async () => {
    try {
      await adapters[target.platform].openThread({
        platformThreadId: target.platformThreadId,
        displayName: target.displayName,
        lastMessagePreview: "",
        threadUrl: target.threadUrl
      });

      await auditService.log({
        platform: target.platform,
        stage: "Connect",
        action: "OPEN_THREAD",
        status: "OK",
        details: {
          threadId: target.threadId,
          platformThreadId: target.platformThreadId,
          stage: "open_thread"
        }
      });

      res.json({ status: "ok" });
    } catch (error) {
      await auditService.log({
        platform: target.platform,
        stage: "Connect",
        action: "OPEN_THREAD_FAIL",
        status: "FAIL",
        details: {
          threadId: target.threadId,
          platformThreadId: target.platformThreadId,
          stage: "open_thread",
          ...summarizeError(error)
        }
      });
      throw error;
    }
  });
}));

app.post("/control/thread/:threadId/rescan", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const target = await getThreadStub(threadId);
  const requestId = getControlTrace(res)?.requestId ?? uuid();
  const settings = await settingsStore.getSettings();

  // Per-thread rescan: open ONLY this thread and re-parse its messages,
  // instead of triggering a full-inbox scan via enqueueScan(). The full-
  // inbox path takes 30-90s on a populated inbox; opening one thread is
  // typically <5s. Wraps in the platform control lock so it serialises
  // against any in-flight scan / send / open-thread operation.
  const candidate: ThreadStub = {
    platformThreadId: target.platformThreadId,
    displayName: target.displayName,
    threadUrl: target.threadUrl,
    lastMessagePreview: ""
  };
  try {
    const result = await withPlatformControlLock(target.platform, async () => {
      return scanQueue.syncThreadForIngest({
        platform: target.platform,
        candidate,
        maxMessages: settings.maxMessagesPerThread,
        requestId
      });
    });
    await auditService.log({
      platform: target.platform,
      stage: "Scan",
      action: "RESCAN_THREAD",
      status: "OK",
      details: {
        requestId,
        threadId: target.threadId,
        platformThreadId: target.platformThreadId,
        scope: "single_thread",
        ...result
      }
    });
    res.json({
      ok: true,
      requestId,
      threadId: target.threadId,
      scope: "single_thread",
      ...result
    });
  } catch (error) {
    await auditService.log({
      platform: target.platform,
      stage: "Scan",
      action: "RESCAN_THREAD_FAIL",
      status: "FAIL",
      details: {
        requestId,
        threadId: target.threadId,
        platformThreadId: target.platformThreadId,
        scope: "single_thread",
        ...summarizeError(error)
      }
    });
    throw error;
  }
}));

// Detects the static fallback that updateThreadSummary writes when the AI
// call fails (no API key / quota / model error). The /data/thread handler
// uses this to self-heal: if a thread's persisted summary still matches
// the fallback, regenerate inline before responding so the operator never
// has to click "Rescan" or call /resummarize manually.
function isStaleSummary(rollingSummary: string | null | undefined, displayName: string): boolean {
  if (!rollingSummary) {
    return true;
  }
  return rollingSummary === `Conversation with ${displayName}.`;
}

// Shared body for both /resummarize and /resummarize-stale. Fetches the
// thread, calls updateThreadSummary, persists the result. Returns false if
// the thread was missing.
async function resummarizeThreadById(threadId: string): Promise<
  | { ok: true; summary: string; whatTheyWant: string; openLoops: string[]; needsReply: boolean }
  | { ok: false; reason: "not_found" }
> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: {
        orderBy: { timestamp: "asc" },
        take: 120
      }
    }
  });
  if (!thread) {
    return { ok: false, reason: "not_found" };
  }

  const summary = await aiService.updateThreadSummary({
    displayName: thread.person.displayName,
    previousSummary: thread.rollingSummary ?? undefined,
    previousOpenLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
    messages: thread.messages.map((message) => ({
      direction: message.direction as "IN" | "OUT",
      text: message.text,
      timestamp: message.timestamp.toISOString()
    }))
  });

  await prisma.thread.update({
    where: { id: thread.id },
    data: {
      rollingSummary: summary.summary,
      whatTheyWant: summary.what_they_want,
      openLoopsJson: JSON.stringify(summary.open_loops),
      toneNotesJson: JSON.stringify(summary.tone_notes)
    }
  });

  return {
    ok: true,
    summary: summary.summary,
    whatTheyWant: summary.what_they_want,
    openLoops: summary.open_loops,
    needsReply: summary.needs_reply
  };
}

// Re-run AI summarization against the messages already in the DB. Useful
// when the persisted summary was generated by a previous run that fell back
// (e.g. quota was exhausted, model was wrong) — we don't need to hit the
// platform again, just re-summarize the local message history.
app.post("/control/thread/:threadId/resummarize", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const result = await resummarizeThreadById(threadId);
  if (!result.ok) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  res.json({
    ok: true,
    threadId,
    summary: result.summary,
    whatTheyWant: result.whatTheyWant,
    openLoops: result.openLoops,
    needsReply: result.needsReply
  });
}));

// Bulk resummarize every thread whose persisted summary still matches the
// static fallback (i.e. the AI call had failed when the row was last
// written). One-off cleanup tool for accounts that ran without quota /
// with a wrong model — no platform calls, just re-summarises local message
// history. Cap concurrency at 1 to avoid swamping OpenAI rate limits.
app.post("/control/resummarize-stale", asyncRoute(async (_req, res) => {
  const stale = await prisma.thread.findMany({
    where: {
      OR: [
        { rollingSummary: null },
        { rollingSummary: { startsWith: "Conversation with " } }
      ]
    },
    select: { id: true, rollingSummary: true, person: { select: { displayName: true } } }
  });

  // Filter to TRULY stale rows. The startsWith filter above is necessary
  // (Prisma can't compare a column against a computed string), but we want
  // to skip false positives — e.g. a thread whose name legitimately starts
  // with "Conversation with " is unlikely but possible.
  const targets = stale.filter((row) => isStaleSummary(row.rollingSummary, row.person.displayName));

  let ok = 0;
  let failed = 0;
  for (const target of targets) {
    const result = await resummarizeThreadById(target.id).catch(() => ({ ok: false as const, reason: "exception" as const }));
    if (result.ok) {
      ok += 1;
    } else {
      failed += 1;
    }
  }

  res.json({ ok: true, total: targets.length, refreshed: ok, failed });
}));

app.post("/control/thread/:threadId/transform", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      mode: z.enum(["SHORTEN", "MAKE_WARMER"]),
      text: z.string().min(1)
    })
    .parse(req.body);

  const text = await aiService.transformReply(payload);
  res.json({ text });
}));

app.get("/data/inbox", asyncRoute(async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const platform = typeof req.query.platform === "string" ? (req.query.platform as PlatformName) : undefined;
  const risk = typeof req.query.risk === "string" ? req.query.risk : undefined;
  const unreadOnly = req.query.unread === "true";
  const needsReplyOnly = req.query.needsReply === "true";

  const dedupedRows = (await loadVisibleThreadRows()).map((row) => toInboxRow(row));

  const rows = dedupedRows
    .filter((row) => {
      if (platform && row.platform !== platform) {
        return false;
      }
      if (risk && row.riskLevel !== risk) {
        return false;
      }
      if (unreadOnly && row.unreadCount <= 0) {
        return false;
      }
      if (needsReplyOnly && !row.needsReply) {
        return false;
      }
      if (search) {
        const haystack = `${row.personName} ${row.preview}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      // Bucket order: genuine first, uncategorised next, outreach last.
      // Sales pitches sink to the bottom so the operator sees real
      // relationships at the top of the list. Within each bucket we still
      // mirror LinkedIn's most-recent-first ordering.
      const rankCategory = (category: string | null): number => {
        if (category === "genuine") return 0;
        if (category === "outreach") return 2;
        return 1; // null / unknown — between genuine and outreach
      };
      const aBucket = rankCategory(a.category);
      const bBucket = rankCategory(b.category);
      if (aBucket !== bBucket) {
        return aBucket - bBucket;
      }
      const aTime = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const bTime = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      if (rankRisk(a.riskLevel) !== rankRisk(b.riskLevel)) {
        return rankRisk(b.riskLevel) - rankRisk(a.riskLevel);
      }
      if (a.unreadCount !== b.unreadCount) {
        return b.unreadCount - a.unreadCount;
      }
      return 0;
    });

  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const outboundLast7Days = await prisma.message.findMany({
    where: {
      direction: "OUT",
      timestamp: {
        gte: sevenDaysAgo
      }
    }
  });

  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const sentToday = outboundLast7Days.filter((msg) => msg.timestamp >= todayStart).length;

  const oldestPending = rows
    .filter((row) => row.needsReply && row.lastInboundAt)
    .sort((a, b) => Date.parse(a.lastInboundAt!) - Date.parse(b.lastInboundAt!))[0];

  const summary = {
    unreadThreads: rows.filter((row) => row.unreadCount > 0).length,
    atRiskThreads: rows.filter((row) => row.riskLevel !== "GREEN").length,
    averageReplyTimeHours: outboundLast7Days.length ? 4.2 : 0,
    oldestPendingInboundAt: oldestPending?.lastInboundAt ?? null,
    messagesSentToday: sentToday
  };

  res.json({ rows, summary });
}));

app.get("/data/thread/:threadId", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: {
        orderBy: { timestamp: "asc" },
        take: 120
      },
      drafts: {
        orderBy: { updatedAt: "desc" },
        take: 1
      }
    }
  });

  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  // Self-heal stale summary on demand. Threads written before the AI was
  // fully working still have rollingSummary === "Conversation with X." (the
  // static fallback). The user shouldn't have to click "Rescan" or run a
  // bulk script to fix that — when they open a stale thread, regenerate
  // before responding. First load is slow (~5-10s), every subsequent load
  // hits the cache. New threads from working scans are never stale, so
  // this branch is a one-time cost per legacy thread.
  if (isStaleSummary(thread.rollingSummary, thread.person.displayName)) {
    const refreshed = await resummarizeThreadById(thread.id).catch(() => null);
    if (refreshed && refreshed.ok) {
      thread.rollingSummary = refreshed.summary;
      thread.whatTheyWant = refreshed.whatTheyWant;
      thread.openLoopsJson = JSON.stringify(refreshed.openLoops);
    }
  }

  const lastInbound = [...thread.messages].reverse().find((msg) => msg.direction === "IN");
  const aiInputs = {
    summary: thread.rollingSummary ?? `Conversation with ${thread.person.displayName}.`,
    whatTheyWant: thread.whatTheyWant ?? "No clear ask yet.",
    openLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
    lastInboundMessage: lastInbound?.text ?? "",
    // Drives the "Polite decline" reply variant when the thread is outreach.
    category: (thread.category ?? null) as "outreach" | "genuine" | null
  };
  // Cache key over the four AI inputs. Hashing keeps the column short and
  // doesn't leak content into the audit log if anyone ever inspects it. As
  // long as none of these inputs change, replies stay valid — refresh()
  // calls on Save draft / Snooze / Mark done won't trigger a fresh OpenAI
  // hit, only a real conversation change does.
  const cacheKey = createHash("sha256")
    .update(`${aiInputs.summary}|${aiInputs.whatTheyWant}|${aiInputs.openLoops.join("")}|${aiInputs.lastInboundMessage}|${aiInputs.category ?? "_"}`)
    .digest("hex");

  let suggested;
  if (thread.suggestedRepliesCacheKey === cacheKey && thread.suggestedRepliesJson) {
    try {
      suggested = JSON.parse(thread.suggestedRepliesJson);
    } catch {
      // Corrupt cache row — fall through and regenerate.
      suggested = undefined;
    }
  }
  if (!suggested) {
    suggested = await aiService.generateSuggestedReplies(aiInputs);
    // Persist the cache. Best-effort — if the write fails, we still serve
    // the freshly-generated replies and just won't cache for next time.
    await prisma.thread
      .update({
        where: { id: thread.id },
        data: {
          suggestedRepliesJson: JSON.stringify(suggested),
          suggestedRepliesCacheKey: cacheKey
        }
      })
      .catch(() => undefined);
  }

  const receipts = await prisma.auditLog.findMany({
    where: {
      OR: [
        { detailsJson: { contains: thread.id } },
        { action: { in: ["SELECTOR_TEST", "SELECTOR_FAIL"] }, platform: thread.platform }
      ]
    },
    orderBy: { timestamp: "desc" },
    take: 120
  });

  res.json({
    id: thread.id,
    personName: thread.person.displayName,
    platform: thread.platform,
    riskLevel: thread.riskLevel,
    riskReason: thread.riskReason,
    unreadCount: thread.unreadCount,
    needsReply: thread.needsReply,
    summary: thread.rollingSummary,
    whatTheyWant: thread.whatTheyWant,
    openLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
    toneNotes: thread.toneNotesJson ? (JSON.parse(thread.toneNotesJson) as string[]) : [],
    draft: thread.drafts[0]?.text ?? "",
    contextUpdatedAt: thread.updatedAt.toISOString(),
    messages: thread.messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      timestamp: message.timestamp.toISOString(),
      text: message.text,
      senderName: message.senderName ?? null,
      raw: message.rawJson ? JSON.parse(message.rawJson) : null,
      attachments: message.attachmentsJson ? JSON.parse(message.attachmentsJson) : []
    })),
    suggestedReplies: suggested,
    receipts: receipts.map((log) => ({
      id: log.id,
      timestamp: log.timestamp.toISOString(),
      stage: log.stage,
      action: log.action,
      status: log.status,
      details: log.detailsJson ? JSON.parse(log.detailsJson) : null,
      screenshotFile: log.screenshotFile,
      domDumpFile: log.domDumpFile
    }))
  });
}));

app.get("/data/receipts", asyncRoute(async (req, res) => {
  const threadId = typeof req.query.threadId === "string" ? req.query.threadId : undefined;
  const limit = Number(req.query.limit ?? 100);

  const logs = await prisma.auditLog.findMany({
    where: threadId
      ? {
          OR: [{ detailsJson: { contains: threadId } }]
        }
      : undefined,
    orderBy: { timestamp: "desc" },
    take: Number.isNaN(limit) ? 100 : limit
  });

  res.json(
    logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp.toISOString(),
      platform: log.platform,
      stage: log.stage,
      action: log.action,
      status: log.status,
      details: log.detailsJson ? JSON.parse(log.detailsJson) : null,
      screenshotFile: log.screenshotFile,
      domDumpFile: log.domDumpFile
    }))
  );
}));

app.get("/data/platforms", asyncRoute(async (_req, res) => {
  const settings = await settingsStore.getSettings();
  const platforms = await prisma.platform.findMany({ orderBy: { name: "asc" } });
  const failureActions = ["SCAN_FAIL", "SELECTOR_FAIL", "SCAN_AUTH_REQUIRED"] as const;
  const recoveryActions = ["SCAN_END", "SELECTOR_TEST", "POST_SCAN_END", "POST_PLATFORM_TEST_SELECTORS_END"] as const;

  const data = await Promise.all(
    (["LINKEDIN", "INSTAGRAM", "TIKTOK"] as PlatformName[]).map(async (platform) => {
      const row = platforms.find((entry) => entry.name === platform);
      const sharedProfileDir = sessionManager.getProfileDir(defaultPersonKey);
      const [latestFailure, latestRecovery] = await Promise.all([
        prisma.auditLog.findFirst({
          where: {
            platform,
            status: "FAIL",
            action: { in: [...failureActions] }
          },
          orderBy: { timestamp: "desc" }
        }),
        prisma.auditLog.findFirst({
          where: {
            platform,
            status: "OK",
            action: { in: [...recoveryActions] }
          },
          orderBy: { timestamp: "desc" }
        })
      ]);
      const failureIsCurrent = Boolean(
        latestFailure && (!latestRecovery || latestFailure.timestamp.getTime() > latestRecovery.timestamp.getTime())
      );
      const failureDetails = parseJsonRecord(latestFailure?.detailsJson);
      const failureSummary = summarizeFailureDetails(failureDetails);

      return {
        platform,
        status: row?.status ?? "NOT_CONNECTED",
        lastScanAt: row?.lastScanAt?.toISOString() ?? null,
        connectedAt: row?.connectedAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        enabled: settings.enabledPlatforms.includes(platform),
        profileDir: sharedProfileDir,
        browserProfileMode: runnerConfig.browserProfile.mode,
        browserProfileSyncMode:
          runnerConfig.browserProfile.mode === "personal"
            ? runnerConfig.browserProfile.personalProfileSyncMode
            : null,
        browserProfileSourceUserDataDir:
          runnerConfig.browserProfile.mode === "personal"
            ? runnerConfig.browserProfile.personalChromeUserDataDir
            : null,
        browserProfileLaunchUserDataDir:
          runnerConfig.browserProfile.mode === "personal"
            ? sharedProfileDir
            : sharedProfileDir,
        browserProfileDirectory:
          runnerConfig.browserProfile.mode === "personal"
            ? runnerConfig.browserProfile.personalChromeProfileDirectory
            : null,
        browserProfileName:
          runnerConfig.browserProfile.mode === "personal"
            ? runnerConfig.browserProfile.personalChromeProfileName
            : null,
        browserProfileResolutionStrategy:
          runnerConfig.browserProfile.mode === "personal"
            ? runnerConfig.browserProfile.personalChromeProfileResolutionStrategy
            : null,
        latestSelectorReport: selectorReports.getLatestReport(platform),
        lastScanFailure: latestFailure && failureIsCurrent
          ? {
              requestId: failureSummary.requestId ?? latestFailure.id,
              stage: failureSummary.stage ?? latestFailure.stage ?? "collect_threads",
              reason: failureSummary.reason ?? undefined,
              errorSummary: failureSummary.errorSummary ?? row?.lastError ?? "LinkedIn scan failed",
              timestamp: latestFailure.timestamp.toISOString(),
              screenshotFile: latestFailure.screenshotFile ?? undefined,
              domDumpFile: latestFailure.domDumpFile ?? undefined
            }
          : undefined
      };
    })
  );

  res.json(data);
}));

app.get("/data/logs", asyncRoute(async (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  const logs = await prisma.auditLog.findMany({
    orderBy: { timestamp: "desc" },
    take: Number.isNaN(limit) ? 200 : limit
  });

  res.json(
    logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp.toISOString(),
      platform: log.platform,
      stage: log.stage,
      action: log.action,
      status: log.status,
      details: log.detailsJson ? JSON.parse(log.detailsJson) : null,
      screenshotFile: log.screenshotFile,
      domDumpFile: log.domDumpFile
    }))
  );
}));

// Manual category override. Lets the operator flip a thread's verdict from
// the dashboard when the classifier got it wrong (e.g. peer-to-peer industry
// chat that resembles a pitch). The runner does no AI work here — just
// writes the column and trusts the operator's judgement.
app.post("/control/thread/:threadId/recategorize", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z
    .object({
      category: z.enum(["outreach", "genuine"]).nullable()
    })
    .parse(req.body);
  const thread = await prisma.thread.update({
    where: { id: threadId },
    data: {
      category: payload.category,
      // Bust the suggested-replies cache so the third reply slot's intent
      // (Clarifying question vs Polite decline) regenerates next /data/thread fetch.
      suggestedRepliesCacheKey: null,
      suggestedRepliesJson: null
    }
  });
  res.json({ ok: true, threadId: thread.id, category: thread.category });
}));

// Bulk-classify any threads that don't have a category yet. Reuses the
// AI service's classifyThreadCategory helper. Decoupled from the scan
// flow so the operator can backfill existing threads without re-scanning
// LinkedIn — important after the Phase 3 schema rollout when 76+ threads
// already exist with category=null.
app.post("/control/classify-uncategorized", asyncRoute(async (req, res) => {
  // Optional `force: true` body re-classifies EVERY thread regardless of
  // existing category. Useful after a classifier prompt change to clear out
  // verdicts from the older, weaker version. Default is the additive
  // behaviour: only categorise threads that don't yet have a verdict.
  const payload = z
    .object({ force: z.boolean().optional() })
    .parse(req.body ?? {});
  const targets = await prisma.thread.findMany({
    where: payload.force ? {} : { category: null },
    include: {
      person: true,
      messages: {
        orderBy: { timestamp: "asc" },
        take: 10
      }
    }
  });

  let classified = 0;
  let skipped = 0;
  let failed = 0;
  for (const target of targets) {
    if (target.messages.length === 0) {
      skipped += 1;
      continue;
    }
    try {
      const category = await aiService.classifyThreadCategory({
        displayName: target.person.displayName,
        messages: target.messages.map((m) => ({
          direction: m.direction as "IN" | "OUT",
          text: m.text,
          timestamp: m.timestamp.toISOString()
        })),
        summary: target.rollingSummary ?? null,
        whatTheyWant: target.whatTheyWant ?? null
      });
      if (category) {
        await prisma.thread.update({
          where: { id: target.id },
          data: { category }
        });
        classified += 1;
      } else {
        skipped += 1;
      }
    } catch {
      failed += 1;
    }
  }

  res.json({ ok: true, total: targets.length, classified, skipped, failed });
}));

// Archive a thread. Sets archivedAt to now; the thread disappears from the
// default Inbox/At Risk/People views and only shows in the Archived view.
app.post("/control/thread/:threadId/archive", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const thread = await prisma.thread.update({
    where: { id: threadId },
    data: { archivedAt: new Date() }
  });
  res.json({ ok: true, threadId: thread.id, archivedAt: thread.archivedAt?.toISOString() });
}));

// Unarchive — clears archivedAt so the thread returns to the active Inbox.
app.post("/control/thread/:threadId/unarchive", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const thread = await prisma.thread.update({
    where: { id: threadId },
    data: { archivedAt: null }
  });
  res.json({ ok: true, threadId: thread.id });
}));

// Archived view counterpart to /data/inbox — same shape, only archived rows.
app.get("/data/archived", asyncRoute(async (_req, res) => {
  const rows = (await loadVisibleThreadRows({ archived: true }))
    .map((row) => toInboxRow(row))
    .sort((a, b) => {
      const aTime = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const bTime = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return bTime - aTime;
    });
  res.json({ rows });
}));

// Surface the persisted send queue so the dashboard can render a status bar
// instead of failing silently when the user clicks Send during a scan. The
// existing SendRequest model already persists every send through PENDING →
// SENT/FAILED, and the platform lease serializes sends against scans, so a
// click during a scan sits in PENDING until the lease frees up. This endpoint
// just exposes that state to the UI.
app.get("/data/send-queue", asyncRoute(async (_req, res) => {
  const [activeRows, recentDoneRows] = await Promise.all([
    prisma.sendRequest.findMany({
      where: { status: "PENDING" },
      include: {
        thread: {
          include: { person: true }
        }
      },
      orderBy: { createdAt: "asc" }
    }),
    // Show the last 5 completed sends so the bar can briefly say "Sent to X"
    // before fading out, and so a failed send is visible even if the user
    // misses the live transition.
    prisma.sendRequest.findMany({
      where: { status: { in: ["SENT", "FAILED"] } },
      include: {
        thread: {
          include: { person: true }
        }
      },
      orderBy: { updatedAt: "desc" },
      take: 5
    })
  ]);

  res.json({
    activeCount: activeRows.length,
    active: activeRows.map((row, index) => ({
      clientSendId: row.clientSendId,
      threadId: row.threadId,
      personName: row.thread.person.displayName,
      platform: row.thread.platform,
      status: row.status,
      requestText: row.requestText,
      enqueuedAt: row.createdAt.toISOString(),
      // 0 = currently being processed (the head of the queue); 1+ = queued
      // behind another send. The runner serializes sends through the platform
      // lease, so only one send can be IN_FLIGHT at a time.
      queuePosition: index
    })),
    recent: recentDoneRows.map((row) => {
      let errorPayload: unknown = null;
      if (row.errorJson) {
        try {
          errorPayload = JSON.parse(row.errorJson);
        } catch {
          errorPayload = null;
        }
      }
      return {
        clientSendId: row.clientSendId,
        threadId: row.threadId,
        personName: row.thread.person.displayName,
        platform: row.thread.platform,
        status: row.status,
        completedAt: row.updatedAt.toISOString(),
        errorMessage: errorPayload && typeof errorPayload === "object" && "message" in errorPayload
          ? (errorPayload as { message?: string }).message
          : undefined
      };
    })
  });
}));

app.get("/data/people", asyncRoute(async (_req, res) => {
  const [people, visibleThreadGroups] = await Promise.all([
    prisma.person.findMany({
      orderBy: {
        updatedAt: "desc"
      }
    }),
    loadVisibleThreadRows()
  ]);

  const groupedByPerson = new Map<string, ReturnType<typeof toInboxRow>[]>();
  for (const group of visibleThreadGroups) {
    const shaped = toInboxRow(group);
    const bucket = groupedByPerson.get(shaped.personId) ?? [];
    bucket.push(shaped);
    groupedByPerson.set(shaped.personId, bucket);
  }

  res.json(
    people.map((person) => {
      const rows = groupedByPerson.get(person.id) ?? [];
      const latest = rows
        .map((row) => row.lastMessageAt)
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
      const risk = rows.reduce<"GREEN" | "AMBER" | "RED">((highest, row) => {
        if (row.riskLevel === "RED") {
          return "RED";
        }
        if (row.riskLevel === "AMBER" && highest !== "RED") {
          return "AMBER";
        }
        return highest;
      }, "GREEN");

      const unresolvedThreadCount = rows.filter((row) => row.identityWarning === "unresolved_id").length;

      return {
        id: person.id,
        name: person.displayName,
        platform: person.platform,
        notes: person.notes,
        tags: person.tagsJson ? JSON.parse(person.tagsJson) : [],
        lastInteractionAt: latest,
        risk,
        hasUnresolvedIdentityWarning: unresolvedThreadCount > 0 || undefined,
        unresolvedThreadCount: unresolvedThreadCount || undefined
      };
    })
  );
}));

app.post("/control/platform/open-browser", asyncRoute(async (req, res) => {
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]) }).parse(req.body);
  await withPlatformControlLock(payload.platform, async () => {
    const adapter = adapters[payload.platform];
    await adapter.ensureConnected();
    res.json({ status: "ok" });
  });
}));

app.post("/control/platform/linkedin/smoke-unread", asyncRoute(async (_req, res) => {
  const requestId = getControlTrace(res)?.requestId ?? uuid();
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
    const result = await withPlatformControlLock("LINKEDIN", async () => {
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

    res.json({
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
    });
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

    res.status(500).json({
      ok: false,
      requestId,
      logDir,
      stage: failure.stage,
      reason: failure.reason,
      error: failure.error
    });
  } finally {
    linkedInAdapter.setRunLogger?.(null);
  }
}));

app.post("/control/thread/:threadId/draft", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z.object({ text: z.string().max(5000) }).parse(req.body);

  const existingDraft = await prisma.draft.findFirst({ where: { threadId } });

  if (existingDraft) {
    await prisma.draft.update({
      where: { id: existingDraft.id },
      data: { text: payload.text }
    });
  } else {
    await prisma.draft.create({
      data: {
        threadId,
        text: payload.text
      }
    });
  }

  res.json({ status: "ok" });
}));

app.post("/control/thread/:threadId/mark-done", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  await prisma.thread.update({
    where: { id: threadId },
    data: {
      needsReply: false,
      unreadCount: 0,
      riskLevel: "GREEN",
      riskReason: "Marked done manually",
      slaDueAt: null
    }
  });

  await auditService.log({
    action: "MARK_DONE",
    stage: "Send",
    status: "OK",
    details: { threadId }
  });

  res.json({ status: "ok" });
}));

app.post("/control/thread/:threadId/snooze", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z.object({ hours: z.number().int().min(1).max(72) }).parse(req.body);
  const due = new Date(Date.now() + payload.hours * 60 * 60 * 1000);

  await prisma.thread.update({
    where: { id: threadId },
    data: {
      slaDueAt: due,
      riskReason: "Snoozed for " + payload.hours + "h"
    }
  });

  await auditService.log({
    action: "SNOOZE",
    stage: "Scan",
    status: "OK",
    details: { threadId, hours: payload.hours }
  });

  res.json({ status: "ok", dueAt: due.toISOString() });
}));

app.post("/control/platform/reset-session", asyncRoute(async (req, res) => {
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK"]).optional() }).parse(req.body ?? {});

  await withGlobalResetLock(async () => {
    scanQueue.requestAbort("session_reset:manual");
    connectInFlight.clear();

    for (const platform of allPlatforms) {
      await operationMutex.runExclusive(platformLockKey(platform), async () => undefined);
    }

    const summary = await sessionManager.resetPersonSession({
      personKey: defaultPersonKey,
      reason: "manual_reset",
      clearProfileDir: true
    });

    for (const platform of allPlatforms) {
      await prisma.platform.upsert({
        where: { name: platform },
        update: {
          status: "NOT_CONNECTED",
          connectedAt: null,
          lastError: null
        },
        create: {
          name: platform,
          status: "NOT_CONNECTED"
        }
      });
    }

    await auditService.log({
      platform: payload.platform,
      stage: "Connect",
      action: "RESET_SESSION_SHARED",
      status: "OK",
      details: {
        resetScope: "PERSON_CONTEXT",
        personKey: summary.personKey,
        profileDir: summary.profileDir,
        clearedProfileDir: summary.clearedProfileDir
      }
    });

    res.json({
      status: "ok",
      resetScope: "PERSON_CONTEXT",
      personKey: summary.personKey,
      profileDir: summary.profileDir
    });
  });
}));

app.post("/control/system/clear-db", asyncRoute(async (_req, res) => {
  res.status(410).json({
    error: "Deprecated endpoint. Use POST /admin/reset with x-admin-reset-token and confirm=RESET."
  });
}));

// Restart the runner process. Triggered from the dashboard topbar so the
// operator doesn't have to drop into a terminal to bounce the runner
// (e.g. after editing .env, when Playwright gets stuck, or after a code
// hot-reload that didn't take). Sends 202 immediately so the dashboard
// can flip into "restarting…" state, then schedules process.exit(0)
// after a short delay so the response can flush before the socket dies.
//
// Restart behaviour depends on how the runner was started:
//   - dev (`npm run dev:runner` / `npm run dev`): tsx watch supervises
//     the process and restarts on exit. Auto-recovery in <2s.
//   - prod (`node dist/index.js`): no supervisor by default. Pair with
//     systemd / pm2 / launchd / forever to get the same behaviour.
// The endpoint logs the supervisor-mode hint so the operator knows what
// to expect.
app.post("/control/system/restart", asyncRoute(async (_req, res) => {
  const supervisorMode = (() => {
    // tsx watch sets TSX_WATCH=1 on the spawned child since v4. Best-
    // effort: if it isn't there, fall back to checking npm_lifecycle_event,
    // which equals "dev" when started via `npm run dev`.
    if (process.env.TSX_WATCH === "1") return "tsx_watch";
    if (process.env.npm_lifecycle_event === "dev") return "tsx_watch_likely";
    return "no_supervisor";
  })();

  await auditService.log({
    stage: "System",
    action: "RUNNER_RESTART_REQUESTED",
    status: "OK",
    details: {
      requestedBy: "dashboard",
      supervisorMode,
      pid: process.pid
    }
  });

  res.status(202).json({
    ok: true,
    supervisorMode,
    message:
      supervisorMode === "no_supervisor"
        ? "Runner exit scheduled. Without an external supervisor (tsx watch / pm2 / systemd) the runner will stay down until restarted manually."
        : "Runner restart scheduled. Supervisor will relaunch the process within a few seconds."
  });

  // Defer the exit so the response flushes to the dashboard. Drains
  // pending audit writes via setImmediate so the audit row above lands
  // on disk before we kill the process.
  setTimeout(() => {
    setImmediate(() => {
      // eslint-disable-next-line no-console
      console.log(
        `[runner] Restart requested via /control/system/restart — exiting (supervisor=${supervisorMode}, pid=${process.pid})`
      );
      process.exit(0);
    });
  }, 250);
}));

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const path = normalizeControlPath(req.path);
  const trace = getControlTrace(res);
  const statusCode = error instanceof z.ZodError ? 400 : 500;
  const message =
    error instanceof z.ZodError
      ? error.issues
          .map((issue) => {
            const field = issue.path.map(String).join(".") || "body";
            return `${field}: ${issue.message}`;
          })
          .join("; ")
      : error instanceof Error
        ? error.message
        : "Unexpected error";

  if (req.path.startsWith("/control")) {
    const stage = trace?.stage ?? stageForControlPath(path);
    const platform = trace?.platform ?? maybeParsePlatform((req.body as Record<string, unknown> | undefined)?.platform);
    const requestId = trace?.requestId ?? uuid();
    const startedAt = trace?.startedAt ?? Date.now();

    void auditService.log({
      platform,
      stage,
      action: buildControlAction(req.method, path, "ERROR"),
      status: "FAIL",
      details: {
        requestId,
        method: req.method,
        path,
        statusCode,
        durationMs: Date.now() - startedAt,
        ...summarizeError(error)
      }
    });
  }

  // eslint-disable-next-line no-console
  console.error(`[runner:error] ${req.method} ${path} -> ${statusCode}: ${message}`);
  res.status(statusCode).json({ error: message });
});

process.on("unhandledRejection", (reason) => {
  void auditService
    .log({
      stage: "System",
      action: "UNHANDLED_REJECTION",
      status: "FAIL",
      details: {
        source: "process.unhandledRejection",
        ...summarizeError(reason)
      }
    })
    .catch(() => undefined);
});

process.on("uncaughtException", (error) => {
  void auditService
    .log({
      stage: "System",
      action: "UNCAUGHT_EXCEPTION",
      status: "FAIL",
      details: {
        source: "process.uncaughtException",
        ...summarizeError(error)
      }
    })
    .finally(() => {
      // eslint-disable-next-line no-console
      console.error("Uncaught exception", error);
      process.exit(1);
    });
});

async function start(): Promise<void> {
  await ensureRuntimeDirs();
  await settingsStore.getSettings();
  scanQueue.startScheduler();

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(runnerConfig.port, () => {
      // eslint-disable-next-line no-console
      console.log(`Runner listening on http://localhost:${runnerConfig.port}`);
      resolve();
    });
    server.on("error", (error) => reject(error));
  });
}

start().catch((error) => {
  const isAddrInUse =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (error as any).code === "EADDRINUSE";

  if (isAddrInUse) {
    // eslint-disable-next-line no-console
    console.error(
      `Runner failed to start: port ${runnerConfig.port} is already in use. ` +
        "Stop the existing runner/dev process and retry."
    );
    process.exit(1);
    return;
  }

  // eslint-disable-next-line no-console
  console.error("Failed to start runner", error);
  process.exit(1);
});
