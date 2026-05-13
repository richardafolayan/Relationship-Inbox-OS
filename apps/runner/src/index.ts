import { createReadStream, existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { NormalizedMessage, PlatformAdapter, PlatformName, SelectorRegistry, SuggestedRepliesOutput, ThreadStub } from "@inbox-os/core";
import { prisma } from "./db";
import { resolveConnectTimeoutMs, runnerConfig, projectRoot, dataDir } from "./config";
import { ensurePathInside } from "./utils/fs";
import { createSettingsStore } from "./services/settings";
import { createAuditService } from "./services/audit";
import { createEventBus } from "./services/event-bus";
import {
  createAiService,
  contactSnapshotFingerprint,
  operatorProfileFingerprint
} from "./services/ai";
import { createSelectorTestStore } from "./services/selector-report-store";
import { createSelectorTestService, isSelectorTestServiceError } from "./services/selector-tests";
import { extractFailureUrl, resolveConnectFailureResponse } from "./services/failure-routing";
import { createAdapters } from "./services/platform-factory";
import { IMessageDb } from "./platforms/imessage-db";
import { streamIMessageAttachment } from "./services/imessage-attachment-server";
import { createScanQueue } from "./services/scan-queue";
import { createIMessageWatcher } from "./services/imessage-watcher";
import { createSendService } from "./services/send";
import { createSendQueue } from "./services/send-queue";
import { createScheduledSendPromoter } from "./services/scheduled-send-promoter";
import { createEnrichmentQueue } from "./services/enrichment-queue";
import { createSelfProfileService } from "./services/self-profile";
import { createConversationStartersService } from "./services/conversation-starters";
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
  personThreadCountKey,
  personThreadCounts,
  shapeThreadRows,
  toInboxRow,
  type ThreadRowSource
} from "./services/thread-row-shaping";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Multer is loaded lazily on multipart routes (file uploads for outbound
// attachments). The default disk-storage strategy puts files under
// data/outgoing-attachments/<send-request-id>/ so the iMessage adapter
// can reference them by absolute path when shelling out to osascript.
const outgoingAttachmentsRoot = resolve(dataDir, "outgoing-attachments");
mkdirSync(outgoingAttachmentsRoot, { recursive: true });
const uploadAttachments = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = resolve(outgoingAttachmentsRoot, uuid());
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Keep extension so Messages.app can sniff the right file type.
      cb(null, file.originalname);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
}).array("attachments", 10);

function maybeMultipart(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (ct.startsWith("multipart/form-data")) {
    uploadAttachments(req, res, next);
  } else {
    next();
  }
}

function kindFromMime(mime: string | undefined, filename: string | undefined): "voice_note" | "photo" | "video" | "audio" | "pdf" | "unknown" {
  const m = (mime ?? "").toLowerCase();
  const n = (filename ?? "").toLowerCase();
  if (m.startsWith("image/")) return "photo";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.startsWith("audio/")) return /webm|opus|m4a|aac|caf/.test(m) || /audio.message/.test(n) ? "voice_note" : "audio";
  return "unknown";
}

const settingsStore = createSettingsStore();
const auditService = createAuditService();
const eventBus = createEventBus();
const aiService = createAiService(settingsStore);
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
const allPlatforms: PlatformName[] = ["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"];

type ScanQueueWithSmokeIngest = ReturnType<typeof createScanQueue> & {
  syncThreadForIngest: (input: {
    platform: PlatformName;
    candidate: ThreadStub;
    maxMessages: number;
    requestId: string;
    messages?: NormalizedMessage[];
  }) => Promise<{ updatedThreads: number; parsedMessages: number }>;
};

// Lock-key helpers used both by control endpoints and the enrichment
// queue's defer-when-busy logic. Defined here (instead of further down)
// so the enrichment queue can be constructed alongside scan/send and
// share the same lock vocabulary.
function platformLockKey(platform: PlatformName): string {
  return `${defaultPersonKey}:${platform}`;
}
function sendLockKeyFor(platform: PlatformName): string {
  return `${defaultPersonKey}:${platform}:SEND`;
}
function enrichLockKeyFor(): string {
  return `${defaultPersonKey}:LINKEDIN:ENRICH`;
}
function globalResetLockKey(): string {
  return `${defaultPersonKey}:GLOBAL_RESET`;
}

function filterDismissedOpenLoops(loops: string[], dismissedJson: string | null): string[] {
  if (!dismissedJson) return loops;
  const dismissed = new Set(JSON.parse(dismissedJson) as string[]);
  return loops.filter((loop) => !dismissed.has(loop));
}

// Forward reference: the scan-queue's `onNewPerson` hook needs to call
// the enrichment queue's `enqueue`, but the enrichment queue is built
// AFTER scan-queue (it depends on sessionManager + lock vocabulary that
// exists at this point). Use a settable holder so the wire-up order
// works without a refactor.
let enqueueEnrichmentForScan:
  | ((input: { personId: string; trigger: "first_seen" }) => void)
  | null = null;

const scanQueue = createScanQueue({
  adapters,
  eventBus,
  settingsStore,
  aiService,
  platformMutex: operationMutex,
  personKey: defaultPersonKey,
  screenshotDir: runnerConfig.screenshotDir,
  domDumpDir: runnerConfig.domDumpDir,
  auditLog: (input) => auditService.log(input),
  onNewPerson: (input) => enqueueEnrichmentForScan?.(input)
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

// Promotes SCHEDULED SendRequests to PENDING when their scheduledFor
// timestamp has elapsed, then kicks the send-queue worker. Runs every
// 30s — coarse enough to be cheap, fine enough that "send in 5 minutes"
// fires within ~30s of the target time.
const scheduledSendPromoter = createScheduledSendPromoter({
  sendQueue,
  eventBus
});
scheduledSendPromoter.start();

const connectInFlight = new Map<PlatformName, Promise<void>>();
const suggestedRepliesInFlight = new Map<string, Promise<SuggestedRepliesOutput>>();
const threadSummaryRefreshInFlight = new Map<string, Promise<void>>();

// Safety net for the AI bookkeeping maps above. If the underlying
// provider hangs (no resolve, no reject), the `.finally` cleanup in the
// caller never runs, and the slot stays glued to a thread id forever.
// Race the work against a hard ceiling so the map always evicts. The
// rejection here propagates into the existing `.catch` block so the
// caller surfaces a normal failure path.
const AI_IN_FLIGHT_MAX_MS = 120_000;
function withInFlightTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${AI_IN_FLIGHT_MAX_MS}ms; abandoning in-flight slot`)),
      AI_IN_FLIGHT_MAX_MS
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
const emptySuggestedReplies: SuggestedRepliesOutput = {
  replies: [],
  needs_user_input: []
};

const selfProfileService = createSelfProfileService({ sessionManager, personKey: defaultPersonKey });
const conversationStartersService = createConversationStartersService({
  aiService,
  selfProfile: selfProfileService
});
const enrichmentQueue = createEnrichmentQueue({
  sessionManager,
  operationMutex,
  personKey: defaultPersonKey,
  paceMinMs: runnerConfig.enrichPaceMinMs,
  paceMaxMs: runnerConfig.enrichPaceMaxMs,
  batchMax: runnerConfig.enrichBatchMax,
  dailyCap: runnerConfig.enrichDailyCap,
  longIdleEvery: runnerConfig.enrichLongIdleEvery,
  longIdleMinMs: runnerConfig.enrichLongIdleMinMs,
  longIdleMaxMs: runnerConfig.enrichLongIdleMaxMs,
  refreshDays: runnerConfig.enrichRefreshDays,
  scanLockKey: platformLockKey,
  sendLockKey: sendLockKeyFor,
  enrichLockKey: enrichLockKeyFor(),
  ensureConnected: async () => {
    // adapters is Partial<Record<PlatformName, PlatformAdapter>> ever
    // since IMESSAGE landed (some platforms can be unconfigured at
    // runtime). LinkedIn is always registered by the factory today, but
    // throw a clear error if that ever changes rather than calling
    // through `undefined`.
    const linkedin = adapters.LINKEDIN;
    if (!linkedin) {
      throw new Error("LinkedIn adapter is not configured; enrichment cannot ensure session");
    }
    await linkedin.ensureConnected();
  }
});
enqueueEnrichmentForScan = (input) => {
  void enrichmentQueue.enqueue(input.personId, input.trigger);
};
enrichmentQueue.start();

async function withPlatformControlLock<T>(platform: PlatformName, work: () => Promise<T>): Promise<T> {
  return operationMutex.runExclusive(platformLockKey(platform), work);
}

async function withGlobalResetLock<T>(work: () => Promise<T>): Promise<T> {
  return operationMutex.runExclusive(globalResetLockKey(), work);
}

function parsePlatform(value: unknown): PlatformName {
  const parsed = z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"]).parse(value);
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
  if (value !== "LINKEDIN" && value !== "INSTAGRAM" && value !== "TIKTOK" && value !== "IMESSAGE") {
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

// Normalise dynamic path segments to placeholders so the audit-log
// `action` column is the same string for every "enrich a person" call
// rather than a unique-per-person token. Without this, /control/person/
// <cuid>/enrich becomes POST_PERSON_<cuid>_ENRICH_END and the operator
// can't scan the column. Drop the ids into the details payload at the
// call site if you need them — keep them out of the action string.
function normalizeControlPath(path: string): string {
  return path
    .replace(/\/thread\/[^/]+/g, "/thread/:threadId")
    .replace(/\/person\/[^/]+/g, "/person/:personId")
    .replace(/\/job\/[^/]+/g, "/job/:jobId");
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
  personId: string;
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
    displayName: thread.person.displayName,
    personId: thread.personId
  };
}

/**
 * Returns every thread id belonging to a Person on a given platform. iMessage
 * uses this to merge messages across the phone-handle and email-handle chats
 * of one human into a single conversation view.
 */
async function siblingThreadIds(platform: PlatformName, personId: string): Promise<string[]> {
  const rows = await prisma.thread.findMany({
    where: { platform, personId },
    select: { id: true }
  });
  return rows.map((r) => r.id);
}

// The adapters map is `Partial<Record<PlatformName, PlatformAdapter>>` —
// every platform-name access from a DB row needs to narrow before
// dispatching, otherwise the call blows up with
// "Cannot read properties of undefined (reading 'X')". Throws a clean
// Error that the route's catch / Express error path surfaces to the
// dashboard as readable text. (#135 / #140)
function requireAdapter(platform: string): PlatformAdapter {
  const adapter = (adapters as Record<string, PlatformAdapter | undefined>)[platform];
  if (!adapter) {
    throw new Error(
      `Platform ${platform} is not supported by this runner. Supported platforms: ${Object.keys(adapters).join(", ")}.`
    );
  }
  return adapter;
}

async function loadVisibleThreadRows(options?: {
  /** When true, return ONLY archived threads. When false/undefined, return ONLY non-archived. */
  archived?: boolean;
}): Promise<ReturnType<typeof shapeThreadRows>> {
  const now = new Date();
  const threads = await prisma.thread.findMany({
    where: options?.archived
      ? { archivedAt: { not: null } }
      : {
          archivedAt: null,
          // Hide snoozed threads from active views until the timer expires.
          // The dashboard polls every 10s, so threads resurface naturally
          // within that window once snoozedUntil <= now.
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
        },
    select: {
      id: true,
      platform: true,
      platformThreadId: true,
      threadUrl: true,
      personId: true,
      unreadCount: true,
      needsReply: true,
      lastMessagePreview: true,
      lastMessageAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      lastMessageDirection: true,
      lastMessageText: true,
      riskLevel: true,
      riskReason: true,
      slaDueAt: true,
      snoozedUntil: true,
      whatTheyWant: true,
      rollingSummary: true,
      archivedAt: true,
      category: true,
      updatedAt: true,
      person: {
        select: {
          id: true,
          displayName: true,
          inferredName: true,
          platform: true,
          avatarUrl: true
        }
      },
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
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"]).default("LINKEDIN"),
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
    // Drop every in-flight bookkeeping map so a wedged AI call from
    // pre-reset state can't keep stale thread ids glued to slots.
    connectInFlight.clear();
    suggestedRepliesInFlight.clear();
    threadSummaryRefreshInFlight.clear();
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
  // Mirror the picker's eligibility filter in enrichment-queue.ts so the
  // status-bar count matches what the worker would actually pick up next.
  // A job rescheduled with nextAttemptAt 6h in the future is asleep, not
  // "in flight" — counting it sticks the banner on for hours after every
  // failed run and trains the operator to mash the cancel button.
  const now = new Date();
  const [platforms, enrichmentPending, enrichmentRunning] = await Promise.all([
    prisma.platform.findMany(),
    prisma.enrichmentJob.count({
      where: {
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      }
    }),
    prisma.enrichmentJob.count({ where: { status: "RUNNING" } })
  ]);
  const lastScanAt = platforms
    .map((platform) => platform.lastScanAt)
    .filter(Boolean)
    .sort((a, b) => (a!.getTime() > b!.getTime() ? -1 : 1))[0];

  const runnerStatus = scanQueue.isScanning() ? "SCANNING" : "ONLINE";
  const connectedPlatforms = platforms.filter((platform) => platform.status === "CONNECTED").length;

  // Determinate scan progress: surfaced so the status bar can render a real
  // progress bar instead of an indeterminate sweep. ETA is computed against
  // the previous scan's wall-clock duration — first-ever scans have no ETA.
  const scanProgress = (() => {
    const snap = scanQueue.getCurrentScanProgress();
    if (!snap) return undefined;
    const total = snap.total > 0 ? snap.total : 0;
    const percent = total > 0
      ? Math.min(99, Math.max(0, Math.round((snap.processedRows / total) * 100)))
      : 0;
    const lastSummary = scanQueue.getLatestRunSummary(snap.platform);
    let etaSeconds: number | null = null;
    if (lastSummary?.startedAt && lastSummary?.completedAt) {
      const prevMs = Date.parse(lastSummary.completedAt) - Date.parse(lastSummary.startedAt);
      const elapsedMs = Date.now() - snap.startedAt;
      if (Number.isFinite(prevMs) && prevMs > 0) {
        etaSeconds = Math.max(0, Math.round((prevMs - elapsedMs) / 1000));
      }
    }
    return {
      platform: snap.platform,
      processedRows: snap.processedRows,
      total,
      percent,
      etaSeconds
    };
  })();

  res.json({
    runnerStatus,
    lastScanAt: lastScanAt?.toISOString() ?? null,
    queueDepth: scanQueue.getQueueDepth(),
    connectedPlatforms,
    // Current platform being scanned, if any. Drives the status bar's
    // "Scanning <platform>" label so it stops claiming "linkedin" when
    // an iMessage scan is running.
    currentScanPlatform: scanQueue.getCurrentScanPlatform() ?? null,
    // Surfaced for the dashboard's status bar so a "Scan all" click
    // (which queues every Person with a profileUrl) shows visible
    // progress while the queue drains, instead of silently chugging.
    enrichmentQueue: {
      pending: enrichmentPending,
      running: enrichmentRunning,
      total: enrichmentPending + enrichmentRunning
    },
    scanProgress
  });
}));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sinceEventId = Number(req.query.sinceEventId ?? req.header("last-event-id") ?? 0);
  const oldest = eventBus.oldestEventId();

  // Emit every event as the default ("message") SSE type. EventSource
  // only delivers an event to `source.onmessage` when no `event:` field
  // is set; named events fire only on per-name `addEventListener`
  // listeners. The dashboard registers a single `onmessage` in
  // `app-shell.tsx` and dispatches a `runner-event` window event keyed
  // off `payload.type` from the JSON body, so the per-event-name SSE
  // field was silently dropping every event on the floor (#127:
  // SUGGESTED_REPLIES_UPDATED never reached the open thread; the
  // operator only saw fresh chips after navigating away and back). Keep
  // `id:` — that's how EventSource sets `Last-Event-ID` on reconnect.
  function writeEvent(event: unknown, eventId?: number): void {
    if (eventId) {
      res.write(`id: ${eventId}\n`);
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (sinceEventId > 0 && oldest > 0 && sinceEventId < oldest - 1) {
    const resyncEvent = eventBus.emit({
      type: "RESYNC_REQUIRED",
      jobId: uuid(),
      reason: "Event replay window exceeded"
    });
    writeEvent(resyncEvent, resyncEvent.eventId);
  }

  const replayEvents = eventBus.listSince(sinceEventId);
  for (const event of replayEvents) {
    writeEvent(event, event.eventId);
  }

  const unsubscribe = eventBus.subscribe((event) => {
    writeEvent(event, event.eventId);
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

// Reset macOS Automation permissions and re-trigger the Allow-Messages
// dialog. Called from the dashboard banner when a send fails with -1743.
// Runs `tccutil reset AppleEvents` (macOS-only, no-op on other OSes) and
// then attempts a benign `osascript` against Messages so the system
// re-prompts for Automation. Also opens System Settings -> Privacy ->
// Automation as a fallback so the operator can flip the toggle directly.
app.post("/control/imessage/permission-reset", asyncRoute(async (_req, res) => {
  if (process.platform !== "darwin") {
    res.status(400).json({ error: "macOS only" });
    return;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const ranSteps: string[] = [];
  try {
    await run("tccutil", ["reset", "AppleEvents"], { timeout: 10_000 });
    ranSteps.push("tccutil_reset");
  } catch (error) {
    ranSteps.push(`tccutil_reset_failed:${(error as Error).message}`);
  }
  try {
    // Trigger a benign event so macOS knows we want Messages access; this
    // pops the Allow-prompt on next osascript invocation against Messages.
    await run("osascript", ["-e", 'tell application "Messages" to count of services'], { timeout: 8_000 });
    ranSteps.push("messages_probe_ok");
  } catch (error) {
    // Expected: the probe re-pops the Allow dialog. Operator clicks Allow,
    // and the next real send works. If the probe still errored we surface
    // the deeplink to settings as the fallback path.
    ranSteps.push(`messages_probe_prompt:${((error as Error).message ?? "").slice(0, 80)}`);
  }
  try {
    // Open BOTH panes in turn so the operator can verify Automation +
    // Accessibility — file sends now go through UI scripting (clipboard
    // paste in the Messages window), which needs Accessibility on top of
    // Automation. The first one opened wins focus; macOS keeps the other
    // available a click away.
    await run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], { timeout: 5_000 });
    await run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], { timeout: 5_000 });
    ranSteps.push("settings_opened");
  } catch {
    // non-fatal
  }
  res.json({ ok: true, steps: ranSteps, message: "Permissions reset. Toggle your terminal app ON for both Automation > Messages AND Accessibility, then retry the send." });
}));

// Stream a Messages.app attachment (photo / voice note / video) to the
// dashboard. Reads chat.db for the file path and serves the bytes from
// ~/Library/Messages/Attachments. Localhost-only access (the runner
// already binds 127.0.0.1) gates this to the operator's machine.
app.get("/data/imessage-attachment/:guid", asyncRoute(async (req, res) => {
  if (!runnerConfig.imessage.enabled) {
    res.status(503).json({ error: "iMessage adapter not enabled" });
    return;
  }
  const { guid } = z.object({ guid: z.string().min(8).max(100) }).parse(req.params);
  let db: IMessageDb;
  try {
    db = new IMessageDb(runnerConfig.imessage.dbPath);
  } catch {
    res.status(503).json({ error: "cannot open chat.db (Full Disk Access?)" });
    return;
  }
  try {
    const meta = db.findAttachmentByGuid(guid);
    if (!meta) {
      res.status(404).json({ error: "attachment not found in chat.db" });
      return;
    }
    if (!meta.absolutePath) {
      res.status(404).json({ error: "attachment file path unresolved" });
      return;
    }
    await streamIMessageAttachment({
      absolutePath: meta.absolutePath,
      mimeType: meta.mimeType,
      transferName: meta.transferName,
      filename: meta.filename,
      res
    });
  } finally {
    db.close();
  }
}));

app.get("/data/settings", asyncRoute(async (_req, res) => {
  const settings = await settingsStore.getSettings();
  res.json(settings);
}));

// Reflects which AI providers actually have credentials at runtime.
// The dashboard reads this alongside /data/settings to show a "key
// missing" warning when the operator has flipped to a provider that
// isn't actually configured (e.g. selecting GLM with Z_AI_API_KEY
// blank — the toggle persists in the DB but every AI call falls back
// to the canned default reply). Separate from /data/settings because
// AppSettings is the persisted user choice; this endpoint is the
// runtime configuration view.
app.get("/data/ai-status", asyncRoute(async (_req, res) => {
  const settings = await settingsStore.getSettings();
  const activeProvider = settings.aiProvider ?? runnerConfig.aiProvider;
  const configuredProviders: Array<"openai" | "glm" | "gemini"> = [];
  if (runnerConfig.openAiApiKey) configuredProviders.push("openai");
  if (runnerConfig.zAiApiKey) configuredProviders.push("glm");
  if (runnerConfig.geminiApiKey) configuredProviders.push("gemini");
  const activeModel =
    activeProvider === "glm"
      ? settings.glmModel?.trim() || runnerConfig.glmModel
      : activeProvider === "gemini"
        ? settings.geminiModel?.trim() || runnerConfig.geminiModel
        : runnerConfig.openAiModel;
  res.json({
    activeProvider,
    activeModel,
    configuredProviders,
    activeProviderConfigured: configuredProviders.includes(activeProvider)
  });
}));

app.post("/control/settings", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      scanIntervalSeconds: z.number().int().min(10).max(3600).optional(),
      amberHours: z.number().int().min(1).max(72).optional(),
      redHours: z.number().int().min(1).max(168).optional(),
      headless: z.boolean().optional(),
      maxMessagesPerThread: z.number().int().min(5).max(100).optional(),
      enabledPlatforms: z.array(z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"])).optional(),
      demoMode: z.boolean().optional(),
      recentThreadSweepCount: z.number().int().min(5).max(100).optional(),
      aiProvider: z.enum(["openai", "glm", "gemini"]).optional(),
      // Empty string from the dashboard is normalised to undefined client-side,
      // but accept either here defensively. Length cap matches typical model
      // ids while preventing accidental megabyte payloads.
      glmModel: z.string().max(100).optional(),
      geminiModel: z.string().max(100).optional()
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

// Cooperative scan abort. Drives the cancel button in the dashboard's
// system status bar. The scan loop polls `shouldAbort()` between thread
// iterations and exits cleanly with stopReason="aborted" — safer than
// killing the browser context mid-DOM-read. Idempotent: calling when no
// scan is in flight is a no-op.
app.post("/control/scan/abort", asyncRoute(async (_req, res) => {
  const wasScanning = scanQueue.isScanning();
  scanQueue.requestAbort("manual");
  res.json({ status: wasScanning ? "aborting" : "idle" });
}));

// Cancel every queued PENDING enrichment job, including ones rescheduled
// far in the future. The currently RUNNING job (if any) is left to finish —
// killing it mid-page would leave the playwright context in a wedged state.
// Returns the count of rows transitioned to FAILED.
app.post("/control/enrichment/cancel-pending", asyncRoute(async (_req, res) => {
  const result = await prisma.enrichmentJob.updateMany({
    where: { status: "PENDING" },
    data: { status: "FAILED", lastError: "cancelled by operator", nextAttemptAt: null }
  });
  res.json({ status: "ok", cancelled: result.count });
}));

app.post("/control/scan", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"]).optional(),
      maxThreads: z.number().nullable().optional(),
      maxOpens: z.number().nullable().optional(),
      forceFallback: z.boolean().nullable().optional(),
      scope: z.enum(["update", "full"]).optional()
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
    forceFallback,
    scope: payload.scope ?? "update"
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

    // Returns 200 with `{ ok: false, reason, retryAfterSeconds }` so the
    // dashboard's structured cooldown UI in app/platforms/page.tsx can
    // surface retry-after info inline. Don't change to 4xx without also
    // updating the dashboard to read ApiRequestError.payload.
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
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"]) }).parse(req.body);
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
        // requireAdapter narrows `adapters[platform]` away from undefined
        // (the map is now Partial<Record<PlatformName, PlatformAdapter>>;
        // see services/platform-factory.ts).
        const platformAdapter = requireAdapter(platform);
        trackedPromise = platformAdapter.ensureConnected().finally(() => {
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
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"]),
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

app.post("/control/thread/:threadId/send", maybeMultipart, asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  // For multipart bodies, multer puts file metadata on req.files and
  // string fields on req.body. Reuse the same JSON schema for the field
  // values so the validation flow is identical between JSON and multipart.
  const payload = z
    .object({
      text: z.string(),
      clientSendId: z.string().uuid(),
      // Optional ISO 8601 timestamp. When present, the send is persisted
      // as SCHEDULED and the scheduled-send promoter flips it to PENDING
      // when the time elapses. When absent, the send is enqueued
      // immediately (existing behaviour).
      scheduledFor: z.string().datetime().optional(),
      // App-level threading. When the dashboard's focused-thread composer
      // sends a reply, it includes the parent Message.id here. The send
      // itself still goes out as a regular text bubble — the threading is
      // only persisted on our side and rendered by the dashboard.
      replyToMessageId: z.string().min(1).optional()
    })
    .parse(req.body);
  const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
  const stagedAttachments = uploadedFiles.map((f) => ({
    absolutePath: f.path,
    displayName: f.originalname,
    mimeType: f.mimetype,
    kind: kindFromMime(f.mimetype, f.originalname)
  }));
  if (stagedAttachments.length === 0 && payload.text.trim().length === 0) {
    res.status(400).json({ error: "send must have text, attachments, or both" });
    return;
  }

  // Reject early for unsupported platforms — without this, the SendRequest
  // queues, the worker hits `adapter.sendMessage(undefined)` and records a
  // confusing "Cannot read properties of undefined" on the FAILED row.
  // Same guard as /open and /rescan; see requireAdapter.
  const target = await getThreadStub(threadId);
  requireAdapter(target.platform);

  // Schedule path: persist a SCHEDULED row and return immediately. The
  // dashboard renders a "scheduled for X" pill instead of pushing the
  // bubble through the optimistic-send timeline. The promoter takes
  // over from there.
  if (payload.scheduledFor) {
    try {
      const scheduleResult = await sendService.enqueueScheduledSend({
        threadId,
        text: payload.text,
        clientSendId: payload.clientSendId,
        scheduledFor: new Date(payload.scheduledFor),
        attachments: stagedAttachments
      });
      res.json({
        clientSendId: scheduleResult.clientSendId,
        status: scheduleResult.status,
        scheduledFor: scheduleResult.scheduledFor,
        replayed: scheduleResult.replayed,
        // Surfaced for parity with enqueueAndKick's response shape so the
        // dashboard doesn't need a separate fetch to refresh the bar.
        activeCount: await sendQueue.getActiveCount(),
        queuePosition: -1
      });
      return;
    } catch (error) {
      await auditService.log({
        platform: "LINKEDIN",
        stage: "Send",
        action: "SEND_SCHEDULE_FAIL",
        status: "FAIL",
        details: {
          threadId,
          stage: "schedule",
          ...summarizeError(error)
        }
      });
      throw error;
    }
  }

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
      clientSendId: payload.clientSendId,
      attachments: stagedAttachments,
      replyToMessageId: payload.replyToMessageId
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

app.post("/control/thread/:threadId/update-send", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  // Either text, scheduledFor, or both. Empty body 400s — there's
  // nothing to do if the operator didn't send a change.
  const payload = z
    .object({
      clientSendId: z.string().uuid(),
      text: z.string().min(1).max(5000).optional(),
      scheduledFor: z.string().datetime().optional()
    })
    .refine((v) => v.text !== undefined || v.scheduledFor !== undefined, {
      message: "either text or scheduledFor required"
    })
    .parse(req.body);

  const result = await sendService.updateScheduledSend({
    clientSendId: payload.clientSendId,
    threadId,
    text: payload.text,
    scheduledFor: payload.scheduledFor ? new Date(payload.scheduledFor) : undefined
  });

  if (!result.updated) {
    res.status(409).json({ error: result.reason });
    return;
  }

  // Same dashboard-poll-shortcut as cancel-send. The thread page
  // refetches /data/thread on the event so the pill reflects the new
  // text immediately.
  eventBus.emit({
    type: "SEND_QUEUE_UPDATED",
    jobId: "update-send",
    activeCount: await sendQueue.getActiveCount()
  });

  res.json({
    status: "updated",
    clientSendId: payload.clientSendId,
    text: result.text,
    scheduledFor: result.scheduledFor
  });
}));

app.post("/control/thread/:threadId/cancel-send", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z.object({ clientSendId: z.string().uuid() }).parse(req.body);

  const result = await sendService.cancelScheduledSend({
    clientSendId: payload.clientSendId,
    threadId
  });

  if (!result.cancelled) {
    res.status(409).json({ error: result.reason ?? "cancel_failed" });
    return;
  }

  // Tell the dashboard the queue moved without waiting for its 3-second poll.
  eventBus.emit({
    type: "SEND_QUEUE_UPDATED",
    jobId: "cancel-send",
    activeCount: await sendQueue.getActiveCount()
  });

  res.json({ status: "cancelled", clientSendId: payload.clientSendId });
}));

app.post("/control/thread/:threadId/retry-send", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z.object({ clientSendId: z.string().uuid() }).parse(req.body);

  // Same unsupported-platform guard as /send. Without this, retrying a
  // FAILED row on an iMessage thread just queues another doomed request.
  const retryTarget = await getThreadStub(threadId);
  requireAdapter(retryTarget.platform);

  // Look up the failed SendRequest row and re-queue under a fresh
  // clientSendId. Original row stays in FAILED for receipts; the new
  // row carries the same text so the operator never has to retype.
  const original = await prisma.sendRequest.findUnique({
    where: { clientSendId: payload.clientSendId }
  });
  if (!original) {
    res.status(404).json({ error: "send_request_not_found" });
    return;
  }
  if (original.threadId !== threadId) {
    res.status(400).json({ error: "thread_mismatch" });
    return;
  }

  const newClientSendId = randomUUID();
  try {
    const queueResult = await sendQueue.enqueueAndKick({
      threadId,
      text: original.requestText,
      clientSendId: newClientSendId
    });
    res.json({ ...queueResult, clientSendId: newClientSendId });
  } catch (error) {
    await auditService.log({
      platform: "LINKEDIN",
      stage: "Send",
      action: "SEND_RETRY_FAIL",
      status: "FAIL",
      details: { threadId, originalClientSendId: payload.clientSendId, ...summarizeError(error) }
    });
    throw error;
  }
}));

app.post("/control/thread/:threadId/open", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const target = await getThreadStub(threadId);
  const adapter = requireAdapter(target.platform);

  await withPlatformControlLock(target.platform, async () => {
    try {
      await adapter.openThread({
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

// Open the operator's "open profile" link in the runner-controlled
// Chrome session rather than the default browser. The dashboard renders
// the link as a button that POSTs here; the runner navigates its own
// already-authenticated Chrome tab to the profile URL. Adapters that
// don't manage a browser session (iMessage) don't expose openProfileUrl
// — those persons surface a clean 400 instead of dispatching nowhere.
app.post("/control/person/:personId/open-profile", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  if (!person.profileUrl) {
    res.status(400).json({ error: "person has no profile URL" });
    return;
  }
  const adapter = requireAdapter(person.platform);
  if (!adapter.openProfileUrl) {
    res.status(400).json({
      error: `${person.platform} adapter does not support opening profiles in the runner browser`
    });
    return;
  }
  await withPlatformControlLock(person.platform, async () => {
    try {
      await adapter.openProfileUrl!(person.profileUrl!, person.displayName);
      await auditService.log({
        platform: person.platform,
        stage: "Connect",
        action: "OPEN_PROFILE",
        status: "OK",
        details: { personId: person.id, profileUrl: person.profileUrl }
      });
      res.json({ status: "ok" });
    } catch (error) {
      await auditService.log({
        platform: person.platform,
        stage: "Connect",
        action: "OPEN_PROFILE_FAIL",
        status: "FAIL",
        details: { personId: person.id, profileUrl: person.profileUrl, ...summarizeError(error) }
      });
      throw error;
    }
  });
}));

app.post("/control/thread/:threadId/rescan", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const target = await getThreadStub(threadId);
  // Reject early for unsupported platforms — see requireAdapter. Without
  // this, scanQueue.syncThread → adapter.fetchThreadMessages crashes with
  // a confusing "Cannot read properties of undefined" TypeError.
  requireAdapter(target.platform);
  const requestId = getControlTrace(res)?.requestId ?? uuid();
  const settings = await settingsStore.getSettings();

  // For iMessage we render one row per Person but chat.db may have several
  // chats with that human (phone + email). Rescanning ONLY the canonical
  // thread leaves the sibling rows stale, which the operator perceives as
  // "the rescan messed it up". So for iMessage we walk every sibling
  // thread of the same Person and refresh each.
  const targets =
    target.platform === "IMESSAGE"
      ? await prisma.thread.findMany({
          where: { platform: target.platform, personId: target.personId },
          select: { id: true, platformThreadId: true, threadUrl: true, person: { select: { displayName: true } } }
        })
      : [{ id: target.threadId, platformThreadId: target.platformThreadId, threadUrl: target.threadUrl, person: { displayName: target.displayName } }];

  // Per-thread rescan: open ONLY this thread and re-parse its messages,
  // instead of triggering a full-inbox scan via enqueueScan(). The full-
  // inbox path takes 30-90s on a populated inbox; opening one thread is
  // typically <5s. Wraps in the platform control lock so it serialises
  // against any in-flight scan / send / open-thread operation.
  // Emit scoped progress events so the dashboard's Rescan button can
  // surface "opening thread / reading messages / saving" inline rather
  // than a static spinner. Mirrors SCAN_PROGRESS for full-inbox scans
  // but keyed on threadId so the thread page can subscribe selectively.
  eventBus.emit({
    type: "SCAN_THREAD_STARTED",
    jobId: requestId,
    threadId: target.threadId,
    platform: target.platform
  });
  try {
    const result = await withPlatformControlLock(target.platform, async () => {
      const aggregate = { updatedThreads: 0, parsedMessages: 0 };
      eventBus.emit({
        type: "SCAN_THREAD_PROGRESS",
        jobId: requestId,
        threadId: target.threadId,
        platform: target.platform,
        stage: targets.length > 1 ? "Reading sibling threads" : "Reading messages"
      });
      for (const t of targets) {
        const candidate: ThreadStub = {
          platformThreadId: t.platformThreadId,
          displayName: t.person.displayName,
          threadUrl: t.threadUrl ?? undefined,
          lastMessagePreview: ""
        };
        const partial = await scanQueue.syncThreadForIngest({
          platform: target.platform,
          candidate,
          maxMessages: settings.maxMessagesPerThread,
          requestId
        });
        aggregate.updatedThreads += partial.updatedThreads ?? 0;
        aggregate.parsedMessages += partial.parsedMessages ?? 0;
      }
      eventBus.emit({
        type: "SCAN_THREAD_PROGRESS",
        jobId: requestId,
        threadId: target.threadId,
        platform: target.platform,
        stage: "Saving updates"
      });
      return aggregate;
    });
    eventBus.emit({
      type: "SCAN_THREAD_FINISHED",
      jobId: requestId,
      threadId: target.threadId,
      platform: target.platform,
      updatedThreads: result.updatedThreads,
      parsedMessages: result.parsedMessages
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
    eventBus.emit({
      type: "SCAN_THREAD_FINISHED",
      jobId: requestId,
      threadId: target.threadId,
      platform: target.platform,
      updatedThreads: 0,
      parsedMessages: 0
    });
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

  // Resummarize is driven by the operator clicking "Reassess" or by the
  // stale-summary self-heal path. Recompute needsReply from the thread's
  // own message ordering so the mode-aware prompt picks the right
  // framing (active reply vs reopen).
  const computedNeedsReply = Boolean(
    thread.lastInboundAt &&
      (!thread.lastOutboundAt || thread.lastInboundAt > thread.lastOutboundAt)
  );
  const summary = await aiService.updateThreadSummary({
    displayName: thread.person.displayName,
    previousSummary: thread.rollingSummary ?? undefined,
    previousOpenLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
    messages: thread.messages.map((message) => ({
      direction: message.direction as "IN" | "OUT",
      text: message.text,
      timestamp: message.timestamp.toISOString()
    })),
    needsReply: computedNeedsReply
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

app.post("/control/thread/:threadId/transform", asyncRoute(async (req, res) => {
  // Validate the path param even though the handler doesn't currently
  // need the thread row. Without this, any string in the path was
  // accepted, which silently let bad URLs reach the AI service.
  z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z
    .object({
      mode: z.enum(["SHORTEN", "MAKE_WARMER"]),
      text: z.string().min(1)
    })
    .parse(req.body);

  const text = await aiService.transformReply(payload);
  res.json({ text });
}));

// "Tell the AI what you want to say, get it back in your voice."
// The operator types a brief intent (a sentence or two) and gets back
// a sendable draft calibrated to how they've previously written on
// this thread. Used by the dashboard's Compose card on the thread
// page when the suggested replies don't fit.
app.post("/control/thread/:threadId/compose", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z.object({ intent: z.string().min(1).max(2000) }).parse(req.body);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: {
        orderBy: { timestamp: "asc" },
        take: 80
      }
    }
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const voiceSamples = thread.messages
    .filter((m) => m.direction === "OUT")
    .map((m) => m.text);

  // Pull other-thread context for the same Person so the AI doesn't
  // repeat questions already answered elsewhere or contradict prior
  // tone. Bounded to 5 threads + person notes/tags.
  const otherThreadsForCompose = await prisma.thread.findMany({
    where: { personId: thread.personId, id: { not: thread.id }, archivedAt: null },
    orderBy: { lastMessageAt: "desc" },
    take: 5,
    select: { platform: true, lastMessageAt: true, lastMessagePreview: true, whatTheyWant: true }
  });
  const relationshipContext = {
    otherThreadCount: otherThreadsForCompose.length,
    recentExchanges: otherThreadsForCompose.map((t) => ({
      platform: t.platform,
      lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
      preview: t.lastMessagePreview ?? null,
      whatTheyWant: t.whatTheyWant ?? null
    })),
    notes: thread.person.notes ?? null,
    tags: thread.person.tagsJson ? (JSON.parse(thread.person.tagsJson) as string[]) : []
  };

  const [composeOperatorProfile, composeContactSnapshot] = await Promise.all([
    settingsStore.getOperatorProfile(),
    conversationStartersService.toContactSnapshot(thread.personId, thread.person.displayName)
  ]);

  const text = await aiService.composeInVoice({
    intent: payload.intent,
    platform: thread.platform as PlatformName,
    displayName: thread.person.displayName,
    voiceSamples,
    threadMessages: thread.messages.map((m) => ({
      direction: m.direction as "IN" | "OUT",
      text: m.text,
      timestamp: m.timestamp.toISOString()
    })),
    relationshipContext,
    operatorProfile: composeOperatorProfile,
    contact: composeContactSnapshot
  });

  res.json({ text });
}));

// One-click reassess. Burns the cached suggested replies, regenerates
// the rolling summary + what-they-want + open loops, and reclassifies
// the thread (outreach vs genuine). The dashboard pulls a fresh
// /data/thread response after this returns and the user sees all four
// fields refreshed at once. Wraps the AI calls in try/catch so a
// transient OpenAI / GLM hiccup leaves the thread in its previous
// state rather than blanking the fields.
app.post("/control/thread/:threadId/reassess", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);

  // 1. Resummarise (this also refreshes whatTheyWant + openLoops via the
  // existing helper, which already persists the result).
  const resummarised = await resummarizeThreadById(threadId);
  if (!resummarised.ok) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  // 2. Reclassify outreach vs genuine. Uses the freshly-resummarised
  // fields as input so the classification reflects the latest state.
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: {
        orderBy: { timestamp: "asc" },
        take: 80
      }
    }
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  const category = await aiService
    .classifyThreadCategory({
      platform: thread.platform as PlatformName,
      displayName: thread.person.displayName,
      messages: thread.messages.map((m) => ({
        direction: m.direction as "IN" | "OUT",
        text: m.text,
        timestamp: m.timestamp.toISOString()
      })),
      summary: thread.rollingSummary,
      whatTheyWant: thread.whatTheyWant
    })
    .catch(() => null);

  // 3. Burn the suggested-replies cache so the next /data/thread fetch
  // regenerates them against the new summary / what-they-want / category /
  // late-reply bucket. Persisting null on the cache key + json columns is
  // the cheapest way to express "stale" without touching the schema.
  await prisma.thread.update({
    where: { id: thread.id },
    data: {
      ...(category ? { category } : {}),
      suggestedRepliesCacheKey: null,
      suggestedRepliesJson: null
    }
  });

  res.json({
    ok: true,
    threadId,
    summary: resummarised.summary,
    whatTheyWant: resummarised.whatTheyWant,
    openLoops: resummarised.openLoops,
    category: category ?? thread.category ?? null
  });
}));

app.get("/data/inbox", asyncRoute(async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const platform = typeof req.query.platform === "string" ? (req.query.platform as PlatformName) : undefined;
  const risk = typeof req.query.risk === "string" ? req.query.risk : undefined;
  const unreadOnly = req.query.unread === "true";
  const needsReplyOnly = req.query.needsReply === "true";
  // Honour ?view=archived so the endpoint behaves the way the URL reads.
  // Previously this param was silently ignored and the active inbox came
  // back unchanged — misleading for any external script that guessed at
  // the URL (issue #204). The dashboard still calls /data/archived
  // directly; this just stops the alternative from quietly lying.
  const view = typeof req.query.view === "string" ? req.query.view : undefined;
  const archivedView = view === "archived";

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [visibleRows, recentMessages, sentToday, scheduledSends] = await Promise.all([
    loadVisibleThreadRows(archivedView ? { archived: true } : undefined),
    // Pull all messages across the last 7 days in one query so we can
    // compute averageReplyTimeHours from real inbound→outbound deltas
    // rather than the hardcoded placeholder this used to return.
    prisma.message.findMany({
      where: { timestamp: { gte: sevenDaysAgo } },
      select: { threadId: true, direction: true, timestamp: true },
      orderBy: { timestamp: "asc" }
    }),
    prisma.message.count({
      where: {
        direction: "OUT",
        timestamp: {
          gte: todayStart
        }
      }
    }),
    prisma.sendRequest.findMany({
      where: { status: "SCHEDULED" },
      select: { threadId: true, scheduledFor: true }
    })
  ]);

  // Walk messages per-thread, in chronological order. Every inbound is a
  // candidate "ball in our court"; the next outbound after it (still
  // inside the 7-day window) gives a real reply latency. Average across
  // all such pairs. Null when nothing replied in the window — better than
  // pretending with a placeholder.
  const repliesByThread = new Map<string, { lastInbound: Date | null }>();
  const replyLatenciesMs: number[] = [];
  for (const msg of recentMessages) {
    let state = repliesByThread.get(msg.threadId);
    if (!state) {
      state = { lastInbound: null };
      repliesByThread.set(msg.threadId, state);
    }
    if (msg.direction === "IN") {
      state.lastInbound = msg.timestamp;
    } else if (msg.direction === "OUT" && state.lastInbound) {
      const delta = msg.timestamp.getTime() - state.lastInbound.getTime();
      if (delta >= 0) replyLatenciesMs.push(delta);
      state.lastInbound = null;
    }
  }
  const averageReplyTimeHours =
    replyLatenciesMs.length > 0
      ? Math.round(
          (replyLatenciesMs.reduce((sum, ms) => sum + ms, 0) /
            replyLatenciesMs.length /
            3_600_000) *
            10
        ) / 10
      : null;

  // Earliest SCHEDULED scheduledFor per thread — Today uses this to skip
  // threads the operator has already queued a reply for.
  const scheduledSendByThread = new Map<string, Date>();
  for (const row of scheduledSends) {
    if (!row.scheduledFor) continue;
    const existing = scheduledSendByThread.get(row.threadId);
    if (!existing || row.scheduledFor.getTime() < existing.getTime()) {
      scheduledSendByThread.set(row.threadId, row.scheduledFor);
    }
  }

  const visibleCounts = personThreadCounts(visibleRows);
  const dedupedRows = visibleRows.map((row) => {
    const count = visibleCounts.get(personThreadCountKey(row.source.platform, row.source.personId)) ?? 1;
    const shaped = toInboxRow(row, count);
    const scheduledFor = scheduledSendByThread.get(shaped.id);
    return {
      ...shaped,
      scheduledSendAt: scheduledFor ? scheduledFor.toISOString() : null
    };
  });

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

  const oldestPending = rows
    .filter((row) => row.needsReply && row.lastInboundAt)
    .sort((a, b) => Date.parse(a.lastInboundAt!) - Date.parse(b.lastInboundAt!))[0];

  const summary = {
    unreadThreads: rows.filter((row) => row.unreadCount > 0).length,
    atRiskThreads: rows.filter((row) => row.riskLevel !== "GREEN").length,
    averageReplyTimeHours,
    oldestPendingInboundAt: oldestPending?.lastInboundAt ?? null,
    messagesSentToday: sentToday
  };

  res.json({ rows, summary });
}));

app.get("/data/thread/:threadId", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const requestedMessageLimit = Number(req.query.messagesLimit ?? 60);
  const messageLimit = Number.isFinite(requestedMessageLimit)
    ? Math.max(20, Math.min(120, Math.floor(requestedMessageLimit)))
    : 60;
  const beforeMessageId = typeof req.query.beforeMessageId === "string" && req.query.beforeMessageId.trim()
    ? req.query.beforeMessageId.trim()
    : undefined;

  if (beforeMessageId) {
    // Cursor message can live on the canonical thread or any sibling
    // (iMessage merges messages across same-person threads), so we
    // validate by id only after confirming it belongs to the cohort.
    const cursorExists = await prisma.message.findFirst({
      where: { id: beforeMessageId },
      select: { id: true }
    });
    if (!cursorExists) {
      res.status(400).json({ error: "Invalid message cursor" });
      return;
    }
  }

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
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

  // Self-heal stale summary on demand, but never block thread open on AI.
  // Threads written before the AI was fully working still have
  // rollingSummary === "Conversation with X." (the static fallback). Kick
  // regeneration into the background and let the existing SSE refresh path
  // replace the stale context when it lands.
  if (isStaleSummary(thread.rollingSummary, thread.person.displayName)) {
    const inFlightKey = thread.id;
    if (!threadSummaryRefreshInFlight.has(inFlightKey)) {
      const inFlight = withInFlightTimeout(
        resummarizeThreadById(thread.id),
        `threadSummaryRefresh(${thread.id})`
      )
        .then((refreshed) => {
          if (refreshed.ok) {
            eventBus.emit({
              type: "THREAD_UPDATED",
              jobId: uuid(),
              threadId: thread.id
            });
          }
        })
        .catch((error) => {
          console.warn(
            `[ai] background thread summary refresh failed for threadId=${thread.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        })
        .finally(() => {
          if (threadSummaryRefreshInFlight.get(inFlightKey) === inFlight) {
            threadSummaryRefreshInFlight.delete(inFlightKey);
          }
        });
      threadSummaryRefreshInFlight.set(inFlightKey, inFlight);
    }
  }

  // For iMessage we merge messages across all sibling threads belonging
  // to the same Person — chat.db creates separate chats for the phone
  // and email handle of one human, but the operator wants a single
  // conversation view. LinkedIn keeps thread-scoped messages.
  const messageThreadFilter =
    thread.platform === "IMESSAGE"
      ? { threadId: { in: await siblingThreadIds(thread.platform, thread.personId) } }
      : { threadId: thread.id };
  const [messagesDescWithExtra, lastInbound, lastOutbound] = await Promise.all([
    prisma.message.findMany({
      where: messageThreadFilter,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: messageLimit + 1,
      ...(beforeMessageId ? { cursor: { id: beforeMessageId }, skip: 1 } : {})
    }),
    prisma.message.findFirst({
      where: { ...messageThreadFilter, direction: "IN" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }]
    }),
    prisma.message.findFirst({
      where: { ...messageThreadFilter, direction: "OUT" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }]
    })
  ]);
  const hasOlderMessages = messagesDescWithExtra.length > messageLimit;
  const pageMessagesDesc = messagesDescWithExtra.slice(0, messageLimit);
  const pageMessages = [...pageMessagesDesc].reverse();
  const olderCursor = hasOlderMessages
    ? pageMessages[0]?.id ?? null
    : null;

  // Operator self-description from Settings + the contact's own enrichment
  // snapshot. Both feed `generateSuggestedReplies` so replies stay in the
  // operator's domain ("how I write", "things I care about") and ground
  // references in real fields the contact has shared rather than inventing
  // details. Both can be null (operator hasn't filled Settings, contact
  // not enriched yet) — the prompt gracefully omits the section in that
  // case.
  const [operatorProfile, contactSnapshot] = await Promise.all([
    settingsStore.getOperatorProfile(),
    conversationStartersService.toContactSnapshot(thread.personId, thread.person.displayName)
  ]);

  // Recent exchange: oldest-first window of the last ~6 turns. Gives
  // generateSuggestedReplies enough context to spot when the operator has
  // already engaged on the topic (e.g. operator said "yhh why?" then the
  // contact clarified). Drawn from the same pageMessages already fetched.
  // Doubles as per-thread voice calibration — the model picks up register,
  // vocabulary, and punctuation habits from the operator's own OUT entries.
  const RECENT_TURN_WINDOW = 6;
  const recentMessages = pageMessages
    .slice(-RECENT_TURN_WINDOW)
    .map((m) => ({
      direction: m.direction as "IN" | "OUT",
      text: m.text,
      timestamp: m.timestamp.toISOString()
    }));
  // needsReply mirrors scan-queue's derivation: the contact's last message
  // is newer than the operator's. When false, generateSuggestedReplies
  // switches to "reopen mode" — conversation starters grounded in
  // transcript details, not replies to a pending ask.
  const aiNeedsReply = Boolean(
    lastInbound && (!lastOutbound || lastInbound.timestamp > lastOutbound.timestamp)
  );

  const aiInputs = {
    summary: thread.rollingSummary ?? `Conversation with ${thread.person.displayName}.`,
    whatTheyWant: thread.whatTheyWant ?? "No clear ask yet.",
    openLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
    recentMessages,
    needsReply: aiNeedsReply,
    // Drives the voice tier (LinkedIn → formal; everything else → casual)
    // so the suggested-reply chips run on the right register, not just
    // the generic SYSTEM_PROMPT.
    platform: thread.platform as PlatformName,
    // Drives the "Polite decline" reply variant when the thread is outreach.
    category: (thread.category ?? null) as "outreach" | "genuine" | null,
    // Late-reply detection: when the last inbound is much older than the
    // most recent outbound (or there's no outbound yet) the prompt asks
    // the model to acknowledge the gap. Day-bucketed ISO is enough for
    // the cache key — minute-precision would invalidate replies every
    // few minutes for no reason.
    lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
    lastOutboundAt: lastOutbound?.timestamp.toISOString() ?? null,
    operatorProfile,
    contact: contactSnapshot
  };
  // Cache key over the AI inputs. Hashing keeps the column short and
  // doesn't leak content into the audit log if anyone ever inspects it. As
  // long as none of these inputs change, replies stay valid — refresh()
  // calls on Save draft / Snooze / Mark done won't trigger a fresh OpenAI
  // hit, only a real conversation change does. The late-reply state is
  // bucketed by day (UTC) so the cache holds as the gap grows hour by
  // hour but invalidates when the gap actually crosses a 14d / 30d / 60d
  // bucket boundary. Operator profile + contact enrichment fingerprints
  // are folded in too: an edit in Settings or a re-enrichment must
  // invalidate stale replies.
  const lateBucket = (() => {
    if (!aiInputs.lastInboundAt) return "n";
    const inboundMs = Date.parse(aiInputs.lastInboundAt);
    if (!Number.isFinite(inboundMs)) return "n";
    const outboundMs = aiInputs.lastOutboundAt ? Date.parse(aiInputs.lastOutboundAt) : NaN;
    if (Number.isFinite(outboundMs) && outboundMs >= inboundMs) return "n";
    const gapDays = (Date.now() - inboundMs) / (1000 * 60 * 60 * 24);
    if (gapDays >= 60) return "long";
    if (gapDays >= 30) return "medium";
    if (gapDays >= 14) return "short";
    return "n";
  })();
  // Cache key folds in the full recent-message window (timestamp + text)
  // so a new turn in the exchange invalidates the cached replies. Mode
  // flag (needsReply) is included separately so a flip between active
  // and reopen mode also busts the cache even if the recent window text
  // hasn't otherwise changed. Platform is folded in so a voice-tier
  // change (LinkedIn → formal vs casual) also invalidates.
  const recentSignature = aiInputs.recentMessages
    .map((m) => `${m.direction}:${m.timestamp}:${m.text}`)
    .join("|");
  const cacheKey = createHash("sha256")
    .update(`v3|${aiInputs.summary}|${aiInputs.whatTheyWant}|${aiInputs.openLoops.join("")}|${aiInputs.needsReply ? 1 : 0}|${recentSignature}|${aiInputs.category ?? "_"}|${lateBucket}|${operatorProfileFingerprint(operatorProfile)}|${contactSnapshotFingerprint(contactSnapshot)}|${thread.platform}`)
    .digest("hex");

  let suggested: SuggestedRepliesOutput | undefined;
  let suggestedRepliesStatus: "ready" | "generating" = "ready";
  if (thread.suggestedRepliesCacheKey === cacheKey && thread.suggestedRepliesJson) {
    try {
      suggested = JSON.parse(thread.suggestedRepliesJson);
    } catch {
      // Corrupt cache row — fall through and regenerate.
      suggested = undefined;
    }
  }
  if (!suggested) {
    const inFlightKey = `${thread.id}:${cacheKey}`;
    if (!suggestedRepliesInFlight.has(inFlightKey)) {
      const inFlight = withInFlightTimeout(
        aiService.generateSuggestedReplies(aiInputs),
        `generateSuggestedReplies(${thread.id})`
      )
        .then(async (generated) => {
          await prisma.thread.update({
            where: { id: thread.id },
            data: {
              suggestedRepliesJson: JSON.stringify(generated),
              suggestedRepliesCacheKey: cacheKey
            }
          });
          eventBus.emit({
            type: "SUGGESTED_REPLIES_UPDATED",
            jobId: uuid(),
            threadId: thread.id
          });
          return generated;
        })
        .catch(async (error) => {
          console.warn(
            `[ai] background suggested replies failed for threadId=${thread.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          // Persist empty replies + the cacheKey so (a) the dashboard's
          // next /data/thread fetch sees a cache hit and reports
          // suggestedRepliesStatus="ready" (clears the "Generating
          // suggestions…" spinner) and (b) we don't spin up another
          // doomed generation on the very next refetch when the inputs
          // haven't changed. The cache invalidates naturally when a new
          // inbound message arrives or the thread is re-summarised.
          try {
            await prisma.thread.update({
              where: { id: thread.id },
              data: {
                suggestedRepliesJson: JSON.stringify(emptySuggestedReplies),
                suggestedRepliesCacheKey: cacheKey
              }
            });
          } catch (persistError) {
            console.warn(
              `[ai] also failed to persist empty replies for threadId=${thread.id}: ${
                persistError instanceof Error ? persistError.message : String(persistError)
              }`
            );
          }
          eventBus.emit({
            type: "SUGGESTED_REPLIES_UPDATED",
            jobId: uuid(),
            threadId: thread.id
          });
          return emptySuggestedReplies;
        })
        .finally(() => {
          if (suggestedRepliesInFlight.get(inFlightKey) === inFlight) {
            suggestedRepliesInFlight.delete(inFlightKey);
          }
        });
      suggestedRepliesInFlight.set(inFlightKey, inFlight);
    }
    suggested = emptySuggestedReplies;
    suggestedRepliesStatus = "generating";
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

  // Surfaced so the thread page can render scheduled sends as pinned pills
  // above the timeline without a second fetch. Only SCHEDULED rows leak
  // here — PENDING/SENT/FAILED already drive the live optimistic-UI flow.
  const scheduledSendRows = await prisma.sendRequest.findMany({
    where: { threadId: thread.id, status: "SCHEDULED" },
    orderBy: { scheduledFor: "asc" }
  });

  // Cross-thread relationship memory — last message from each OTHER
  // thread with the same Person, plus the Person's notes/tags. Powers
  // the dashboard's memory chip and feeds the AI compose prompts so
  // drafts don't repeat questions answered in another conversation.
  const otherThreads = await prisma.thread.findMany({
    where: {
      personId: thread.personId,
      id: { not: thread.id },
      archivedAt: null
    },
    orderBy: { lastMessageAt: "desc" },
    take: 5,
    select: {
      id: true,
      platform: true,
      lastMessageAt: true,
      lastMessagePreview: true,
      whatTheyWant: true
    }
  });
  const relationshipMemory = {
    otherThreadCount: otherThreads.length,
    recentExchanges: otherThreads.map((t) => ({
      threadId: t.id,
      platform: t.platform,
      lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
      preview: t.lastMessagePreview ?? null,
      whatTheyWant: t.whatTheyWant ?? null
    })),
    notes: thread.person.notes ?? null,
    tags: thread.person.tagsJson ? (JSON.parse(thread.person.tagsJson) as string[]) : []
  };

  res.json({
    id: thread.id,
    personId: thread.person.id,
    personName: thread.person.displayName,
    personAvatarUrl: thread.person.avatarUrl ?? null,
    platform: thread.platform,
    riskLevel: thread.riskLevel,
    riskReason: thread.riskReason,
    snoozedUntil: thread.snoozedUntil?.toISOString() ?? null,
    unreadCount: thread.unreadCount,
    needsReply: thread.needsReply,
    summary: thread.rollingSummary,
    whatTheyWant: thread.whatTheyWant,
    openLoops: filterDismissedOpenLoops(
      thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
      thread.dismissedOpenLoopsJson
    ),
    dismissedOpenLoops: thread.dismissedOpenLoopsJson
      ? (JSON.parse(thread.dismissedOpenLoopsJson) as string[])
      : [],
    toneNotes: thread.toneNotesJson ? (JSON.parse(thread.toneNotesJson) as string[]) : [],
    draft: thread.drafts[0]?.text ?? "",
    contextUpdatedAt: thread.updatedAt.toISOString(),
    relationshipMemory,
    messages: pageMessages.map((message) => ({
      id: message.id,
      platformMessageKey: message.platformMessageKey,
      direction: message.direction,
      timestamp: message.timestamp.toISOString(),
      text: message.text,
      senderName: message.senderName ?? null,
      sentVia: message.sentVia ?? null,
      // App-level reply parent (cuid). The dashboard prefers this over the
      // Apple-native `raw.replyToGuid` when both are present so threads
      // started from the dashboard's focused composer reconcile correctly.
      replyToMessageId: message.replyToMessageId ?? null,
      raw: message.rawJson ? JSON.parse(message.rawJson) : null,
      attachments: message.attachmentsJson ? JSON.parse(message.attachmentsJson) : []
    })),
    messagePage: {
      hasOlder: hasOlderMessages,
      olderCursor,
      limit: messageLimit
    },
    suggestedReplies: suggested,
    suggestedRepliesStatus,
    scheduledSends: scheduledSendRows.map((row) => ({
      clientSendId: row.clientSendId,
      text: row.requestText,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString()
    })),
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

app.get("/data/platforms", asyncRoute(async (_req, res) => {
  const settings = await settingsStore.getSettings();
  const platforms = await prisma.platform.findMany({ orderBy: { name: "asc" } });
  const failureActions = ["SCAN_FAIL", "SELECTOR_FAIL", "SCAN_AUTH_REQUIRED"] as const;
  const recoveryActions = ["SCAN_END", "SELECTOR_TEST", "POST_SCAN_END", "POST_PLATFORM_TEST_SELECTORS_END"] as const;

  const data = await Promise.all(
    (["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"] as PlatformName[]).map(async (platform) => {
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

// Toggle whether an open-loop string is dismissed for a thread. The dashboard
// thread-pane renders an "Open loops" checklist; ticking persists the loop in
// dismissedOpenLoopsJson so it stays hidden even after the AI re-summarises
// the thread (which keeps emitting the same loop until it's actually closed
// in the conversation).
app.post("/control/thread/:threadId/open-loop", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const { loop, dismissed } = z
    .object({ loop: z.string().min(1).max(2_000), dismissed: z.boolean() })
    .parse(req.body ?? {});
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true, dismissedOpenLoopsJson: true }
  });
  if (!thread) {
    res.status(404).json({ error: "thread not found" });
    return;
  }
  const current = new Set(
    thread.dismissedOpenLoopsJson ? (JSON.parse(thread.dismissedOpenLoopsJson) as string[]) : []
  );
  if (dismissed) current.add(loop);
  else current.delete(loop);
  const nextJson = current.size > 0 ? JSON.stringify(Array.from(current)) : null;
  await prisma.thread.update({
    where: { id: threadId },
    data: { dismissedOpenLoopsJson: nextJson }
  });
  res.json({ ok: true, dismissedOpenLoops: Array.from(current) });
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
  const archivedRows = await loadVisibleThreadRows({ archived: true });
  const archivedCounts = personThreadCounts(archivedRows);
  const rows = archivedRows
    .map((row) => toInboxRow(row, archivedCounts.get(personThreadCountKey(row.source.platform, row.source.personId)) ?? 1))
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
  const [activeRows, scheduledRows, recentDoneRows] = await Promise.all([
    prisma.sendRequest.findMany({
      where: { status: "PENDING" },
      include: {
        thread: {
          include: { person: true }
        }
      },
      orderBy: { createdAt: "asc" }
    }),
    prisma.sendRequest.findMany({
      where: { status: "SCHEDULED" },
      include: {
        thread: {
          include: { person: true }
        }
      },
      orderBy: { scheduledFor: "asc" }
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
    scheduled: scheduledRows.map((row) => ({
      clientSendId: row.clientSendId,
      threadId: row.threadId,
      personName: row.thread.person.displayName,
      platform: row.thread.platform,
      status: row.status,
      requestText: row.requestText,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      enqueuedAt: row.createdAt.toISOString()
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
  const [people, visibleThreadGroups, enrichments] = await Promise.all([
    prisma.person.findMany({
      orderBy: {
        updatedAt: "desc"
      }
    }),
    loadVisibleThreadRows(),
    // Pull only the lightweight fields used in the list view; the full
    // contact pane fetches via /data/person/:id when a row is selected.
    prisma.personEnrichment.findMany({
      select: { personId: true, headline: true, currentRole: true, currentCompany: true, location: true }
    })
  ]);

  const enrichmentByPerson = new Map<string, { headline: string | null; currentRole: string | null; currentCompany: string | null; location: string | null }>();
  for (const e of enrichments) {
    enrichmentByPerson.set(e.personId, {
      headline: e.headline,
      currentRole: e.currentRole,
      currentCompany: e.currentCompany,
      location: e.location
    });
  }

  const peopleCounts = personThreadCounts(visibleThreadGroups);
  const groupedByPerson = new Map<string, ReturnType<typeof toInboxRow>[]>();
  for (const group of visibleThreadGroups) {
    const count = peopleCounts.get(personThreadCountKey(group.source.platform, group.source.personId)) ?? 1;
    const shaped = toInboxRow(group, count);
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
      const enrichment = enrichmentByPerson.get(person.id) ?? null;

      return {
        id: person.id,
        name: person.displayName,
        platform: person.platform,
        avatarUrl: person.avatarUrl ?? null,
        notes: person.notes,
        tags: person.tagsJson ? JSON.parse(person.tagsJson) : [],
        lastInteractionAt: latest,
        risk,
        hasUnresolvedIdentityWarning: unresolvedThreadCount > 0 || undefined,
        unresolvedThreadCount: unresolvedThreadCount || undefined,
        enrichedAt: person.enrichedAt ? person.enrichedAt.toISOString() : null,
        enrichmentFailedReason: person.enrichmentFailedReason ?? null,
        headline: enrichment?.headline ?? null,
        currentRole: enrichment?.currentRole ?? null,
        currentCompany: enrichment?.currentCompany ?? null,
        location: enrichment?.location ?? null
      };
    })
  );
}));

app.get("/data/person/:personId", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  const enrichment = await prisma.personEnrichment.findUnique({ where: { personId } });

  // Generate (or read cached) summary + starters lazily on read. Both
  // calls are no-ops when the AI client is unconfigured (return null).
  // We deliberately do NOT await starters by default — they're only
  // generated when the user clicks "Start a conversation".
  const summary = enrichment ? await conversationStartersService.getOrGenerateSummary(personId, person.displayName) : null;
  const starters = req.query.includeStarters === "1" && enrichment
    ? await conversationStartersService.getOrGenerateStarters(personId, person.displayName, person.platform as PlatformName)
    : enrichment?.startersJson
    ? JSON.parse(enrichment.startersJson)
    : null;

  res.json({
    person: {
      id: person.id,
      name: person.displayName,
      platform: person.platform,
      profileUrl: person.profileUrl,
      profileUrlSource: person.profileUrlSource ?? null,
      enrichedAt: person.enrichedAt ? person.enrichedAt.toISOString() : null,
      enrichmentFailedReason: person.enrichmentFailedReason ?? null,
      avatarUrl: person.avatarUrl ?? null,
      tags: person.tagsJson ? JSON.parse(person.tagsJson) : [],
      notes: person.notes
    },
    enrichment: enrichment
      ? {
          headline: enrichment.headline,
          about: enrichment.about,
          location: enrichment.location,
          currentCompany: enrichment.currentCompany,
          currentRole: enrichment.currentRole,
          mutualCount: enrichment.mutualCount,
          followersCount: enrichment.followersCount ?? null,
          experience: enrichment.experienceJson ? JSON.parse(enrichment.experienceJson) : [],
          education: enrichment.educationJson ? JSON.parse(enrichment.educationJson) : [],
          skills: enrichment.skillsJson ? JSON.parse(enrichment.skillsJson) : [],
          services: enrichment.servicesJson ? JSON.parse(enrichment.servicesJson) : [],
          licenses: enrichment.licensesJson ? JSON.parse(enrichment.licensesJson) : [],
          recentPosts: enrichment.recentPostsJson ? JSON.parse(enrichment.recentPostsJson) : [],
          recentComments: enrichment.recentCommentsJson ? JSON.parse(enrichment.recentCommentsJson) : [],
          recentReactions: enrichment.recentReactionsJson ? JSON.parse(enrichment.recentReactionsJson) : [],
          mutualNames: enrichment.mutualNamesJson ? JSON.parse(enrichment.mutualNamesJson) : []
        }
      : null,
    summary,
    starters
  });
}));

// Promote / edit / dismiss the heuristic name suggestion. The runner
// guesses a contact's first name from outbound greetings ("Hi Marianne")
// when a Person's displayName is just a phone or email; the dashboard
// surfaces it as a "Maybe …" pill with confirm / edit / reject actions
// that hit this endpoint.
//
//   action: "confirm"  → set displayName = inferredName, clear inferredName
//   action: "rename"   → set displayName = <name>, clear inferredName
//   action: "dismiss"  → clear inferredName (keep displayName as-is)
app.post("/control/person/:personId/rename", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const payload = z
    .object({
      action: z.enum(["confirm", "rename", "dismiss"]),
      name: z.string().trim().min(1).max(120).optional()
    })
    .parse(req.body ?? {});
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  if (payload.action === "confirm") {
    if (!person.inferredName) {
      res.status(409).json({ error: "no inferred name to confirm" });
      return;
    }
    const updated = await prisma.person.update({
      where: { id: personId },
      data: { displayName: person.inferredName, inferredName: null }
    });
    res.json({ status: "ok", displayName: updated.displayName });
    return;
  }
  if (payload.action === "rename") {
    if (!payload.name) {
      res.status(400).json({ error: "name is required for rename" });
      return;
    }
    const updated = await prisma.person.update({
      where: { id: personId },
      data: { displayName: payload.name, inferredName: null }
    });
    res.json({ status: "ok", displayName: updated.displayName });
    return;
  }
  // dismiss
  await prisma.person.update({
    where: { id: personId },
    data: { inferredName: null }
  });
  res.json({ status: "ok" });
}));

app.post("/control/person/:personId/notes", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const { notes } = z
    .object({ notes: z.string().max(10_000).nullable().optional() })
    .parse(req.body ?? {});
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  const trimmed = typeof notes === "string" ? notes : null;
  await prisma.person.update({
    where: { id: personId },
    data: { notes: trimmed && trimmed.length > 0 ? trimmed : null }
  });
  res.json({ status: "ok" });
}));

app.post("/control/person/:personId/enrich", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const wait = req.query.wait === "1" || req.query.wait === "true";
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  if (!wait) {
    await enrichmentQueue.enqueue(personId, "manual");
    res.json({ status: "queued" });
    return;
  }
  const result = await enrichmentQueue.runOnce(personId);
  if ("ok" in result) {
    res.json({ status: "ok" });
    return;
  }
  if ("deferred" in result) {
    await enrichmentQueue.enqueue(personId, "manual");
    res.json({ status: "deferred", reason: "scan or send is currently active; enqueued" });
    return;
  }
  // Translate the runner's terse reason codes into operator-readable
  // messages. The `reason` field stays for telemetry; `error` is what
  // the dashboard surfaces in the UI (apiPost prefers `error`).
  const reasonMessages: Record<string, string> = {
    not_found: "We don't have a LinkedIn profile URL for this person yet.",
    auth_required: "LinkedIn session needs re-authenticating in the runner.",
    selectors_outdated:
      "LinkedIn changed their page layout - the profile parser needs an update before enrichment can run.",
    unknown: "LinkedIn profile fetch failed; check the runner logs."
  };
  const message =
    reasonMessages[result.reason] ?? `Enrichment failed: ${result.reason}`;
  res.status(502).json({ status: "failed", reason: result.reason, error: message });
}));

// Manual profile-URL capture. The LinkedIn scan currently doesn't pull a
// profile URL from the inbox sidebar, so people created from a scan land
// without one and the enrichment queue can't visit them. This endpoint
// lets the operator paste a known profile URL onto a person row so the
// next enrichment run has a target. Mirrors the shape of /control/self/enrich.
app.post("/control/person/:personId/profile-url", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const payload = z
    .object({ profileUrl: z.string().url() })
    .parse(req.body);
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  await prisma.person.update({
    where: { id: personId },
    data: {
      profileUrl: payload.profileUrl,
      profileUrlSource: "manual",
      enrichmentFailedReason: null
    }
  });
  res.json({ status: "ok", profileUrl: payload.profileUrl });
}));

// Bulk-enqueue every person with a known profile URL for re-enrichment.
// Returns the count of jobs enqueued. The queue handles its own pacing
// and concurrency, so we don't need to throttle here beyond the
// per-person coalescing inside `enqueue` (manual triggers always create
// a fresh row so a Scan-all click while another is in-flight will still
// produce visible progress).
app.post("/control/people/scan-all", asyncRoute(async (req, res) => {
  const payload = z
    .object({ scope: z.enum(["all", "new"]).optional() })
    .parse(req.body ?? {});
  const scope = payload.scope ?? "all";
  const candidates = await prisma.person.findMany({
    where: {
      profileUrl: { not: null },
      // "new" = no enrichment tag visible under the name in the dashboard
      // (matches the headline ?? role/company fallback in people/page.tsx).
      // Either no PersonEnrichment row at all, or one with all three display
      // fields blank — covers prior failed attempts that left a partial row.
      ...(scope === "new"
        ? {
            OR: [
              { enrichment: { is: null } },
              {
                enrichment: {
                  is: { headline: null, currentRole: null, currentCompany: null }
                }
              }
            ]
          }
        : {})
    },
    select: { id: true }
  });
  for (const candidate of candidates) {
    await enrichmentQueue.enqueue(candidate.id, "manual");
  }
  res.json({ status: "queued", count: candidates.length, scope });
}));

// AI-driven friendship summary for an iMessage contact (Q9). Aggregates
// every message across every thread the operator has with this person
// and asks the model for four sections: how-you-know-each-other,
// recent-topics, inside-jokes, vibe. No caching for now; regenerated
// each time the operator hits "Generate" in the profile drawer.
app.post("/control/person/:personId/friendship-summary", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  // Pull up to ~600 messages across all threads with this person, oldest
  // first - enough to surface earliest-message context for the
  // how-you-know-each-other section without blowing the prompt.
  const messages = await prisma.message.findMany({
    where: { thread: { personId } },
    orderBy: { timestamp: "asc" },
    take: 600,
    select: { direction: true, text: true, timestamp: true }
  });
  const result = await aiService.summarisePersonForFriendship({
    displayName: person.displayName,
    messages: messages.map((m) => ({
      direction: m.direction as "IN" | "OUT",
      text: m.text,
      timestamp: m.timestamp.toISOString()
    }))
  });
  res.json(result);
}));

// Free-form Q&A about a person (Q10). Same context pull as friendship
// summary - all messages across all threads with this person - plus the
// contact's enrichment snapshot + operator notes/tags. The AI prompt
// enforces "only answer from provided context, cite dates when relevant".
app.post("/control/person/:personId/ask", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const { question } = z
    .object({ question: z.string().min(1).max(2_000) })
    .parse(req.body ?? {});
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: { enrichment: true }
  });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  const messages = await prisma.message.findMany({
    where: { thread: { personId } },
    orderBy: { timestamp: "asc" },
    take: 600,
    select: { direction: true, text: true, timestamp: true }
  });
  const tags = person.tagsJson ? (JSON.parse(person.tagsJson) as string[]) : [];
  const contactSnapshot = person.enrichment
    ? {
        displayName: person.displayName,
        headline: person.enrichment.headline,
        about: person.enrichment.about,
        location: person.enrichment.location,
        currentRole: person.enrichment.currentRole,
        currentCompany: person.enrichment.currentCompany,
        followersCount: person.enrichment.followersCount,
        mutualCount: person.enrichment.mutualCount,
        experience: person.enrichment.experienceJson
          ? JSON.parse(person.enrichment.experienceJson)
          : undefined,
        education: person.enrichment.educationJson
          ? JSON.parse(person.enrichment.educationJson)
          : undefined,
        skills: person.enrichment.skillsJson
          ? JSON.parse(person.enrichment.skillsJson)
          : undefined,
        recentPosts: person.enrichment.recentPostsJson
          ? JSON.parse(person.enrichment.recentPostsJson)
          : undefined
      }
    : null;
  const result = await aiService.askAboutPerson({
    displayName: person.displayName,
    question,
    messages: messages.map((m) => ({
      direction: m.direction as "IN" | "OUT",
      text: m.text,
      timestamp: m.timestamp.toISOString()
    })),
    contact: contactSnapshot,
    notes: person.notes,
    tags
  });
  res.json(result);
}));

// Operator's free-text self-description — what they care about and how
// they write. Distinct from /data/self (LinkedIn-derived). The AI prompts
// (suggested replies + composeInVoice) read this so drafts sound like the
// operator and stay within their domain.
app.get("/data/operator-profile", asyncRoute(async (_req, res) => {
  const profile = await settingsStore.getOperatorProfile();
  res.json(profile);
}));

app.post("/control/operator-profile", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      about: z.string().max(4000).optional(),
      interests: z.string().max(4000).optional()
    })
    .parse(req.body);
  const updated = await settingsStore.updateOperatorProfile(payload);
  res.json(updated);
}));

app.post("/control/platform/open-browser", asyncRoute(async (req, res) => {
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"]) }).parse(req.body);
  await withPlatformControlLock(payload.platform, async () => {
    // The zod payload restricts platform to the three with adapters today,
    // but the adapters map is now Partial — narrow via requireAdapter to
    // keep the runtime contract explicit (and to surface a clean error if
    // someone removes an adapter without updating the zod enum).
    const adapter = requireAdapter(payload.platform);
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

/**
 * Pre-warm the suggested-replies cache for a thread. /today calls this
 * for the top 3 threads so opening any of them shows AI suggestions
 * instantly. No-op when the cache is already fresh.
 */
app.post("/control/thread/:threadId/predraft", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { person: true }
  });
  if (!thread) {
    res.status(404).json({ error: "thread_not_found" });
    return;
  }

  // Fetch the last ~6 turns to mirror the /data/thread call site. Pulling
  // the full recent window means a predraft pre-warm builds the same
  // recentSignature, so the cacheKey matches and the operator's next
  // /data/thread fetch reuses the warmed cache row.
  const RECENT_TURN_WINDOW = 6;
  const [recentTurnsDesc, operatorProfile, contactSnapshot] = await Promise.all([
    prisma.message.findMany({
      where: { threadId },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: RECENT_TURN_WINDOW,
      select: { direction: true, text: true, timestamp: true }
    }),
    settingsStore.getOperatorProfile(),
    conversationStartersService.toContactSnapshot(thread.personId, thread.person.displayName)
  ]);
  const recentMessages = [...recentTurnsDesc].reverse().map((m) => ({
    direction: m.direction as "IN" | "OUT",
    text: m.text,
    timestamp: m.timestamp.toISOString()
  }));
  const aiNeedsReply = Boolean(
    thread.lastInboundAt &&
      (!thread.lastOutboundAt || thread.lastInboundAt > thread.lastOutboundAt)
  );

  const aiInputs = {
    summary: thread.rollingSummary ?? "",
    whatTheyWant: thread.whatTheyWant ?? "",
    openLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
    recentMessages,
    needsReply: aiNeedsReply,
    platform: thread.platform as PlatformName,
    category: (thread.category as "outreach" | "genuine" | null) ?? null,
    lastInboundAt: thread.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: thread.lastOutboundAt?.toISOString() ?? null,
    operatorProfile,
    contact: contactSnapshot
  };
  const lateBucket = (() => {
    if (!aiInputs.lastInboundAt) return "n";
    const inboundMs = Date.parse(aiInputs.lastInboundAt);
    if (!Number.isFinite(inboundMs)) return "n";
    const outboundMs = aiInputs.lastOutboundAt ? Date.parse(aiInputs.lastOutboundAt) : NaN;
    if (Number.isFinite(outboundMs) && outboundMs >= inboundMs) return "n";
    const gapDays = (Date.now() - inboundMs) / (1000 * 60 * 60 * 24);
    if (gapDays >= 60) return "long";
    if (gapDays >= 30) return "medium";
    if (gapDays >= 14) return "short";
    return "n";
  })();
  // Mirror the inline /data/thread cacheKey shape so a predraft pre-warm
  // and a subsequent /data/thread fetch hit the same cache row. Platform
  // is folded in so a voice-tier change also invalidates.
  const recentSignature = aiInputs.recentMessages
    .map((m) => `${m.direction}:${m.timestamp}:${m.text}`)
    .join("|");
  const cacheKey = createHash("sha256")
    .update(`v3|${aiInputs.summary}|${aiInputs.whatTheyWant}|${aiInputs.openLoops.join("")}|${aiInputs.needsReply ? 1 : 0}|${recentSignature}|${aiInputs.category ?? "_"}|${lateBucket}|${operatorProfileFingerprint(operatorProfile)}|${contactSnapshotFingerprint(contactSnapshot)}|${thread.platform}`)
    .digest("hex");

  if (thread.suggestedRepliesCacheKey === cacheKey && thread.suggestedRepliesJson) {
    res.json({ status: "cached", cacheKey });
    return;
  }

  // Fire and forget — the operator's next /data/thread fetch picks
  // up the cache once the AI call resolves.
  void aiService
    .generateSuggestedReplies(aiInputs)
    .then(async (generated) => {
      await prisma.thread.update({
        where: { id: threadId },
        data: {
          suggestedRepliesJson: JSON.stringify(generated),
          suggestedRepliesCacheKey: cacheKey
        }
      });
      eventBus.emit({
        type: "SUGGESTED_REPLIES_UPDATED",
        jobId: uuid(),
        threadId
      });
    })
    .catch(async (error) => {
      console.warn(
        `[predraft] failed for threadId=${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      // Mirror the inline-generation failure path: persist empty replies
      // with the cacheKey + emit SUGGESTED_REPLIES_UPDATED so the
      // dashboard transitions out of "generating" and a follow-up fetch
      // doesn't loop into another doomed generation.
      try {
        await prisma.thread.update({
          where: { id: threadId },
          data: {
            suggestedRepliesJson: JSON.stringify(emptySuggestedReplies),
            suggestedRepliesCacheKey: cacheKey
          }
        });
      } catch (persistError) {
        console.warn(
          `[predraft] also failed to persist empty replies for threadId=${threadId}: ${
            persistError instanceof Error ? persistError.message : String(persistError)
          }`
        );
      }
      eventBus.emit({
        type: "SUGGESTED_REPLIES_UPDATED",
        jobId: uuid(),
        threadId
      });
    });

  res.json({ status: "queued", cacheKey });
}));

/**
 * Rewrite a draft in the operator's voice without an explicit intent.
 * Used by the composer's voice-match indicator: when the local
 * heuristic flags a draft as low-voice, this endpoint converts the
 * existing text in place using composeInVoice + the thread's outbound
 * history. Returned text is voice-rule-cleaned.
 */
app.post("/control/thread/:threadId/voice-rewrite", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z.object({ draft: z.string().min(1).max(5000) }).parse(req.body);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: { orderBy: { timestamp: "asc" }, take: 80 }
    }
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const voiceSamples = thread.messages
    .filter((m) => m.direction === "OUT")
    .map((m) => m.text);

  const [rewriteOperatorProfile, rewriteContactSnapshot] = await Promise.all([
    settingsStore.getOperatorProfile(),
    conversationStartersService.toContactSnapshot(thread.personId, thread.person.displayName)
  ]);

  const text = await aiService.composeInVoice({
    intent: `Rewrite the message below in my voice, preserving the meaning. Keep it about the same length. Message: ${payload.draft}`,
    platform: thread.platform as PlatformName,
    displayName: thread.person.displayName,
    voiceSamples,
    threadMessages: thread.messages.map((m) => ({
      direction: m.direction as "IN" | "OUT",
      text: m.text,
      timestamp: m.timestamp.toISOString()
    })),
    operatorProfile: rewriteOperatorProfile,
    contact: rewriteContactSnapshot
  });

  res.json({ text });
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
  // If the operator hasn't replied to the latest inbound, "Mark as
  // handled" really means "I'm done with this conversation, take it
  // out of my view" — so we archive the thread alongside clearing the
  // needs-reply / risk fields. When the operator already replied,
  // mark-done is just a confirmation and we leave the archive state
  // alone (issue #246).
  const existing = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { lastInboundAt: true, lastOutboundAt: true, archivedAt: true }
  });
  const inbound = existing?.lastInboundAt?.getTime() ?? 0;
  const outbound = existing?.lastOutboundAt?.getTime() ?? 0;
  const operatorHasNotReplied = !existing?.lastOutboundAt || inbound > outbound;
  const shouldArchive = operatorHasNotReplied && !existing?.archivedAt;

  await prisma.thread.update({
    where: { id: threadId },
    data: {
      needsReply: false,
      unreadCount: 0,
      riskLevel: "GREEN",
      riskReason: "Marked done manually",
      slaDueAt: null,
      ...(shouldArchive ? { archivedAt: new Date() } : {})
    }
  });

  await auditService.log({
    action: "MARK_DONE",
    stage: "Send",
    status: "OK",
    details: { threadId, archived: shouldArchive }
  });

  res.json({ status: "ok", archived: shouldArchive });
}));

app.get("/control/thread/:threadId/suggest-snooze", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: {
      whatTheyWant: true,
      rollingSummary: true,
      lastInboundAt: true,
      lastInboundHash: true,
      person: { select: { displayName: true } },
      messages: {
        where: { direction: "IN" },
        orderBy: { timestamp: "desc" },
        take: 1,
        select: { text: true, timestamp: true }
      }
    }
  });

  if (!thread) {
    res.status(404).json({ error: "thread_not_found" });
    return;
  }

  const lastInbound = thread.messages[0];
  const result = await aiService.suggestSnoozeTimings({
    displayName: thread.person.displayName,
    lastInboundText: lastInbound?.text ?? "",
    lastInboundAt: thread.lastInboundAt?.toISOString() ?? null,
    summary: thread.rollingSummary,
    whatTheyWant: thread.whatTheyWant
  });

  res.json(result);
}));

app.post("/control/thread/:threadId/snooze", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  const payload = z.object({ hours: z.number().int().min(1).max(72) }).parse(req.body);
  const due = new Date(Date.now() + payload.hours * 60 * 60 * 1000);

  await prisma.thread.update({
    where: { id: threadId },
    data: {
      slaDueAt: due,
      snoozedUntil: due,
      riskReason: "Snoozed for " + payload.hours + "h"
    }
  });

  await auditService.log({
    action: "SNOOZE",
    stage: "Scan",
    status: "OK",
    details: { threadId, hours: payload.hours }
  });

  res.json({ status: "ok", dueAt: due.toISOString(), snoozedUntil: due.toISOString() });
}));

app.post("/control/thread/:threadId/unsnooze", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);

  await prisma.thread.update({
    where: { id: threadId },
    data: {
      snoozedUntil: null,
      riskReason: null
    }
  });

  await auditService.log({
    action: "UNSNOOZE",
    stage: "Scan",
    status: "OK",
    details: { threadId }
  });

  res.json({ status: "ok", threadId });
}));

app.post("/control/platform/reset-session", asyncRoute(async (req, res) => {
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"]).optional() }).parse(req.body ?? {});

  await withGlobalResetLock(async () => {
    scanQueue.requestAbort("session_reset:manual");
    // Drop AI bookkeeping along with connect promises so a hung pre-reset
    // call can't keep a thread id slot occupied across the reset.
    connectInFlight.clear();
    suggestedRepliesInFlight.clear();
    threadSummaryRefreshInFlight.clear();

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

// Restart the runner process — full self-bootstrap so the operator
// never needs to drop into a terminal. Spawns a detached shell that:
//   1. Waits 1s for THIS process to exit (so port 4001 frees up)
//   2. Rebuilds @inbox-os/core then @inbox-os/runner (catches any
//      uncommitted source-level changes, matches what `npm run build`
//      produces on a fresh checkout)
//   3. Starts a fresh `node apps/runner/dist/index.js`
// Output is appended to /tmp/runner-restart.log so the operator can
// `tail -f` it if the relaunch errors out.
//
// The detached child becomes a session leader (`detached: true`) and
// we `unref()` it so the parent can exit cleanly without waiting on
// the helper. Stdio is redirected to a log fd, not the parent — that
// way nothing the helper writes blocks the parent's exit either.
//
// Why a shell wrapper instead of spawning npm directly: chaining
// build → start needs sequencing, and a shell `&&` chain is the
// least surprising way to express that. The script also `cd`s to
// projectRoot so it works no matter what cwd the runner was launched
// from.
app.post("/control/system/restart", asyncRoute(async (_req, res) => {
  await auditService.log({
    stage: "System",
    action: "RUNNER_RESTART_REQUESTED",
    status: "OK",
    details: {
      requestedBy: "dashboard",
      pid: process.pid,
      restartLog: "/tmp/runner-restart.log"
    }
  });

  res.status(202).json({
    ok: true,
    message:
      "Runner restart scheduled - rebuilding @inbox-os/core + @inbox-os/runner and relaunching. " +
      "Tail /tmp/runner-restart.log if the dashboard times out waiting."
  });

  // Defer the exit so the response flushes + the audit row lands on
  // disk before we kill the process.
  setTimeout(() => {
    setImmediate(() => {
      try {
        const restartLogPath = "/tmp/runner-restart.log";
        // openSync with 'a' creates the file if absent, then appends.
        // Reuse a single fd for both stdout and stderr so interleaved
        // output is monotonic in the file.
        const fd = openSync(restartLogPath, "a");
        const script = [
          `echo "=== restart at $(date) (parent pid ${process.pid}) ==="`,
          // 1s grace so the parent's listen socket actually closes
          // before the new runner tries to bind 4001.
          `sleep 1`,
          // npm build commands need to run from projectRoot regardless
          // of where the parent was launched.
          `cd "${projectRoot}"`,
          `npm run build --workspace @inbox-os/core`,
          `npm run build --workspace @inbox-os/runner`,
          `echo "=== launching dist ==="`,
          `exec node apps/runner/dist/index.js`
        ].join(" && ");

        const child = spawn("/bin/sh", ["-c", script], {
          detached: true,
          stdio: ["ignore", fd, fd],
          cwd: projectRoot,
          env: process.env
        });
        child.unref();

        // eslint-disable-next-line no-console
        console.log(
          `[runner] Restart requested — spawned bootstrap helper pid=${child.pid}, log=${restartLogPath}; exiting pid=${process.pid}`
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `[runner] Failed to spawn restart bootstrap; exiting anyway. ${error instanceof Error ? error.message : String(error)}`
        );
      }
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

  if (runnerConfig.imessage.enabled) {
    const watcher = createIMessageWatcher({
      dbPath: runnerConfig.imessage.dbPath,
      debounceMs: runnerConfig.imessage.watchDebounceMs,
      onChange: (reason) => {
        const result = scanQueue.enqueueScan("IMESSAGE", { respectCooldown: true });
        void auditService.log({
          platform: "IMESSAGE",
          stage: "Scan",
          action: "IMESSAGE_WATCH_TRIGGER",
          status: result.ok ? "OK" : "FAIL",
          details: {
            reason,
            ...(result.ok
              ? { jobId: result.jobId, status: result.status }
              : { blocked: result.blocked, blockReason: result.reason })
          }
        });
      }
    });
    watcher.start();
  }

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
