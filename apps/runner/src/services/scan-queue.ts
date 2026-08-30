import type {
  CollectionBoundaryCompleteness,
  NormalizedMessage,
  PlatformAdapter,
  PlatformCollectionBoundaryCapability,
  PlatformName,
  RememberItem,
  ThreadStub
} from "@inbox-os/core";
import {
  calculateRisk,
  DELETED_INBOUND_PLACEHOLDER_STRINGS,
  isNonActionableInboundPlaceholder,
  stableHash
} from "@inbox-os/core";
import { v4 as uuid } from "uuid";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { prisma } from "../db";
import { effectiveLastOutboundAt } from "./reaction-effects.js";
import type { AiService, EventBus, ScanJobOutcome, SettingsStore } from "../types/runtime";
import { AdapterFailure, cleanMessageText, cleanText, humanDelay, stripUnpairedSurrogates } from "../platforms/utils";
import { shouldRefreshGroupDisplayName } from "../platforms/imessage-group-name";
import {
  linkedInCollectionCompleteness,
  type LinkedInCollectionStopReason,
  type LinkedInStreamPreOpenDecision
} from "../platforms/linkedin-adapter";
import { resolveAdapterFailureKind, shouldStopScanForFailureKind } from "./failure-routing";
import { isAiVisibleMessage, prismaMessageToPrompt } from "./ai";
import { buildMessageUpsertPayload } from "./message-upsert-payload";
import {
  PLATFORM_SCAN_IN_PROGRESS_ERROR,
  preparePlatformScanIdentityFreshness,
  resolveCollectionBoundaryFreshness,
  resolveMessageIdentityFreshness,
  resolvePlatformScanFreshness,
  reconcilePlatformMessageIdentity,
  type MessageIdentityReconciler
} from "./message-identity-reconciliation";
import { deleteImessageVoiceSnapshot } from "./imessage-voice-store";
import { isVoicePlaceholderText, previewFromTranscript } from "./transcript-preview";
import type { KeyedMutex } from "./keyed-mutex";
import {
  ScanRetryController,
  type ScanCooldownStatus
} from "./scan-retry-controller";
import { isLinkedInInFlight } from "./linkedin-inflight-guard";
import {
  adapterSupportsIncrementalScan,
  resolveIncrementalScanPlan,
  type IncrementalScanPlan
} from "./incremental-scan";
import { inferContactName, looksLikeUnresolvedHandle } from "./name-inference";
import {
  createRunLogger,
  type RunLogger,
  type RunTraceSummary
} from "./run-logger";
import {
  getDevLoggingFlags,
  getLinkedInDevScanCaps,
  isAutoScanDisabledInDev,
  isScanFallbackEnabled
} from "../dev-flags";
import {
  isTemporaryLinkedInId,
  normalizeCanonicalLinkedInThreadId
} from "../linkedin/linkedinIdentity.js";
import { parseLinkedInListTimestamp } from "../linkedin/linkedinTime.js";
import type { MessageSyncMetric } from "./message-sync-latency";

interface ScanQueueDeps {
  // Partial: not every PlatformName has an adapter on main today. The
  // scan loop only iterates `enabledPlatforms` (which excludes IMESSAGE
  // by default); per-thread sync paths guard via requireAdapter.
  adapters: Partial<Record<PlatformName, PlatformAdapter>>;
  messageIdentityReconcilers?: Partial<Record<PlatformName, MessageIdentityReconciler>>;
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
  /**
   * Optional hook fired when a brand-new Person row is inserted during a
   * scan. Used by the enrichment queue to schedule a profile-extraction
   * pass for first-time contacts. Fire-and-forget — must not block the
   * scan even if it throws.
   */
  onNewPerson?: (input: { personId: string; trigger: "first_seen" }) => void;
  /**
   * Optional hook fired after a message with a voice / audio attachment
   * is persisted during a scan. Used by the transcription service to
   * spend an OpenAI call on the audio so summaries, reply briefs,
   * predrafts, etc. can read voice content as ordinary text. Fire-and-
   * forget; the service dedupes against any prior transcription row.
   * Scans must not block on transcription.
   */
  onAudioMessage?: (input: { messageId: string }) => void;
  /**
   * Optional gate consulted by the scheduler tick and the ALL-scan platform
   * expansion. Return false to skip a platform this pass without recording a
   * failure. Used for WhatsApp: scanning an unlinked account would silently
   * launch a whatsapp-web.js Puppeteer instance and park it on a QR nobody
   * sees, so the runner only scans WHATSAPP while the connect-state machine
   * reports "connected". Explicit single-platform scan requests bypass this
   * (the /control/scan route already 409s an unlinked WhatsApp scan).
   */
  isPlatformScannable?: (platform: PlatformName) => boolean;
  recordLatency?: (input: {
    metric: MessageSyncMetric;
    durationMs: number;
    platform?: PlatformName;
  }) => void;
}

/**
 * - "update": the cheap default. Walks the inbox top-down and stops once
 *   we've seen `LINKEDIN_UNCHANGED_STREAK_LIMIT` (default 5) consecutive
 *   rows whose list-side signals haven't moved since our last scan. iMessage
 *   and the WAL watcher always use this — chat.db reads are essentially free.
 * - "full": disables the streak short-circuit. The adapter walks every row
 *   in the inbox up to `maxThreads`. Use for the first scan against a fresh
 *   account, or when the operator suspects state drift.
 */
export type ScanScope = "update" | "full";

type ScanJob = {
  jobId: string;
  platform?: PlatformName;
  maxThreads?: number;
  maxOpens?: number;
  forceFallback?: boolean;
  scope: ScanScope;
  /** Drives per-platform adaptive backoff bookkeeping in runJob (#403). */
  fromScheduler?: boolean;
  platformThreadId?: string;
  trigger?: ScanTrigger;
};

export function enqueueScanJobByPriority<T>(queue: T[], job: T, priority: boolean): void {
  if (priority) queue.unshift(job);
  else queue.push(job);
}

export function promoteQueuedJob<T>(queue: T[], index: number): void {
  if (index <= 0 || index >= queue.length) return;
  const [job] = queue.splice(index, 1);
  if (job !== undefined) queue.unshift(job);
}

export interface ScanTrigger {
  kind: "filesystem" | "platform_event" | "browser_change";
  sourceChangedAt: string;
  reason: string;
}

interface TraceAwareAdapter {
  setRunLogger?: (logger: RunLogger | null) => void;
}

interface LinkedInScanAdapter extends PlatformAdapter {
  scanInboxThreadsStream(options: {
    maxThreads?: number;
    maxOpens?: number;
    disableDeepScroll?: boolean;
    requestId: string;
    runLogger?: RunLogger;
    /**
     * Pre-open hook used for skip-if-unchanged + first-encounter full
     * backfill. See LinkedInStreamPreOpenSignals for the input shape.
     */
    shouldOpenCandidate?: (signals: {
      rowKey: string;
      displayName: string;
      unreadCount: number;
      needsReplyFromList: boolean;
      listTimestamp: string;
      listTimestampIso: string | null;
      threadUrl?: string;
      candidatePlatformThreadId?: string;
    }) => Promise<{ open: boolean; mode: "full" | "delta"; reason?: string }>;
    onThreadCandidate: (input: {
      rowKey: string;
      thread: ThreadStub;
      messages: NormalizedMessage[];
    }) => Promise<void>;
    onProgress?: (snapshot: { processedRows: number; openedRows: number; total: number }) => void;
  }): Promise<{
    stopReason: LinkedInCollectionStopReason;
    iterations: number;
    scrollIterations: number;
    processedRows: number;
    actionableRows: number;
    unreadRows: number;
    needsReplyRows: number;
    openedRows: number;
    skippedRows: number;
    skippedUnchangedRows: number;
    fullBackfillRows: number;
    failures: number;
    selectorThreadItemCount: number;
    selectorThreadSnippetCount: number;
    collectorMode: "primary_stream" | "fallback_direct" | "none";
    fallbackEligible: boolean;
    fallbackTriggered: boolean;
  }>;
  scanInboxThreadsDirectFallback(options: {
    requestId: string;
    runLogger?: RunLogger;
    maxThreads?: number;
    maxOpens?: number;
    disableDeepScroll?: boolean;
    onThreadCandidate?: (input: {
      rowKey: string;
      thread: ThreadStub;
      messages: NormalizedMessage[];
    }) => Promise<void>;
  }): Promise<{
    stopReason: LinkedInCollectionStopReason;
    threadsScanned: number;
    actionableRows: number;
    unreadRows: number;
    needsReplyRows: number;
    selectorThreadItemCount: number;
    selectorThreadSnippetCount: number;
    collectorMode: "fallback_direct";
    threads: ThreadStub[];
  }>;
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

const allPlatforms: PlatformName[] = [
  "LINKEDIN",
  "INSTAGRAM",
  "TIKTOK",
  "IMESSAGE",
  "WHATSAPP",
  "GOOGLE_MESSAGES"
];

export function resolveSelectedScanPlatforms(input: {
  requestedPlatform?: PlatformName;
  enabledPlatforms: readonly PlatformName[];
  adapters: Partial<Record<PlatformName, unknown>>;
  isPlatformScannable?: (platform: PlatformName) => boolean;
}): PlatformName[] {
  const enabled = new Set(input.enabledPlatforms);
  const candidates = input.requestedPlatform ? [input.requestedPlatform] : allPlatforms;
  return candidates.filter(
    (platform) =>
      enabled.has(platform) &&
      Boolean(input.adapters[platform]) &&
      (!input.isPlatformScannable || input.isPlatformScannable(platform))
  );
}

type EnqueueScanOptions = {
  respectCooldown?: boolean;
  requestId?: string;
  maxThreads?: number;
  maxOpens?: number;
  forceFallback?: boolean;
  coalesceWithPending?: boolean;
  platformThreadId?: string;
  trigger?: ScanTrigger;
  /** Default "update". See ScanScope for what each value means. */
  scope?: ScanScope;
  /**
   * Internal-only flag set by the cadence scheduler so the runner can
   * tell scheduled scans from manual API-triggered ones. Drives the
   * per-platform adaptive backoff (#403) — only scheduler-driven runs
   * count toward the backoff counter, manual scans always go through.
   */
  fromScheduler?: boolean;
};

type LinkedInFallbackDecision = {
  fallbackEligible: boolean;
  fallbackTriggered: boolean;
  triggerReason?: "force_fallback" | "zero_primary_rows_with_selector_signals";
};

type ExistingThreadOpenState = {
  id: string;
  lastMessageAt: Date | null;
  unreadCount: number;
  firstFullBackfillAt: Date | null;
} | null;

/**
 * Send-time persistence (`services/send.ts`) keys outbound messages by
 * `stableHash(threadId|sentAt|OUT|text)`. When the next scan parses the same
 * outbound from LinkedIn's list view, it gets either:
 *   - LinkedIn's real `data-event-urn` (different key entirely)
 *   - A stableHash with the list-view timestamp (rounded to the minute, so
 *     also different from the exact-second send timestamp)
 *
 * Both produce a different `platformMessageKey` from the send-time row, so
 * the upsert misses and inserts a duplicate. The user reported this for
 * Joshua Martin's thread: two identical 18:56 bubbles, one keyed by
 * stableHash with `17:56:07`, one keyed by stableHash with `17:56:00`.
 *
 * Pure decision function so the dedup rule is unit-testable without Prisma.
 * Callers execute the returned action via prisma.
 */
export interface ExistingOutboundMessageRow {
  id: string;
  platformMessageKey: string;
  text: string;
  timestamp: Date;
}

export type OutboundDedupAction =
  | { kind: "no_op" }
  | { kind: "migrate_twin_key"; twinId: string }
  | { kind: "delete_twin"; twinId: string };

/**
 * The two outbound persistence paths normalize whitespace differently, so the
 * same physical message lands with slightly different `text`:
 *   - send.ts stores the operator's text verbatim. A dictation/compose
 *     artifact commonly leaves a stray leading space on a wrapped line.
 *   - the scan parser runs the same message (re-read from the platform, e.g.
 *     iMessage chat.db) through cleanMessageText, which trims each line.
 *
 * One stray space then makes the two rows differ by a single character, an
 * exact-equality twin check misses, and the duplicate survives — the user saw
 * two identical bubbles on Lanre's iMessage thread, one tagged "sent via
 * automation" (raw, 1019 chars) and one not (cleaned, 1018 chars). Collapse
 * whitespace runs to a single space and trim so the comparison ignores these
 * cosmetic differences. Two genuinely distinct outbound messages that are
 * identical modulo whitespace inside the 5-minute window is not a real
 * workflow, so this does not introduce false positives.
 */
export function normalizeOutboundTextForDedup(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extract iMessage attachment guids from persisted `attachmentsJson` blobs.
 * Used to drop voice-note snapshots when their owning messages are removed
 * (retracted / failed delivery), so we never preserve audio for a message the
 * recipient never kept. Tolerant of malformed JSON — returns what it can.
 */
export function attachmentGuidsFromRows(rows: Array<{ attachmentsJson: string | null }>): string[] {
  const guids: string[] = [];
  for (const row of rows) {
    if (!row.attachmentsJson) continue;
    try {
      const parsed = JSON.parse(row.attachmentsJson) as Array<{ guid?: string | null }>;
      for (const att of parsed) {
        if (typeof att?.guid === "string" && att.guid.length > 0) guids.push(att.guid);
      }
    } catch {
      // skip malformed blob
    }
  }
  return guids;
}

export function decideOutboundDedup(input: {
  newKey: string;
  newTimestamp: Date;
  newText: string;
  existingTwins: ExistingOutboundMessageRow[];
  /**
   * The row (if any) already keyed by `newKey` in the same thread. When this
   * exists we know the new key isn't a fresh insert — there's already a row
   * holding it — so any twin we find is a true duplicate to remove rather
   * than rekey.
   */
  existingCanonical: ExistingOutboundMessageRow | null;
  /**
   * Tolerance around the parsed timestamp. Send.ts records the exact send
   * second; LinkedIn's list view rounds to the minute, and clocks can drift
   * across sends. 5 minutes is generous but keeps the false-positive rate
   * effectively zero — two distinct outbound messages with the same exact
   * text in the same thread within 5 minutes is not a real workflow.
   */
  windowMs?: number;
}): OutboundDedupAction {
  const windowMs = input.windowMs ?? 5 * 60 * 1000;
  const normalizedNewText = normalizeOutboundTextForDedup(input.newText);
  const twin = input.existingTwins.find((row) => {
    if (row.platformMessageKey === input.newKey) {
      return false;
    }
    if (normalizeOutboundTextForDedup(row.text) !== normalizedNewText) {
      return false;
    }
    const dtMs = Math.abs(row.timestamp.getTime() - input.newTimestamp.getTime());
    return dtMs <= windowMs;
  });
  if (!twin) {
    return { kind: "no_op" };
  }
  if (input.existingCanonical) {
    return { kind: "delete_twin", twinId: twin.id };
  }
  return { kind: "migrate_twin_key", twinId: twin.id };
}

/**
 * When cross-sibling outbound twins are collapsed onto a surviving row, decide
 * which metadata to carry forward. The sibling row was almost always the
 * send-side persistence, so it holds the sentVia=automation tag and the
 * replyToMessageId linkage that the chat.db scan row lacks. We copy those onto
 * the survivor — which is the canonical row when one already exists, otherwise
 * the same-thread twin that decideOutboundDedup migrates the key onto — but
 * only when the survivor doesn't already carry the value, so we never clobber
 * good data. Pure so the rule is unit-testable away from Prisma.
 */
export function decideOutboundMetadataMerge(input: {
  survivorSentVia: string | null;
  survivorReplyToMessageId: string | null;
  hasAutomationTwin: boolean;
  twinReplyToMessageId: string | null;
}): { sentVia?: string; replyToMessageId?: string } {
  const updates: { sentVia?: string; replyToMessageId?: string } = {};
  if (input.hasAutomationTwin && input.survivorSentVia !== "automation") {
    updates.sentVia = "automation";
  }
  if (input.twinReplyToMessageId && !input.survivorReplyToMessageId) {
    updates.replyToMessageId = input.twinReplyToMessageId;
  }
  return updates;
}

/**
 * Same-thread outbound dedup can also delete a twin: when a canonical row
 * already holds the scan key, decideOutboundDedup returns `delete_twin` and the
 * row we drop is usually the send-side persistence — the only one carrying
 * sentVia=automation + replyToMessageId (send.ts sets both; the scan upsert
 * sets neither). Mirror the cross-sibling merge and copy that metadata onto the
 * surviving canonical before deleting, so the dashboard bubble keeps its
 * automation badge and reply nesting. Thin pure wrapper over
 * decideOutboundMetadataMerge so the same-thread field mapping is unit-testable
 * away from Prisma.
 */
export function decideSameThreadTwinDeleteMerge(
  twin: { sentVia: string | null; replyToMessageId: string | null },
  survivor: { sentVia: string | null; replyToMessageId: string | null }
): { sentVia?: string; replyToMessageId?: string } {
  return decideOutboundMetadataMerge({
    survivorSentVia: survivor.sentVia ?? null,
    survivorReplyToMessageId: survivor.replyToMessageId ?? null,
    hasAutomationTwin: twin.sentVia === "automation",
    twinReplyToMessageId: twin.replyToMessageId ?? null
  });
}

export function applyHandledBoundary(input: {
  needsReply: boolean;
  handledAt: Date | null;
  lastInboundAt: Date | null;
}): { needsReply: boolean; clearHandledAt: boolean } {
  if (!input.handledAt) {
    return { needsReply: input.needsReply, clearHandledAt: false };
  }
  const receivedNewInbound = Boolean(
    input.lastInboundAt && input.lastInboundAt.getTime() > input.handledAt.getTime()
  );
  return {
    needsReply: receivedNewInbound ? input.needsReply : false,
    clearHandledAt: receivedNewInbound
  };
}

export function normalizePositiveScanCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

export function sliceByPositiveCap<T>(values: T[], max?: number): T[] {
  const cap = normalizePositiveScanCap(max);
  if (typeof cap !== "number") {
    return values;
  }
  return values.slice(0, cap);
}

// Per-platform scan watermark persistence (incremental scan gate). Stored in
// the generic Setting KV table so no schema change is needed; the value is
// the adapter-private opaque string from PlatformAdapter.getScanWatermark.
const SCAN_WATERMARK_SETTING_PREFIX = "scan_watermark:";

async function loadScanWatermark(platform: PlatformName): Promise<string | null> {
  const row = await prisma.setting.findUnique({
    where: { key: `${SCAN_WATERMARK_SETTING_PREFIX}${platform}` }
  });
  if (!row) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.valueJson) as unknown;
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function saveScanWatermark(platform: PlatformName, watermark: string): Promise<void> {
  const key = `${SCAN_WATERMARK_SETTING_PREFIX}${platform}`;
  const valueJson = JSON.stringify(watermark);
  await prisma.setting.upsert({
    where: { key },
    update: { valueJson },
    create: { key, valueJson }
  });
}

export function resolveEffectiveCount(rawCount: number, max?: number): number {
  const safeRawCount =
    Number.isFinite(rawCount) && rawCount > 0
      ? Math.floor(rawCount)
      : 0;
  const cap = normalizePositiveScanCap(max);
  if (typeof cap !== "number") {
    return safeRawCount;
  }
  return Math.min(safeRawCount, cap);
}

export function resolveObservedCollectionCount(
  observedCount: number,
  boundaryCount: unknown
): number {
  const safeObserved =
    Number.isFinite(observedCount) && observedCount > 0
      ? Math.floor(observedCount)
      : 0;
  const safeBoundary =
    typeof boundaryCount === "number" &&
    Number.isFinite(boundaryCount) &&
    boundaryCount > 0
      ? Math.floor(boundaryCount)
      : 0;
  return Math.max(safeObserved, safeBoundary);
}

export function resolveCollectionNativeStopReason(
  metrics: Record<string, unknown> | null | undefined
): string | undefined {
  return typeof metrics?.nativeStopReason === "string"
    ? metrics.nativeStopReason
    : undefined;
}

export function beginAdapterCollectionBoundary(
  adapter: PlatformAdapter
): PlatformCollectionBoundaryCapability {
  const capability = adapter.collectionBoundary ?? {
    beginCycle: () => undefined,
    getMetrics: () => ({
      totalFound: 0,
      unreadFound: 0,
      completeness: "incomplete" as const,
      nativeStopReason: "collection_boundary_not_declared"
    })
  };
  capability.beginCycle();
  return capability;
}

export function shouldUseForceFallback(value: unknown, nodeEnv = process.env.NODE_ENV): boolean {
  return value === true && nodeEnv !== "production";
}

/**
 * #403 adaptive backoff multiplier — 1x for the first 3 no-change
 * scans, then steps 2x → 3x → 4x. Cap at 4x so the longest stretch
 * is, e.g., 4×60s = 4 minutes (or 4×300s = 20 minutes) — generous
 * but never silently disables the platform.
 */
export function adaptiveBackoffMultiplier(consecutiveNoChange: number): number {
  if (consecutiveNoChange <= 2) return 1;
  if (consecutiveNoChange <= 4) return 2;
  if (consecutiveNoChange <= 6) return 3;
  return 4;
}

export interface AdaptiveBackoffState {
  lastScheduledScanAt: number;
  consecutiveNoChange: number;
}

/** Exported for testing. Pure function — see `recordPlatformScanOutcome`. */
export function applyAdaptiveBackoffOutcome(
  state: AdaptiveBackoffState | undefined,
  updatedThreads: number,
  options: { fromScheduler: boolean; now: number; success: boolean }
): AdaptiveBackoffState {
  const base = state ?? { lastScheduledScanAt: 0, consecutiveNoChange: 0 };
  // consecutiveNoChange drives the scheduled-scan backoff. Only a clean
  // SCHEDULED scan that genuinely found no changes should inflate it.
  // Manual scans, failed scans, and cooldown-blocked runs all reach this
  // path with updatedThreads === 0 but must NOT be treated as a quiet
  // inbox — otherwise a few manual refreshes or transient failures stretch
  // the automatic interval out to 4x. A scan (any source) that DID find
  // changes still resets the counter to 0.
  const consecutiveNoChange =
    updatedThreads > 0
      ? 0
      : options.fromScheduler && options.success
        ? base.consecutiveNoChange + 1
        : base.consecutiveNoChange;
  return {
    lastScheduledScanAt: options.fromScheduler ? options.now : base.lastScheduledScanAt,
    consecutiveNoChange
  };
}

export function evaluateLinkedInFallbackDecision(input: {
  fallbackEnabled: boolean;
  forceFallback: boolean;
  primaryThreadsScanned: number;
  selectorThreadItemCount: number;
  selectorThreadSnippetCount: number;
  maxThreads?: number;
}): LinkedInFallbackDecision {
  if (input.forceFallback) {
    return {
      fallbackEligible: true,
      fallbackTriggered: true,
      triggerReason: "force_fallback"
    };
  }

  const cappedToZero = typeof input.maxThreads === "number" && normalizePositiveScanCap(input.maxThreads) === undefined;
  const fallbackEligible =
    !cappedToZero &&
    input.primaryThreadsScanned === 0 &&
    input.selectorThreadItemCount > 0 &&
    input.selectorThreadSnippetCount > 0;

  return {
    fallbackEligible,
    fallbackTriggered: input.fallbackEnabled && fallbackEligible,
    triggerReason:
      input.fallbackEnabled && fallbackEligible
        ? "zero_primary_rows_with_selector_signals"
        : undefined
  };
}

/**
 * Per-job cancellation gate. Reads the queue's monotonically-increasing
 * `abortVersion` EAGERLY at construction and remembers it as the baseline.
 * `shouldAbort()` then returns true once a later `requestAbort()` has bumped
 * the version past that baseline.
 *
 * The eager read is the whole point: `runJob` must capture its baseline
 * BEFORE its startup awaits (`ensurePlatformRows()`, `getSettings()`), so a
 * Cancel/reset fired while the job is parked in those awaits — which has
 * already incremented `abortVersion` — is reflected in `shouldAbort()`.
 * Capturing late made `baseline === abortVersion`, permanently disabling the
 * abort for the whole run.
 */
export function createJobAbortGate(readAbortVersion: () => number): {
  shouldAbort: () => boolean;
} {
  const baseline = readAbortVersion();
  return {
    shouldAbort: (): boolean => readAbortVersion() !== baseline
  };
}

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

/**
 * Decide the status an accepted enqueue should report. The decision MUST be
 * made from the `processing` flag read BEFORE `triggerProcessNext()` runs:
 * `triggerProcessNext` calls `void processNext()`, which synchronously shifts
 * the job and sets `processing = true` before its first `await`. So by the
 * time `enqueueScan` returns, `processing` is already `true` even for the job
 * that just started — reading it there would always report "queued" and the
 * "running" branch would be dead. Pass `processingBeforeEnqueue = !processing`
 * captured up front instead.
 */
export function resolveEnqueueStatus(
  processingBeforeEnqueue: boolean
): "queued" | "running" {
  return processingBeforeEnqueue ? "queued" : "running";
}

export function jobCoversTriggeredScan(
  job: Pick<ScanJob, "platform" | "platformThreadId">,
  requestedPlatform: PlatformName | undefined,
  requestedThreadId: string | undefined
): boolean {
  if (requestedPlatform === undefined) {
    return job.platform === undefined && job.platformThreadId === undefined;
  }
  if (job.platform !== undefined && job.platform !== requestedPlatform) return false;
  if (job.platformThreadId === undefined) return true;
  return requestedThreadId !== undefined && job.platformThreadId === requestedThreadId;
}

function earlierTrigger(current: ScanTrigger | undefined, incoming: ScanTrigger | undefined): ScanTrigger | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return Date.parse(current.sourceChangedAt) <= Date.parse(incoming.sourceChangedAt)
    ? { ...current, reason: current.reason === incoming.reason ? current.reason : `${current.reason},${incoming.reason}` }
    : { ...incoming, reason: current.reason === incoming.reason ? incoming.reason : `${current.reason},${incoming.reason}` };
}

export function createScanQueue(deps: ScanQueueDeps) {
  const runnerRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const latestLinkedInScanPointerPath = resolve(runnerRootDir, "LATEST_LINKEDIN_SCAN.txt");
  const queue: ScanJob[] = [];
  let processing = false;
  let currentJob: ScanJob | null = null;
  let currentScanPlatform: PlatformName | null = null;
  let currentScanProgress:
    | {
        platform: PlatformName;
        scope: ScanScope;
        processedRows: number;
        openedRows: number;
        total: number;
        startedAt: number;
      }
    | null = null;
  let scheduler: NodeJS.Timeout | undefined;
  let abortVersion = 0;
  let abortReason: string | null = null;
  const activeRunLoggerByPlatform = new Map<PlatformName, RunLogger>();
  const latestRunSummaryByPlatform = new Map<PlatformName, RunTraceSummary>();
  // Issue #403. Per-platform adaptive backoff for the SCHEDULED scan
  // path: after N consecutive scans that found no changes, the
  // scheduler stretches that platform's effective interval out by
  // 2x → 3x → 4x of the configured base. Manual scans are unaffected
  // (the user explicitly asked for them). Any scan that finds
  // changes resets the counter to 0.
  //
  // This addresses the "scan LinkedIn less aggressively when nothing
  // is happening" half of R-0040 without going down a LinkedIn
  // WebSocket reverse-engineering rabbit hole (PM-approved scope).
  const adaptiveBackoffByPlatform = new Map<
    PlatformName,
    { lastScheduledScanAt: number; consecutiveNoChange: number }
  >();
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

  function isPlatformDueForScheduledScan(
    platform: PlatformName,
    baseIntervalMs: number,
    now: number
  ): boolean {
    const state = adaptiveBackoffByPlatform.get(platform);
    if (!state) return true;
    const adaptiveIntervalMs = baseIntervalMs * adaptiveBackoffMultiplier(state.consecutiveNoChange);
    return now - state.lastScheduledScanAt >= adaptiveIntervalMs;
  }

  function recordPlatformScanOutcome(
    platform: PlatformName,
    updatedThreads: number,
    options: { fromScheduler: boolean; success: boolean }
  ): void {
    const next = applyAdaptiveBackoffOutcome(
      adaptiveBackoffByPlatform.get(platform),
      updatedThreads,
      { fromScheduler: options.fromScheduler, now: Date.now(), success: options.success }
    );
    adaptiveBackoffByPlatform.set(platform, next);
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
    if (normalized.includes("list_hydration_timeout")) {
      return "thread_list_not_ready";
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
    markScanComplete?: boolean;
  }): Promise<void> {
    const resolvedLastError = input.status === "CONNECTED" ? null : input.lastError;

    await prisma.platform.upsert({
      where: { name: input.platform },
      update: {
        status: input.status,
        lastError: resolvedLastError,
        connectedAt: input.connected ? new Date() : undefined,
        lastScanAt: input.markScanComplete ? new Date() : undefined
      },
      create: {
        name: input.platform,
        status: input.status,
        lastError: resolvedLastError,
        connectedAt: input.connected ? new Date() : undefined,
        lastScanAt: input.markScanComplete ? new Date() : undefined
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
    options?: EnqueueScanOptions
  ): EnqueueScanResult {
    const requestId = options?.requestId ?? uuid();
    if (options?.coalesceWithPending) {
      const pendingIndex = queue.findIndex((entry) =>
        (!options.trigger || entry.platform === platform) &&
        jobCoversTriggeredScan(entry, platform, options.platformThreadId)
      );
      const pending = pendingIndex >= 0 ? queue[pendingIndex] : undefined;
      if (pending) {
        pending.trigger = earlierTrigger(pending.trigger, options.trigger);
        if (options.trigger) promoteQueuedJob(queue, pendingIndex);
        return {
          ok: true,
          jobId: pending.jobId,
          status: "queued",
          requestId: pending.jobId,
          platform: pending.platform
        };
      }
    }
    if (!options?.coalesceWithPending && isLinkedInInFlight({
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
      // Flush for the trace folder + decision log, but do NOT overwrite
      // latestRunSummaryByPlatform — a cooldown block must not hide the
      // genuine last-scan result that getLatestRunSummary surfaces.
      blockedLogger.flush({
        success: false,
        stopReason: "cooldown_active",
        counters: {
          retryAfterSeconds: cooldown.retryAfterSeconds
        }
      });
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
      platform,
      maxThreads: normalizePositiveScanCap(options?.maxThreads),
      maxOpens: normalizePositiveScanCap(options?.maxOpens),
      forceFallback: shouldUseForceFallback(options?.forceFallback),
      scope: options?.scope ?? "update",
      fromScheduler: options?.fromScheduler === true,
      platformThreadId: options?.platformThreadId,
      trigger: options?.trigger
    };

    // Capture whether a job is already in flight BEFORE triggerProcessNext():
    // processNext() synchronously sets `processing = true` for this very job
    // before its first await, so reading `processing` after the trigger would
    // always report "queued". See resolveEnqueueStatus.
    const processingBeforeEnqueue = processing;
    enqueueScanJobByPriority(queue, job, Boolean(job.trigger));
    triggerProcessNext();

    return {
      ok: true,
      jobId: job.jobId,
      status: resolveEnqueueStatus(processingBeforeEnqueue),
      requestId: job.jobId,
      platform
    };
  }

  function startScheduler(): void {
    if (isAutoScanDisabledInDev()) {
      if (scheduler) {
        clearTimeout(scheduler);
        scheduler = undefined;
      }
      return;
    }

    if (scheduler) {
      clearTimeout(scheduler);
    }

    const scheduleNext = (delayMs: number): void => {
      scheduler = setTimeout(() => void tick(), Math.max(1_000, Math.min(delayMs, 60_000)));
      scheduler.unref?.();
    };

    const tick = async (): Promise<void> => {
      try {
        const settings = await deps.settingsStore.getSettings();
        if (settings.demoMode) {
          scheduleNext(60_000);
          return;
        }

        const now = Date.now();
        const intervalMs = settings.scanIntervalSeconds * 1000;
        if (processing) {
          scheduleNext(1_000);
          return;
        }

        // Per-platform adaptive backoff: queue separate scan jobs only
        // for platforms whose adaptive interval has elapsed. Platforms
        // with active backoff (#403) are skipped this tick and picked
        // up on a later one. The queue serialises jobs so this never
        // produces parallel scans of different platforms.
        const enabledPlatforms = resolveSelectedScanPlatforms({
          enabledPlatforms: settings.enabledPlatforms,
          adapters: deps.adapters,
          isPlatformScannable: deps.isPlatformScannable
        });
        for (const platform of enabledPlatforms) {
          if (!isPlatformDueForScheduledScan(platform, intervalMs, now)) {
            continue;
          }
          // Skip platforms currently in retry cooldown. A cooldown block
          // never advances the scheduled clock, so without this guard the
          // 1s tick re-enqueues every second for the whole cooldown window,
          // spinning enqueueScan and churning trace folders.
          if (retryController.getCooldown(platform).blocked) {
            continue;
          }
          enqueueScan(platform, {
            respectCooldown: true,
            fromScheduler: true
          });
        }

        if (processing || queue.length > 0) {
          scheduleNext(1_000);
          return;
        }
        const nextDueMs = enabledPlatforms.reduce((soonest, platform) => {
          const state = adaptiveBackoffByPlatform.get(platform);
          if (!state) return Math.min(soonest, intervalMs);
          const dueAt =
            state.lastScheduledScanAt +
            intervalMs * adaptiveBackoffMultiplier(state.consecutiveNoChange);
          return Math.min(soonest, Math.max(1_000, dueAt - Date.now()));
        }, 60_000);
        scheduleNext(nextDueMs);
      } catch (error) {
        await deps.auditLog({
          stage: "Scan",
          action: "SCHEDULER_TICK_FAIL",
          status: "FAIL",
          details: {
            personKey,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          }
        });
        scheduleNext(5_000);
      }
    };

    scheduleNext(1_000);
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
    // Capture the abort baseline BEFORE the SCAN_STARTED emit and the startup
    // awaits below. requestAbort() does `abortVersion += 1`; if a Cancel/reset
    // fires while this job is parked in ensurePlatformRows()/getSettings(),
    // reading the baseline afterwards would capture the already-bumped value
    // and permanently disable shouldAbort() for the whole run.
    const abortGate = createJobAbortGate(() => abortVersion);
    deps.eventBus.emit({
      type: "SCAN_STARTED",
      jobId: job.jobId,
      platform: job.platform
    });

    await ensurePlatformRows();
    const settings = await deps.settingsStore.getSettings();
    const scanPlatforms = resolveSelectedScanPlatforms({
      requestedPlatform: job.platform,
      enabledPlatforms: settings.enabledPlatforms,
      adapters: deps.adapters,
      isPlatformScannable: deps.isPlatformScannable
    });

    let updatedThreads = 0;
    let aborted = false;

    const shouldAbort = abortGate.shouldAbort;
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
      const beforeLockSettings = await deps.settingsStore.getSettings();
      if (!beforeLockSettings.enabledPlatforms.includes(platform)) {
        continue;
      }
      await deps.platformMutex.runWithQueueOne(lockKey(platform), async () => {
        const authoritativeSettings = await deps.settingsStore.getSettings();
        if (!authoritativeSettings.enabledPlatforms.includes(platform)) {
          return;
        }
        const runLogger = createRunLogger({
          requestId: job.jobId,
          platform,
          runType: "scan",
          outDirBase: runTraceBaseDir,
          createLogDirWhenDisabled: platform === "LINKEDIN"
        });
        activeRunLoggerByPlatform.set(platform, runLogger);

        const linkedInDevCaps = platform === "LINKEDIN" ? getLinkedInDevScanCaps() : { disableDeepScroll: false };
        const requestedMaxThreads = normalizePositiveScanCap(job.maxThreads);
        const requestedMaxOpens = normalizePositiveScanCap(job.maxOpens);
        const effectiveMaxThreads = requestedMaxThreads ?? linkedInDevCaps.maxThreads;
        const effectiveMaxOpens = requestedMaxOpens ?? linkedInDevCaps.maxOpens;
        const fallbackEnabled = platform === "LINKEDIN" ? isScanFallbackEnabled() : false;
        const forceFallback = platform === "LINKEDIN" ? shouldUseForceFallback(job.forceFallback) : false;
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
        if (!adapter) {
          await deps.auditLog({
            platform,
            stage: "Scan",
            action: "SCAN_SKIPPED",
            status: "FAIL",
            details: {
              reason: "no_adapter_registered",
              message: `No adapter registered for platform ${platform}; skipping scan iteration.`
            }
          });
          return;
        }
        const linkedInAdapter = platform === "LINKEDIN" ? (adapter as LinkedInScanAdapter) : null;
        currentScanPlatform = platform;
        const traceAwareAdapter = toTraceAwareAdapter(adapter);
        traceAwareAdapter.setRunLogger?.(runLogger);

        let platformUpdatedThreads = 0;
        let threadFailures = 0;
        const threadFailureKinds: Record<string, number> = {};
        let authInterrupted = false;
        let openedThreadsCount = 0;
        let messagesParsedCount = 0;
        let messagesPersistedCount = 0;
        let messageIdentityQuarantines = 0;
        let untrackedIdentityQuarantineFloor = 0;
        let candidatesCount = 0;
        let threadsScannedCount = 0;
        let unreadCandidatesCount = 0;
        let needsReplyCandidatesCount = 0;
        let rawThreadCount = 0;
        let effectiveThreadCount = 0;
        let rawCandidateCount = 0;
        let effectiveOpenCount = 0;
        let selectorThreadItemCount = 0;
        let selectorThreadSnippetCount = 0;
        let collectorMode: "primary_stream" | "fallback_direct" | "none" = linkedInAdapter ? "primary_stream" : "none";
        let fallbackEligible = false;
        let fallbackTriggered = false;
        let fallbackTriggerReason: string | undefined;
        let runSuccess = false;
        let runStopReason: string | undefined;
        // Incremental scan gate state: the watermark captured BEFORE this
        // run's sync work (persisted only after a clean completion) and
        // whether the candidate loop processed everything it was given (a
        // cap break or thread failure leaves work behind, so advancing the
        // watermark would silently drop those threads' changes).
        let capturedScanWatermark: string | null = null;
        let candidateCapBroke = false;
        let collectionIncomplete = false;
        let collectionFailures = 0;
        let runError: unknown;
        let platformStateBeforeScan: {
          status: "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
          lastError: string | null;
        } | null = null;

        runLogger.logEvent({
          level: "info",
          component: "scan-queue",
          stage: "scan_start",
          action: "platform_scan_start",
          details: {
            requestId: job.jobId,
            platform,
            scope: job.platform ?? "ALL",
            scanScope: job.scope,
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
          caps: linkedInDevCaps,
          requestedMaxThreads: requestedMaxThreads ?? null,
          requestedMaxOpens: requestedMaxOpens ?? null,
          maxThreads: effectiveMaxThreads ?? null,
          maxOpens: effectiveMaxOpens ?? null,
          fallbackEnabled,
          forceFallback
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
            const cooldownMessage = `collect_threads · cooldown_active · request ${job.jobId}: Cooling down - next retry in ${cooldown.retryAfterSeconds}s`;
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
          platformStateBeforeScan = await prisma.platform.findUnique({
            where: { name: platform },
            select: { status: true, lastError: true }
          });
          const scanStartFreshness = await preparePlatformScanIdentityFreshness({
            reconciler: deps.messageIdentityReconcilers?.[platform],
            previousStatus: platformStateBeforeScan?.status,
            previousLastError: platformStateBeforeScan?.lastError
          });
          untrackedIdentityQuarantineFloor =
            scanStartFreshness.untrackedIdentityQuarantineFloor;
          await setPlatformStatus({
            platform,
            status: scanStartFreshness.status,
            lastError: scanStartFreshness.lastError ?? undefined,
            connected: true
          });
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
            requestedMaxThreads: requestedMaxThreads ?? null,
            requestedMaxOpens: requestedMaxOpens ?? null,
            maxThreads: effectiveMaxThreads ?? null,
            maxOpens: effectiveMaxOpens ?? null,
            fallbackEnabled,
            forceFallback
          });

          let candidatesBeforeCap = 0;
          let collectionMetrics: Record<string, unknown> | null = null;
          let collectionCompleteness: CollectionBoundaryCompleteness | undefined;
          let candidatesToSync: Array<{ thread: ThreadStub; messages?: NormalizedMessage[] }> = [];
          // Lifted to the outer scope so the per-candidate persistence loop
          // (further down) can read it. Populated by the streaming-scan
          // pre-open hook when it requests a first-encounter full backfill.
          const fullBackfillThreadIds = new Set<string>();

          if (linkedInAdapter) {
            const applyThreadCap = <T>(values: T[]): T[] => {
              rawThreadCount = values.length;
              effectiveThreadCount = resolveEffectiveCount(rawThreadCount, effectiveMaxThreads);
              runLogger.logDecision({
                stage: "collect_threads",
                decision: "Applied thread cap to collected candidates",
                details: {
                  collectorMode,
                  rawThreadCount,
                  maxThreads: effectiveMaxThreads ?? null,
                  effectiveThreadCount
                }
              });
              return sliceByPositiveCap(values, effectiveMaxThreads);
            };

            const runDirectFallbackCollection = async (
              triggerReason: "force_fallback" | "zero_primary_rows_with_selector_signals",
              primary?: {
                threadsScanned: number;
                unreadCount: number;
                needsReplyCount: number;
                candidatesCount: number;
              }
            ): Promise<boolean> => {
              if (await markAborted("before_scan_fallback_direct", platform)) {
                runStopReason = "aborted";
                return false;
              }

              const fallbackStreamedCandidates: Array<{
                rowKey: string;
                thread: ThreadStub;
                messages: NormalizedMessage[];
              }> = [];
              const fallbackResult = await linkedInAdapter.scanInboxThreadsDirectFallback({
                requestId: job.jobId,
                runLogger,
                maxThreads: effectiveMaxThreads,
                maxOpens: effectiveMaxOpens,
                disableDeepScroll: linkedInDevCaps.disableDeepScroll,
                onThreadCandidate: async (input) => {
                  fallbackStreamedCandidates.push({
                    rowKey: input.rowKey,
                    thread: input.thread,
                    messages: input.messages
                  });
                }
              });

              if (await markAborted("after_scan_fallback_direct", platform)) {
                runStopReason = "aborted";
                return false;
              }

              fallbackTriggered = true;
              collectionFailures = 0;
              fallbackTriggerReason = triggerReason;
              collectorMode = fallbackResult.collectorMode;
              selectorThreadItemCount = fallbackResult.selectorThreadItemCount;
              selectorThreadSnippetCount = fallbackResult.selectorThreadSnippetCount;
              threadsScannedCount = fallbackResult.threadsScanned;
              unreadCandidatesCount = fallbackResult.unreadRows;
              needsReplyCandidatesCount = fallbackResult.needsReplyRows;
              const fallbackCandidates =
                fallbackStreamedCandidates.length > 0
                  ? fallbackStreamedCandidates.map((candidate) => ({
                      thread: candidate.thread,
                      messages: candidate.messages
                    }))
                  : fallbackResult.threads.map((thread) => ({ thread }));
              const cappedFallbackThreads = applyThreadCap(fallbackCandidates);
              candidatesBeforeCap = rawThreadCount;
              candidatesToSync = cappedFallbackThreads;
              collectionMetrics = {
                totalFound: fallbackResult.threadsScanned,
                unreadFound: fallbackResult.unreadRows,
                needsReplyFound: fallbackResult.needsReplyRows,
                candidatesFound: fallbackResult.actionableRows,
                completeness: linkedInCollectionCompleteness(fallbackResult.stopReason),
                nativeStopReason: fallbackResult.stopReason,
                collectorMode,
                selectorThreadItemCount,
                selectorThreadSnippetCount,
                fallbackEligible,
                fallbackTriggered,
                fallbackTriggerReason
              };
              collectionCompleteness = linkedInCollectionCompleteness(fallbackResult.stopReason);
              runLogger.logDecision({
                stage: "collect_threads",
                decision: "Collected LinkedIn direct fallback candidates",
                details: {
                  triggerReason,
                  collectorMode,
                  threadsScanned: fallbackResult.threadsScanned,
                  unreadRows: fallbackResult.unreadRows,
                  needsReplyRows: fallbackResult.needsReplyRows,
                  selectorThreadItemCount,
                  selectorThreadSnippetCount,
                  candidatesBeforeCap: rawThreadCount,
                  candidatesAfterCap: candidatesToSync.length,
                  streamedCandidatesCount: fallbackStreamedCandidates.length,
                  stopReason: fallbackResult.stopReason
                }
              });
              await deps.auditLog({
                platform,
                stage: "Scan",
                action: "LINKEDIN_FALLBACK_TRIGGERED",
                status: "OK",
                details: {
                  jobId: job.jobId,
                  requestId: job.jobId,
                  fallbackEnabled,
                  fallbackTriggered: true,
                  triggerReason,
                  collectorMode,
                  primary: {
                    threadsScanned: primary?.threadsScanned ?? null,
                    unreadCount: primary?.unreadCount ?? null,
                    needsReplyCount: primary?.needsReplyCount ?? null,
                    candidatesCount: primary?.candidatesCount ?? null
                  },
                  secondary: {
                    threadsScanned: fallbackResult.threadsScanned,
                    unreadCount: fallbackResult.unreadRows,
                    needsReplyCount: fallbackResult.needsReplyRows,
                    candidatesCount: fallbackResult.actionableRows
                  },
                  caps: {
                    maxThreads: effectiveMaxThreads ?? null,
                    maxOpens: effectiveMaxOpens ?? null,
                    rawThreadCount,
                    effectiveThreadCount
                  }
                }
              });
              return true;
            };

            if (forceFallback) {
              fallbackEligible = true;
              runLogger.logDecision({
                stage: "collect_threads",
                level: "warn",
                decision: "Bypassing primary stream collector due to forceFallback override",
                details: {
                  fallbackEnabled,
                  forceFallback,
                  maxThreads: effectiveMaxThreads ?? null,
                  maxOpens: effectiveMaxOpens ?? null
                }
              });
              headline("COLLECT_UNREAD_WARN", "fallback collector forced", {
                fallbackEnabled,
                forceFallback,
                maxThreads: effectiveMaxThreads ?? null,
                maxOpens: effectiveMaxOpens ?? null
              });
              const fallbackRan = await runDirectFallbackCollection("force_fallback");
              if (!fallbackRan) {
                return;
              }
            } else {
              if (await markAborted("before_scan_stream", platform)) {
                runStopReason = "aborted";
                return;
              }

              const streamedCandidates: Array<{ rowKey: string; thread: ThreadStub; messages: NormalizedMessage[] }> = [];
              const existingThreadOpenStateById = new Map<string, Promise<ExistingThreadOpenState>>();
              const loadExistingThreadOpenState = (platformThreadId: string): Promise<ExistingThreadOpenState> => {
                const cached = existingThreadOpenStateById.get(platformThreadId);
                if (cached) {
                  return cached;
                }
                const lookup = prisma.thread.findUnique({
                  where: {
                    platform_platformThreadId: {
                      platform,
                      platformThreadId
                    }
                  },
                  select: {
                    id: true,
                    lastMessageAt: true,
                    unreadCount: true,
                    firstFullBackfillAt: true
                  }
                }).catch(() => null);
                existingThreadOpenStateById.set(platformThreadId, lookup);
                return lookup;
              };
              // LinkedIn dropped the thread id from conversation-list rows
              // (no href / data-urn — JS-driven navigation), so the id-keyed
              // lookup above can't run pre-open. Fall back to matching the
              // row to a DB thread by the participant display name. Only a
              // UNIQUE display-name match is usable: if 0 or >1 LinkedIn
              // threads share the name we can't safely attribute the row, so
              // we return null and the caller opens the row (safe — at worst
              // a redundant open). `take: 2` is enough to detect ambiguity.
              const existingThreadOpenStateByName = new Map<string, Promise<ExistingThreadOpenState>>();
              const loadExistingThreadByDisplayName = (
                displayName: string
              ): Promise<ExistingThreadOpenState> => {
                const key = displayName.trim();
                if (!key) {
                  return Promise.resolve(null);
                }
                const cached = existingThreadOpenStateByName.get(key);
                if (cached) {
                  return cached;
                }
                const lookup = prisma.thread
                  .findMany({
                    where: { platform, person: { displayName: key } },
                    select: {
                      id: true,
                      lastMessageAt: true,
                      unreadCount: true,
                      firstFullBackfillAt: true
                    },
                    take: 2
                  })
                  .then((rows) => (rows.length === 1 ? rows[0] ?? null : null))
                  .catch(() => null);
                existingThreadOpenStateByName.set(key, lookup);
                return lookup;
              };
              // LinkedIn lists threads most-recent-first. Once we've seen
              // N consecutive rows where the DB content is already up-to-
              // date, we've crossed into already-scanned territory and
              // can stop walking the inbox. Reset the streak whenever we
              // open a row (something fresh / first-encounter / new
              // thread). Threshold defaults to 5 — generous enough to
              // tolerate LinkedIn's occasional list-side reordering, but
              // tight enough to noticeably shorten "everything is up to
              // date" scans.
              // "full" scope disables the early-exit entirely — the operator
              // explicitly wants to walk every row. We still let the
              // per-thread skip-if-unchanged path skip opens, so unchanged
              // threads don't waste a click, but `stopScan` is never raised.
              const unchangedStreakLimit = job.scope === "full"
                ? Number.POSITIVE_INFINITY
                : (() => {
                    const raw = process.env.LINKEDIN_UNCHANGED_STREAK_LIMIT;
                    const parsed = raw ? Number(raw) : NaN;
                    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50) return parsed;
                    return 5;
                  })();
              let unchangedStreakCount = 0;
              // Baseline = the LinkedIn thread count we've ever persisted.
              // Drives the status bar so the operator sees "3/167" rather
              // than "3/3" (issue #170). The adapter's `total` is the live
              // row-set size, which is uninformative when most of the inbox
              // hasn't been scrolled into view yet. We bump the baseline on
              // overflow when the scan exposes new threads beyond what we
              // had stored.
              const baselineThreadTotal = await prisma.thread.count({
                where: { platform: "LINKEDIN" }
              });
              currentScanProgress = {
                platform: "LINKEDIN",
                // #338/#362: surface scope so the dashboard's TopStatus can
                // distinguish "checking for new" (update) from "rescanning
                // every thread" (full). Without this the bar reads
                // "Scanning LinkedIn · 5/167" for both, and an incremental
                // scan visually impersonates a full inbox sweep.
                scope: job.scope,
                processedRows: 0,
                openedRows: 0,
                total: baselineThreadTotal,
                startedAt: Date.now()
              };
              const streamMetrics = await linkedInAdapter.scanInboxThreadsStream({
                maxThreads: effectiveMaxThreads,
                maxOpens: effectiveMaxOpens,
                disableDeepScroll: linkedInDevCaps.disableDeepScroll,
                requestId: job.jobId,
                runLogger,
                onProgress: (snap) => {
                  if (currentScanProgress) {
                    currentScanProgress.processedRows = snap.processedRows;
                    currentScanProgress.openedRows = snap.openedRows;
                    // Hold the baseline as long as the scan stays within it.
                    // Once the adapter reports more rows than we had stored
                    // (a brand-new chat appeared, or the persisted count
                    // drifted), bump up so the bar never reads >100%.
                    currentScanProgress.total = Math.max(baselineThreadTotal, snap.processedRows);
                  }
                },
                shouldOpenCandidate: async (signals) => {
                  // Honour the cancel button. The LinkedIn stream scan
                  // can sit on a single thread for tens of seconds during
                  // deep DOM reads; without an in-loop abort check the
                  // operator's cancel doesn't take effect until the next
                  // markAborted() checkpoint in the outer loop, which
                  // arrives only between platform-level phases (issue
                  // #131). Returning `stopScan: true` here is the
                  // adapter's cooperative early-exit hook.
                  if (shouldAbort()) {
                    return { open: false, mode: "delta", reason: "aborted", stopScan: true };
                  }
                  // We can only consult the DB if the row anchor gave us a
                  // canonical thread ID. Without one, fall back to "open in
                  // delta mode" — the post-open canonicalisation step will
                  // still dedupe on platformThreadId.
                  // Evaluate a row against the DB thread we matched it to.
                  // Shared by the id path and the display-name fallback so
                  // the unchanged check (timestamp <= stored AND unread
                  // matches) and the streak/stop-scan accounting can never
                  // diverge between the two. `canonicalIdForBackfill` is the
                  // URL-derived id when we have one (id path) so the
                  // first-encounter branch can pre-record the backfill; the
                  // name path passes null (post-open canonicalisation still
                  // stamps firstFullBackfillAt).
                  const evaluateAgainstExisting = (
                    existing: ExistingThreadOpenState,
                    canonicalIdForBackfill: string | null,
                    matchedBy: "id" | "display_name"
                  ): LinkedInStreamPreOpenDecision => {
                    // First encounter / pending full backfill — open full so
                    // we walk the whole history. Breaks any unchanged streak.
                    if (!existing || !existing.firstFullBackfillAt) {
                      if (canonicalIdForBackfill) {
                        fullBackfillThreadIds.add(canonicalIdForBackfill);
                      }
                      unchangedStreakCount = 0;
                      return { open: true, mode: "full", reason: existing ? "first_full_backfill" : "new_thread" };
                    }

                    // Skip-if-unchanged: open ONLY when the row's list-side
                    // signals indicate something actually moved. Both clauses
                    // must hold:
                    //   • the row's last-message timestamp is no newer than
                    //     what we already have (so no new message arrived);
                    //   • the unread count matches DB state (so no
                    //     read/unread state flip we should record).
                    //
                    // Comparison precision depends on the row text. When
                    // LinkedIn shows a TIME ("8:01 AM" / "19:16"), it's
                    // today's message — minute precision, exact compare. When
                    // it shows a date ("May 2"), weekday ("Wed") or
                    // "Yesterday", we only have day precision; the parser
                    // fills in noon, which would otherwise be > the precise
                    // db.lastMessageAt of the same day's message and falsely
                    // mark the thread "newer". Use a calendar-day compare.
                    const rowAt = signals.listTimestampIso ? Date.parse(signals.listTimestampIso) : NaN;
                    const dbAt = existing.lastMessageAt ? existing.lastMessageAt.getTime() : 0;
                    const rowTextIsTime = /\d{1,2}:\d{2}/.test(signals.listTimestamp ?? "");
                    let timestampUnchanged = false;
                    if (!Number.isNaN(rowAt)) {
                      if (rowTextIsTime) {
                        timestampUnchanged = rowAt <= dbAt;
                      } else {
                        const startOfDay = (ms: number): number => {
                          const d = new Date(ms);
                          d.setHours(0, 0, 0, 0);
                          return d.getTime();
                        };
                        timestampUnchanged = startOfDay(rowAt) <= startOfDay(dbAt);
                      }
                    }
                    const unreadUnchanged = existing.unreadCount === signals.unreadCount;
                    runLogger.logDecision({
                      stage: "open_thread",
                      decision: "shouldOpenCandidate evaluated",
                      details: {
                        rowKey: signals.rowKey,
                        displayName: signals.displayName,
                        listTimestamp: signals.listTimestamp,
                        listTimestampIso: signals.listTimestampIso,
                        candidatePlatformThreadId: signals.candidatePlatformThreadId ?? null,
                        matchedBy,
                        dbLastMessageAt: existing.lastMessageAt?.toISOString() ?? null,
                        dbUnreadCount: existing.unreadCount,
                        rowUnreadCount: signals.unreadCount,
                        rowTextIsTime,
                        timestampUnchanged,
                        unreadUnchanged,
                        decision: timestampUnchanged && unreadUnchanged ? "skip" : "delta"
                      }
                    });
                    if (timestampUnchanged && unreadUnchanged) {
                      unchangedStreakCount += 1;
                      const stopScan = unchangedStreakCount >= unchangedStreakLimit;
                      if (stopScan) {
                        runLogger.logDecision({
                          stage: "open_thread",
                          decision:
                            "Pre-open streak hit unchangedStreakLimit - requesting cooperative scan exit",
                          details: {
                            unchangedStreakCount,
                            unchangedStreakLimit,
                            rowKey: signals.rowKey
                          }
                        });
                      }
                      return {
                        open: false,
                        mode: "delta",
                        reason: stopScan ? "unchanged_streak" : "unchanged",
                        stopScan
                      };
                    }
                    // Row had a real change (timestamp / unread count) — reset
                    // the streak so the next contiguous unchanged-rows window
                    // counts from this point.
                    unchangedStreakCount = 0;
                    return { open: true, mode: "delta" };
                  };

                  if (!signals.candidatePlatformThreadId) {
                    // LinkedIn no longer exposes a thread id on conversation
                    // list rows, so the id path can't run. Match the row to a
                    // DB thread by display name instead. Only a UNIQUE
                    // LinkedIn name match is usable (ambiguous -> open, safe).
                    // The unchanged check itself is unchanged, so a genuinely
                    // new message — which always bumps the row's list
                    // timestamp to the top — is still detected; the only
                    // relaxation vs the id path is the match key.
                    const byName = await loadExistingThreadByDisplayName(signals.displayName);
                    if (!byName) {
                      runLogger.logDecision({
                        stage: "open_thread",
                        decision: "shouldOpenCandidate: delta (no candidate id, name unmatched/ambiguous)",
                        details: {
                          rowKey: signals.rowKey,
                          displayName: signals.displayName,
                          listTimestamp: signals.listTimestamp,
                          threadUrl: signals.threadUrl
                        }
                      });
                      // Can't attribute the row — open it. Reset the streak
                      // (we don't know if it's unchanged).
                      unchangedStreakCount = 0;
                      return { open: true, mode: "delta" };
                    }
                    return evaluateAgainstExisting(byName, null, "display_name");
                  }

                  const existing = await loadExistingThreadOpenState(signals.candidatePlatformThreadId);
                  return evaluateAgainstExisting(
                    existing,
                    signals.candidatePlatformThreadId,
                    "id"
                  );
                },
                onThreadCandidate: async (input) => {
                  streamedCandidates.push({
                    rowKey: input.rowKey,
                    thread: input.thread,
                    messages: input.messages
                  });
                }
              });

              runLogger.logAction({
                stage: "collect_threads",
                action: "scan_inbox_stream",
                result: "ok",
                counts: {
                  processedRows: streamMetrics.processedRows,
                  actionableRows: streamMetrics.actionableRows,
                  unreadRows: streamMetrics.unreadRows,
                  needsReplyRows: streamMetrics.needsReplyRows,
                  openedRows: streamMetrics.openedRows,
                  streamFailures: streamMetrics.failures,
                  selectorThreadItemCount: streamMetrics.selectorThreadItemCount,
                  selectorThreadSnippetCount: streamMetrics.selectorThreadSnippetCount,
                  fallbackEligible: streamMetrics.fallbackEligible,
                  fallbackTriggered: streamMetrics.fallbackTriggered
                }
              });
              collectionFailures = streamMetrics.failures;

              if (await markAborted("after_scan_stream", platform)) {
                runStopReason = "aborted";
                return;
              }

              selectorThreadItemCount = streamMetrics.selectorThreadItemCount;
              selectorThreadSnippetCount = streamMetrics.selectorThreadSnippetCount;
              collectorMode = streamMetrics.collectorMode;
              threadsScannedCount = streamMetrics.processedRows;
              unreadCandidatesCount = streamMetrics.unreadRows;
              needsReplyCandidatesCount = streamMetrics.needsReplyRows;
              const cappedStreamedCandidates = applyThreadCap(streamedCandidates);
              candidatesBeforeCap = rawThreadCount;
              candidatesToSync = cappedStreamedCandidates.map((candidate) => ({
                thread: candidate.thread,
                messages: candidate.messages
              }));
              collectionMetrics = {
                totalFound: streamMetrics.processedRows,
                unreadFound: streamMetrics.unreadRows,
                needsReplyFound: streamMetrics.needsReplyRows,
                candidatesFound: streamMetrics.actionableRows,
                iterations: streamMetrics.iterations,
                completeness: linkedInCollectionCompleteness(streamMetrics.stopReason),
                nativeStopReason: streamMetrics.stopReason,
                collectorMode,
                selectorThreadItemCount,
                selectorThreadSnippetCount,
                fallbackEligible: streamMetrics.fallbackEligible,
                fallbackTriggered: streamMetrics.fallbackTriggered
              };
              collectionCompleteness = linkedInCollectionCompleteness(streamMetrics.stopReason);
              runLogger.logDecision({
                stage: "collect_threads",
                decision: "Collected LinkedIn stream candidates",
                details: {
                  processedRows: streamMetrics.processedRows,
                  actionableRows: streamMetrics.actionableRows,
                  unreadRows: streamMetrics.unreadRows,
                  needsReplyRows: streamMetrics.needsReplyRows,
                  openedRows: streamMetrics.openedRows,
                  streamFailures: streamMetrics.failures,
                  selectorThreadItemCount,
                  selectorThreadSnippetCount,
                  fallbackEligible: streamMetrics.fallbackEligible,
                  fallbackTriggered: streamMetrics.fallbackTriggered,
                  rawThreadCount,
                  maxThreads: effectiveMaxThreads ?? null,
                  effectiveThreadCount,
                  stopReason: streamMetrics.stopReason
                }
              });

              const fallbackDecision = evaluateLinkedInFallbackDecision({
                fallbackEnabled,
                forceFallback: false,
                primaryThreadsScanned: streamMetrics.processedRows,
                selectorThreadItemCount,
                selectorThreadSnippetCount,
                maxThreads: effectiveMaxThreads
              });
              fallbackEligible = fallbackDecision.fallbackEligible;

              if (fallbackDecision.fallbackTriggered && fallbackDecision.triggerReason) {
                runLogger.logDecision({
                  stage: "collect_threads",
                  level: "warn",
                  decision: "Triggering LinkedIn direct fallback collector",
                  details: {
                    fallbackEnabled,
                    fallbackTriggered: true,
                    triggerReason: fallbackDecision.triggerReason,
                    primary: {
                      threadsScanned: streamMetrics.processedRows,
                      unreadCount: streamMetrics.unreadRows,
                      needsReplyCount: streamMetrics.needsReplyRows,
                      candidatesCount: streamMetrics.actionableRows
                    },
                    caps: {
                      maxThreads: effectiveMaxThreads ?? null,
                      maxOpens: effectiveMaxOpens ?? null,
                      rawThreadCount,
                      effectiveThreadCount
                    },
                    selectorThreadItemCount,
                    selectorThreadSnippetCount
                  }
                });
                headline("COLLECT_UNREAD_WARN", "fallback collector triggered", {
                  fallbackEnabled,
                  fallbackTriggered: true,
                  triggerReason: fallbackDecision.triggerReason,
                  selectorThreadItemCount,
                  selectorThreadSnippetCount
                });

                const fallbackRan = await runDirectFallbackCollection(
                  fallbackDecision.triggerReason,
                  {
                    threadsScanned: streamMetrics.processedRows,
                    unreadCount: streamMetrics.unreadRows,
                    needsReplyCount: streamMetrics.needsReplyRows,
                    candidatesCount: streamMetrics.actionableRows
                  }
                );
                if (!fallbackRan) {
                  return;
                }
              }
            }
          } else {
            if (await markAborted("before_scan_unread", platform)) {
              runStopReason = "aborted";
              return;
            }

            // Incremental scan gate (perf rank 13): platforms with a cheap
            // upstream change signal (iMessage chat.db) skip candidate
            // discovery entirely when nothing changed, and sync exactly the
            // changed conversations otherwise. The full unread+recent sweep
            // below costs seconds of synchronous SQLite per tick on a real
            // Messages library and used to run on EVERY watcher tick.
            let incrementalPlan: IncrementalScanPlan | null = null;
            if (job.platformThreadId && adapter.fetchThreadById) {
              const targeted = await adapter.fetchThreadById(job.platformThreadId);
              candidatesToSync = targeted ? [{ thread: targeted }] : [];
              rawThreadCount = candidatesToSync.length;
              effectiveThreadCount = rawThreadCount;
              candidatesBeforeCap = rawThreadCount;
              threadsScannedCount = rawThreadCount;
              unreadCandidatesCount = targeted && (targeted.unreadCount ?? 0) > 0 ? 1 : 0;
              needsReplyCandidatesCount = targeted?.needsReplyFromList ? 1 : 0;
              runLogger.logDecision({
                stage: "collect_threads",
                decision: "Resolved event-targeted thread",
                details: {
                  platformThreadId: job.platformThreadId,
                  found: Boolean(targeted)
                }
              });
            } else if (adapterSupportsIncrementalScan(adapter)) {
              const storedWatermark = await loadScanWatermark(platform);
              incrementalPlan = await resolveIncrementalScanPlan(adapter, storedWatermark);
              capturedScanWatermark = incrementalPlan.watermark;
              runLogger.logDecision({
                stage: "collect_threads",
                decision: "Resolved incremental scan plan",
                details: {
                  mode: incrementalPlan.mode,
                  reason: incrementalPlan.mode === "full" ? incrementalPlan.reason : undefined,
                  changedThreads: incrementalPlan.mode === "delta" ? incrementalPlan.stubs.length : undefined,
                  hadStoredWatermark: Boolean(storedWatermark)
                }
              });
            }

            if (job.platformThreadId && adapter.fetchThreadById) {
              collectionCompleteness = "complete";
              headline("COLLECT_TARGETED_OK", "event-targeted candidate collection complete", {
                platformThreadId: job.platformThreadId,
                candidatesCount: candidatesToSync.length
              });
            } else if (incrementalPlan && incrementalPlan.mode === "skip") {
              collectionCompleteness = "complete";
              // Nothing changed upstream since the last completed scan -
              // finish the tick with zero candidates. Same flow/events as a
              // scan that found no work, so consumers see a normal scan.
              candidatesToSync = [];
              rawThreadCount = 0;
              effectiveThreadCount = 0;
              candidatesBeforeCap = 0;
              threadsScannedCount = 0;
              headline("COLLECT_SKIP_UNCHANGED", "upstream store unchanged since last scan - skipping candidate sweep", {
                watermark: incrementalPlan.watermark
              });
            } else if (incrementalPlan && incrementalPlan.mode === "delta") {
              collectionCompleteness = "complete";
              // Only these conversations changed - sync exactly them. The
              // usual thread cap still applies (deltas are typically 1-2).
              const changedStubs = incrementalPlan.stubs;
              rawThreadCount = changedStubs.length;
              effectiveThreadCount = resolveEffectiveCount(rawThreadCount, effectiveMaxThreads);
              const cappedChanged = sliceByPositiveCap(changedStubs, effectiveMaxThreads);
              if (cappedChanged.length < changedStubs.length) {
                // Some changed threads fell off the cap: they stay pending,
                // so the watermark must not advance past them.
                candidateCapBroke = true;
              }
              candidatesBeforeCap = changedStubs.length;
              threadsScannedCount = changedStubs.length;
              unreadCandidatesCount = changedStubs.filter((t) => (t.unreadCount ?? 0) > 0).length;
              needsReplyCandidatesCount = changedStubs.filter((t) => Boolean(t.needsReplyFromList)).length;
              candidatesToSync = cappedChanged.map((thread) => ({ thread }));
              headline("COLLECT_DELTA_OK", "incremental candidate collection complete", {
                changedThreads: changedStubs.length,
                cappedCandidatesCount: candidatesToSync.length
              });
            } else {
              const collectionBoundaryCapability = beginAdapterCollectionBoundary(adapter);
              const unread = await adapter.scanUnreadThreads();
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
              const recent = await adapter.fetchRecentThreads(settings.recentThreadSweepCount);
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
              const mergedCandidates = Array.from(merged.values());
              rawThreadCount = mergedCandidates.length;
              effectiveThreadCount = resolveEffectiveCount(rawThreadCount, effectiveMaxThreads);
              const cappedCandidates = sliceByPositiveCap(mergedCandidates, effectiveMaxThreads);
              candidatesBeforeCap = merged.size;
              threadsScannedCount = merged.size;
              needsReplyCandidatesCount = mergedCandidates.filter((thread) => Boolean(thread.needsReplyFromList)).length;
              candidatesToSync = cappedCandidates.map((thread) => ({ thread }));
              runLogger.logDecision({
                stage: "collect_threads",
                decision: "Merged unread and recent candidates",
                details: {
                  unreadCandidatesCount,
                  recentCandidatesCount: recent.length,
                  rawThreadCount,
                  maxThreads: effectiveMaxThreads ?? null,
                  effectiveThreadCount,
                  mergedCandidatesCount: candidatesBeforeCap,
                  cappedCandidatesCount: candidatesToSync.length
                }
              });

              collectionMetrics = collectionBoundaryCapability.getMetrics();
              collectionCompleteness = collectionMetrics.completeness as
                | CollectionBoundaryCompleteness
                | undefined;
            }
          }
          const collectionBoundary = resolveCollectionBoundaryFreshness(
            collectionCompleteness,
            collectionFailures
          );
          candidateCapBroke ||= collectionBoundary.candidateCapBroke;
          collectionIncomplete ||= collectionBoundary.collectionIncomplete;
          collectionFailures = collectionBoundary.collectionFailures;
          if (rawThreadCount > effectiveThreadCount) {
            candidateCapBroke = true;
          }
          candidatesCount = candidatesToSync.length;
          threadsScannedCount = resolveObservedCollectionCount(
            Math.max(threadsScannedCount, candidatesBeforeCap),
            collectionMetrics?.totalFound
          );
          unreadCandidatesCount = resolveObservedCollectionCount(
            unreadCandidatesCount,
            collectionMetrics?.unreadFound
          );
          needsReplyCandidatesCount = resolveObservedCollectionCount(
            needsReplyCandidatesCount,
            collectionMetrics?.needsReplyFound
          );

          deps.eventBus.emit({
            type: "SCAN_PROGRESS",
            jobId: job.jobId,
            platform,
            stage: `Syncing ${candidatesCount} thread(s)`
          });
          headline("COLLECT_UNREAD_OK", "candidate collection complete", {
            threadsScanned: threadsScannedCount,
            unreadCount: unreadCandidatesCount,
            needsReplyCount: needsReplyCandidatesCount,
            candidatesCount,
            collectorMode,
            fallbackEnabled,
            fallbackEligible,
            fallbackTriggered,
            fallbackTriggerReason,
            selectorThreadItemCount,
            selectorThreadSnippetCount,
            rawThreadCount,
            maxThreads: effectiveMaxThreads ?? null,
            effectiveThreadCount,
            rows: candidatesBeforeCap,
            candidates: candidatesCount,
            stopReason: resolveCollectionNativeStopReason(collectionMetrics)
          });

          rawCandidateCount = candidatesToSync.length;
          effectiveOpenCount = resolveEffectiveCount(rawCandidateCount, effectiveMaxOpens);
          runLogger.logDecision({
            stage: "collect_threads",
            decision: "Applied open cap to candidate queue",
            details: {
              rawCandidateCount,
              maxOpens: effectiveMaxOpens ?? null,
              effectiveOpenCount
            }
          });
          const maxOpenCount = effectiveOpenCount;

          for (const candidateToSync of candidatesToSync) {
            const thread = candidateToSync.thread;
            if (openedThreadsCount >= maxOpenCount) {
              // Remaining candidates stay unsynced this run - the scan
              // watermark must not advance past them (candidateCapBroke).
              candidateCapBroke = true;
              break;
            }
            if (await markAborted("before_thread_sync", platform, thread)) {
              runStopReason = "aborted";
              break;
            }

            openedThreadsCount += 1;
            headline("OPEN_THREAD_START", "opening candidate thread", {
              index: openedThreadsCount,
              total: Math.min(candidatesToSync.length, maxOpenCount),
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
              const markedFullBackfill = fullBackfillThreadIds.has(thread.platformThreadId);
              const preParsedMessageCount = candidateToSync.messages?.length ?? 0;
              const effectiveMaxMessages = markedFullBackfill
                ? Math.max(settings.maxMessagesPerThread, preParsedMessageCount, 1000)
                : settings.maxMessagesPerThread;
              const syncResult = await syncThread(
                platform,
                thread,
                effectiveMaxMessages,
                job.jobId,
                runLogger,
                candidateToSync.messages,
                markedFullBackfill,
                false,
                job.trigger,
                () => !shouldAbort()
              );
              updatedThreads += syncResult.updatedThreads;
              platformUpdatedThreads += syncResult.updatedThreads;
              messagesParsedCount += syncResult.parsedMessages;
              messagesPersistedCount += syncResult.persistedMessages;
              messageIdentityQuarantines += syncResult.quarantinedMessages;
              headline("OPEN_THREAD_OK", "thread opened and synced", {
                index: openedThreadsCount,
                total: Math.min(candidatesToSync.length, maxOpenCount),
                name: thread.displayName
              });
              headline("PARSE_MESSAGES_OK", "thread messages parsed", {
                name: thread.displayName,
                messagesParsed: syncResult.parsedMessages
              });
              headline(
                syncResult.quarantinedMessages > 0 ? "PERSIST_PARTIAL" : "PERSIST_OK",
                syncResult.quarantinedMessages > 0
                  ? "thread persisted with identity quarantine"
                  : "thread persisted",
                {
                  name: thread.displayName,
                  threadsUpserted: syncResult.updatedThreads,
                  messagesUpserted: syncResult.persistedMessages,
                  messagesQuarantined: syncResult.quarantinedMessages
                }
              );
              runLogger.logAction({
                stage: "read_thread",
                action: "thread_sync_complete",
                result: syncResult.quarantinedMessages > 0 ? "partial" : "ok",
                counts: {
                  openedThreadsCount,
                  messagesParsedCount,
                  messagesPersistedCount,
                  messageIdentityQuarantines,
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

          let durableIdentityQuarantines: number | undefined;
          const quarantineCounter =
            deps.messageIdentityReconcilers?.[platform]?.getOutstandingQuarantineCount;
          try {
            durableIdentityQuarantines = await quarantineCounter?.();
          } catch {
            durableIdentityQuarantines = quarantineCounter ? 1 : undefined;
          }
          const freshnessIdentityQuarantines = Math.max(
            durableIdentityQuarantines ?? messageIdentityQuarantines,
            untrackedIdentityQuarantineFloor
          );
          const freshness = resolvePlatformScanFreshness({
            quarantinedMessages: freshnessIdentityQuarantines,
            threadFailures: threadFailures + collectionFailures,
            candidateCapBroke,
            collectionIncomplete
          });
          const freshnessComplete = freshness.freshnessComplete;
          const publishedFreshness =
            job.platformThreadId && freshnessComplete
              ? platformStateBeforeScan?.status === "CONNECTED"
                ? {
                    status: "CONNECTED" as const,
                    lastError: null,
                    advanceLastScanAt: false
                  }
                : {
                    status: "DEGRADED" as const,
                    lastError:
                      platformStateBeforeScan?.lastError ?? PLATFORM_SCAN_IN_PROGRESS_ERROR,
                    advanceLastScanAt: false
                  }
              : freshness;
          await setPlatformStatus({
            platform,
            status: publishedFreshness.status,
            lastError: publishedFreshness.lastError ?? undefined,
            markScanComplete: publishedFreshness.advanceLastScanAt
          });

          runStopReason = freshnessComplete
            ? resolveCollectionNativeStopReason(collectionMetrics) ?? runStopReason
            : freshness.stopReason;
          runLogger.setStopReason(runStopReason ?? "scan_complete");
          headline(
            freshnessComplete ? "SCAN_END_OK" : "SCAN_END_PARTIAL",
            freshnessComplete ? "scan completed" : "scan completed with incomplete freshness",
            {
              stopReason: runStopReason ?? "scan_complete",
              updatedThreads: platformUpdatedThreads,
              messagesQuarantined: freshnessIdentityQuarantines,
              LOG_DIR: logDir
            }
          );
          if (logDir) {
            headline(freshnessComplete ? "SCAN_END_OK" : "SCAN_END_PARTIAL", `LOG_DIR: ${logDir}`);
          }

          await deps.auditLog({
            platform,
            stage: "Scan",
            action: "SCAN_END",
            status: freshnessComplete ? "OK" : "FAIL",
            details: {
              jobId: job.jobId,
              requestId: job.jobId,
              stage: "persist",
              platform,
              freshnessComplete,
              messagesParsed: messagesParsedCount,
              messagesPersisted: messagesPersistedCount,
              messagesQuarantined: freshnessIdentityQuarantines,
              updatedThreads: platformUpdatedThreads,
              processed: platformUpdatedThreads,
              skipped: Math.max(0, candidatesCount - platformUpdatedThreads),
              totalFound: threadsScannedCount,
              unreadFound: unreadCandidatesCount,
              needsReplyFound: needsReplyCandidatesCount,
              iterations:
                typeof collectionMetrics?.iterations === "number" ? (collectionMetrics.iterations as number) : undefined,
              stopReason: runStopReason,
              threadsScanned: threadsScannedCount,
              unreadCount: unreadCandidatesCount,
              needsReplyCount: needsReplyCandidatesCount,
              candidatesCount,
              candidates: candidatesCount,
              collectorMode,
              fallbackEnabled,
              fallbackEligible,
              fallbackTriggered,
              fallbackTriggerReason,
              selectorThreadItemCount,
              selectorThreadSnippetCount,
              maxThreads: effectiveMaxThreads ?? null,
              maxOpens: effectiveMaxOpens ?? null,
              rawThreadCount,
              effectiveThreadCount,
              rawCandidateCount,
              effectiveOpenCount,
              threadFailures,
              collectionFailures,
              threadFailureKinds,
              candidateCapBroke,
              collectionIncomplete
            }
          });
          if (freshnessComplete) {
            retryController.markSuccess(platform);
            runError = undefined;
          }
          runSuccess = freshnessComplete;

          // Advance the incremental-scan watermark ONLY now: clean
          // completion, every candidate processed, no per-thread failures.
          // The value is the one captured BEFORE this run's sync work, so
          // changes that landed mid-scan stay ahead of it and are picked up
          // next tick. A failed/capped/aborted run leaves the old watermark
          // in place and the next tick simply re-derives a (cheap) delta.
          if (
            capturedScanWatermark &&
            threadFailures === 0 &&
            !candidateCapBroke &&
            freshnessComplete
          ) {
            await saveScanWatermark(platform, capturedScanWatermark);
          }
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
          if (currentScanProgress?.platform === platform) {
            currentScanProgress = null;
          }
          if (currentScanPlatform === platform) {
            currentScanPlatform = null;
          }
          runLogger.mergeCounters({
            threadsScannedCount,
            candidatesToOpenCount: candidatesCount,
            openedThreadsCount,
            messagesParsedCount,
            messagesPersistedCount,
            messageIdentityQuarantines,
            threadFailures,
            threadFailureKinds,
            updatedThreads: platformUpdatedThreads,
            unreadCandidatesCount,
            needsReplyCandidatesCount,
            collectorMode,
            fallbackEnabled,
            fallbackEligible,
            fallbackTriggered,
            fallbackTriggerReason,
            selectorThreadItemCount,
            selectorThreadSnippetCount,
            maxThreads: effectiveMaxThreads ?? null,
            maxOpens: effectiveMaxOpens ?? null,
            rawThreadCount,
            effectiveThreadCount,
            rawCandidateCount,
            effectiveOpenCount
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
          // #403: feed per-platform outcomes into the adaptive-backoff
          // bookkeeping. `fromScheduler:false` callers don't bump
          // lastScheduledScanAt — manual scans don't reset the clock,
          // but they DO reset consecutiveNoChange if they found changes.
          recordPlatformScanOutcome(platform, platformUpdatedThreads, {
            fromScheduler: job.fromScheduler === true,
            success: runSuccess
          });
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
    preParsedMessages?: NormalizedMessage[],
    markedFullBackfill = false,
    // Bulk historical backfill passes true: persist messages/people/threads
    // only, skip the per-thread AI summary + category classification.
    // Enrichment is gated by design and the recurring scanner already does
    // AI for ACTIVE threads — running it synchronously across hundreds of
    // dormant backfill threads just rate-limits the AI provider and is not
    // what the backfill is for.
    skipAi = false,
    trigger?: ScanTrigger,
    shouldContinue?: () => boolean
  ): Promise<{
    updatedThreads: number;
    parsedMessages: number;
    persistedMessages: number;
    quarantinedMessages: number;
  }> {
    const candidateListTimestamp = parseCandidateListTimestamp(candidate.lastMessageAt);
    const adapter = deps.adapters[platform];
    if (!adapter) {
      // The route entry-points (rescan / send / retry-send / open) guard
      // via index.ts:requireAdapter, so callers should never reach here
      // for an unsupported platform. Defensive throw with a clear message
      // matches the requireAdapter shape so any future code path that
      // skips the route guard still fails readably.
      throw new Error(
        `Platform ${platform} is not supported by this runner. Supported platforms: ${Object.keys(deps.adapters).join(", ")}.`
      );
    }

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
    if (shouldContinue && !shouldContinue()) {
      return { updatedThreads: 0, parsedMessages: 0, persistedMessages: 0, quarantinedMessages: 0 };
    }
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
        parsedMessages: 0,
        persistedMessages: 0,
        quarantinedMessages: 0
      };
    }

    if (canonicalPlatformThreadId) {
      candidate.platformThreadId = canonicalPlatformThreadId;
    }

    const candidateAvatarUrl = candidate.avatarUrl?.trim() || null;
    const candidateProfileUrl = candidate.profileUrl?.trim() || null;
    if (shouldContinue && !shouldContinue()) {
      return { updatedThreads: 0, parsedMessages: 0, persistedMessages: 0, quarantinedMessages: 0 };
    }
    // Person identity priority: profileUrl > displayName. profileUrl is a
    // stable per-person identifier on LinkedIn; displayName-only lookups
    // can false-positive across two LinkedIn contacts who share a name,
    // OR produce mis-attributed threads when an upstream row-parsing bug
    // pairs one row's displayName with another row's URL. One such
    // thread was observed on 2026-05-06 (Kolawole Afonja's content
    // linked to Jessica Essien's personId because the displayName-only
    // lookup hit Jessica's existing row); see migration-log.md and the
    // Phase 4 parser-investigation candidate.
    let existingPerson = candidateProfileUrl
      ? await prisma.person.findFirst({
          where: { profileUrl: candidateProfileUrl, platform }
        })
      : null;
    if (!existingPerson) {
      existingPerson = await prisma.person.findFirst({
        where: { displayName: candidate.displayName, platform }
      });
      // Defensive: if the displayName-matched existing person already
      // has a profileUrl that differs from this candidate's, that's
      // the row-alignment signal — treat as a new person rather than
      // mis-link the thread to the existing personId.
      if (
        existingPerson &&
        existingPerson.profileUrl &&
        candidateProfileUrl &&
        existingPerson.profileUrl !== candidateProfileUrl
      ) {
        console.warn(
          `[scan-queue] displayName=${JSON.stringify(candidate.displayName)} ` +
            `matches existing person ${existingPerson.id} but profileUrl differs ` +
            `(existing=${existingPerson.profileUrl} candidate=${candidateProfileUrl}). ` +
            "Treating as a new person to avoid mis-linking thread to wrong personId."
        );
        existingPerson = null;
      }
    }
    const person =
      existingPerson ??
      (await prisma.person.create({
        data: {
          displayName: candidate.displayName,
          displayNameSource: "auto",
          platform,
          avatarUrl: candidateAvatarUrl,
          profileUrl: candidateProfileUrl,
          profileUrlSource: candidateProfileUrl ? "auto" : null
        }
      }));
    if (existingPerson && candidateAvatarUrl && existingPerson.avatarUrl !== candidateAvatarUrl) {
      await prisma.person.update({
        where: { id: existingPerson.id },
        data: { avatarUrl: candidateAvatarUrl }
      });
    }
    // Auto-discovery never clobbers a manually-pasted URL. Only update
    // when there's no URL yet, or when the existing URL was also an auto
    // discovery (slug may have changed if the user renamed their handle).
    if (
      existingPerson &&
      candidateProfileUrl &&
      existingPerson.profileUrlSource !== "manual" &&
      existingPerson.profileUrl !== candidateProfileUrl
    ) {
      await prisma.person.update({
        where: { id: existingPerson.id },
        data: { profileUrl: candidateProfileUrl, profileUrlSource: "auto" }
      });
      // First time we've ever seen a URL for this contact — kick the
      // enrichment queue so the dashboard fills in immediately rather
      // than waiting for the next periodic tick.
      if (!existingPerson.profileUrl && deps.onNewPerson) {
        try {
          deps.onNewPerson({ personId: existingPerson.id, trigger: "first_seen" });
        } catch (error) {
          console.warn(
            `[scan-queue] onNewPerson hook (auto-url) threw for personId=${existingPerson.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
    if (!existingPerson && deps.onNewPerson) {
      // Fire-and-forget. The callback enqueues a profile-enrichment job;
      // it must never throw a scan-killing error even if the queue is
      // mid-restart. The callback signature is sync void on purpose.
      try {
        deps.onNewPerson({ personId: person.id, trigger: "first_seen" });
      } catch (error) {
        console.warn(
          `[scan-queue] onNewPerson hook threw for personId=${person.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const existing = await prisma.thread.findUnique({
      where: {
        platform_platformThreadId: {
          platform,
          platformThreadId: candidate.platformThreadId
        }
      }
    });

    // Group rename refresh. v1 models a group as a Thread pointing at a
    // synthetic Person whose displayName IS the group name, so the whole
    // dashboard reads the group name off person.displayName. When a group
    // is renamed the platform-authoritative name (candidate.groupName)
    // changes, but the person-identity lookup above keys on displayName and
    // therefore misses the existing synthetic row — leaving the established
    // thread link pointing at the stale name. Re-stamp the existing thread's
    // linked person directly, under the same no-clobber rule as profileUrl:
    // an operator rename ("manual") is never overwritten.
    if (existing && candidate.isGroup && candidate.groupName) {
      const linkedPerson = await prisma.person.findUnique({
        where: { id: existing.personId }
      });
      if (
        linkedPerson &&
        shouldRefreshGroupDisplayName({
          isGroup: candidate.isGroup,
          groupName: candidate.groupName,
          currentDisplayName: linkedPerson.displayName,
          currentSource: linkedPerson.displayNameSource
        })
      ) {
        await prisma.person.update({
          where: { id: existing.personId },
          data: { displayName: candidate.groupName, displayNameSource: "auto" }
        });
      }
    }

    const thread =
      existing ??
      (await prisma.thread.create({
        data: {
          platform,
          platformThreadId: candidate.platformThreadId,
          personId: person.id,
          threadUrl: candidate.threadUrl,
          recipientVerificationLabel: candidate.recipientVerificationLabel,
          unreadCount: candidate.unreadCount ?? 0,
          lastMessagePreview: cleanText(candidate.lastMessagePreview ?? ""),
          lastMessageAt: candidateListTimestamp ?? undefined,
          needsReply: Boolean(candidate.needsReplyFromList),
          isGroup: Boolean(candidate.isGroup),
          groupName: candidate.groupName ?? null
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

    const identityReconciliation = await reconcilePlatformMessageIdentity({
      reconcilers: deps.messageIdentityReconcilers ?? {},
      platform,
      threadId: thread.id,
      currentMessages: messages
    });
    const blockedMessageKeys = new Set(identityReconciliation.blockedMessageKeys);
    const quarantinedMessageKeys = new Set(identityReconciliation.quarantinedMessageKeys);
    const persistedMessages = messages.filter(
      (message) =>
        !message.platformMessageKey || !blockedMessageKeys.has(message.platformMessageKey)
    ).length;

    const timestampFallback = candidateListTimestamp ?? new Date();
    const batchedMessageWrites: Array<ReturnType<typeof prisma.message.upsert>> = [];
    const flushBatchedMessageWrites = async (): Promise<void> => {
      if (!batchedMessageWrites.length) {
        return;
      }
      const batch = batchedMessageWrites.splice(0, batchedMessageWrites.length);
      await prisma.$transaction(batch);
    };
    // Platform message keys for inbound messages carrying voice / audio
    // attachments. After persistence we resolve these to Message ids and
    // hand them to the transcription service (fire-and-forget); the
    // service's fingerprint dedup keeps re-scans free.
    const audioBearingMessageKeys: string[] = [];

    for (const message of messages) {
      if (
        message.platformMessageKey &&
        blockedMessageKeys.has(message.platformMessageKey)
      ) {
        continue;
      }
      const safeTimestamp = normalizeMessageTimestamp(message.timestamp, timestampFallback);
      const messageText = cleanMessageText(message.text);
      const key =
        message.platformMessageKey ??
        stableHash(`${thread.id}|${safeTimestamp.toISOString()}|${message.direction}|${messageText}`);

      // Reconcile send-time persistence vs scan-time parse for OUT messages.
      // See decideOutboundDedup for why this is needed (different keys for the
      // same physical message). Inbound messages don't have this problem —
      // they're only ever recorded by the scan parser.
      //
      // We fetch every OUT row in the ±5min window (NOT filtering on exact
      // `text` in SQL) because the send-time row stores raw text while this
      // scan row stores cleanMessageText output — a one-space difference would
      // make an exact SQL match miss the twin entirely. decideOutboundDedup
      // then compares with whitespace normalized so the divergent twin is
      // still recognised. The window keeps the candidate set tiny.
      if (message.direction === "OUT") {
        await flushBatchedMessageWrites();
        const windowMs = 5 * 60 * 1000;

        // For iMessage, the same physical message can be persisted into a
        // different Prisma thread than the one chat.db ends up storing the
        // row in: contacts who have both a phone and an iMessage email get
        // a separate Prisma thread per handle, and send.ts writes to whichever
        // thread was active in the dashboard while pickBestSendHandle routes
        // the actual send through the email-handle chat. The dashboard then
        // merges siblings on render and the same bubble shows twice. To
        // dedup, the twin lookup expands to every sibling thread of the
        // same person.
        let twinThreadIds: string[] = [thread.id];
        if (thread.platform === "IMESSAGE" && thread.personId) {
          const siblings = await prisma.thread.findMany({
            where: { platform: "IMESSAGE", personId: thread.personId },
            select: { id: true }
          });
          if (siblings.length > 1) {
            twinThreadIds = siblings.map((s) => s.id);
          }
        }

        const [twins, canonical] = await Promise.all([
          prisma.message.findMany({
            where: {
              threadId: { in: twinThreadIds },
              direction: "OUT",
              timestamp: {
                gte: new Date(safeTimestamp.getTime() - windowMs),
                lte: new Date(safeTimestamp.getTime() + windowMs)
              },
              // Exclude the row we're about to upsert as canonical so it
              // doesn't show up in its own twin list.
              NOT: { AND: [{ threadId: thread.id }, { platformMessageKey: key }] }
            },
            select: {
              id: true,
              threadId: true,
              platformMessageKey: true,
              text: true,
              timestamp: true,
              sentVia: true,
              replyToMessageId: true
            }
          }),
          prisma.message.findUnique({
            where: { threadId_platformMessageKey: { threadId: thread.id, platformMessageKey: key } },
            select: {
              id: true,
              platformMessageKey: true,
              text: true,
              timestamp: true,
              sentVia: true,
              replyToMessageId: true
            }
          })
        ]);

        // The twin query no longer filters on exact `text` in SQL (so it can
        // catch a send-side row whose whitespace diverges from this scan row —
        // see normalizeOutboundTextForDedup). That makes gating on content our
        // job here: keep only rows whose normalized text matches before the
        // cross-sibling block acts, otherwise unrelated sibling-thread messages
        // that merely fall inside the 5-minute window would be wrongly
        // collapsed. decideOutboundDedup re-checks the same way for the
        // same-thread set.
        const normalizedMessageText = normalizeOutboundTextForDedup(messageText);
        const contentTwins = twins.filter(
          (t) => normalizeOutboundTextForDedup(t.text) === normalizedMessageText
        );
        const sameThreadTwins = contentTwins.filter((t) => t.threadId === thread.id);
        const crossSiblingTwins = contentTwins.filter((t) => t.threadId !== thread.id);

        // Cross-sibling dedup — chat.db says this message belongs to the
        // current thread, so any same-content row in a sibling thread is
        // a stale send-side persistence that should be collapsed. Carry
        // forward sentVia=automation and replyToMessageId since the
        // sibling row was almost always the send-side one.
        if (crossSiblingTwins.length > 0) {
          const automationTwin = crossSiblingTwins.find((t) => t.sentVia === "automation");
          const replyToTwin = crossSiblingTwins.find((t) => t.replyToMessageId);

          if (!canonical && sameThreadTwins.length === 0) {
            // No row yet in current thread — migrate one cross-sibling twin
            // into place (preserves its metadata in one write) and delete
            // the rest. The upcoming upsert will then UPDATE (not INSERT).
            const seed = automationTwin ?? crossSiblingTwins[0]!;
            await prisma.message.update({
              where: { id: seed.id },
              data: { threadId: thread.id, platformMessageKey: key, timestamp: safeTimestamp }
            });
            for (const twin of crossSiblingTwins) {
              if (twin.id !== seed.id) {
                await prisma.message.delete({ where: { id: twin.id } });
              }
            }
          } else {
            // Canonical (or a same-thread twin) already in current thread —
            // delete all cross-sibling twins, copying useful metadata onto the
            // surviving row first if it doesn't have it yet. The survivor is the
            // canonical when present, otherwise the same-thread twin that
            // decideOutboundDedup migrates the new key onto below — either way it
            // must inherit the deleted sibling's sentVia=automation tag and
            // replyToMessageId linkage.
            for (const twin of crossSiblingTwins) {
              await prisma.message.delete({ where: { id: twin.id } });
            }
            const survivor = canonical ?? sameThreadTwins[0]!;
            const updates = decideOutboundMetadataMerge({
              survivorSentVia: survivor.sentVia ?? null,
              survivorReplyToMessageId: survivor.replyToMessageId ?? null,
              hasAutomationTwin: Boolean(automationTwin),
              twinReplyToMessageId: replyToTwin?.replyToMessageId ?? null
            });
            if (Object.keys(updates).length > 0) {
              await prisma.message.update({ where: { id: survivor.id }, data: updates });
            }
          }
        }

        const decision = decideOutboundDedup({
          newKey: key,
          newTimestamp: safeTimestamp,
          newText: messageText,
          existingTwins: sameThreadTwins,
          existingCanonical: canonical
        });
        if (decision.kind === "delete_twin") {
          // The twin we drop is usually the send-side row — the only one
          // carrying sentVia=automation + replyToMessageId (send.ts sets both;
          // the scan upsert sets neither). decideOutboundDedup only returns
          // delete_twin when a canonical already holds the scan key, so the
          // survivor is that canonical. Merge the twin's metadata onto it
          // before deleting, mirroring the cross-sibling branch above, so the
          // bubble keeps its automation badge and reply nesting.
          const deletedTwin = sameThreadTwins.find((t) => t.id === decision.twinId);
          if (canonical && deletedTwin) {
            const updates = decideSameThreadTwinDeleteMerge(deletedTwin, canonical);
            if (Object.keys(updates).length > 0) {
              await prisma.message.update({ where: { id: canonical.id }, data: updates });
            }
          }
          await prisma.message.delete({ where: { id: decision.twinId } });
        } else if (decision.kind === "migrate_twin_key") {
          await prisma.message.update({
            where: { id: decision.twinId },
            data: { platformMessageKey: key, timestamp: safeTimestamp }
          });
        }
      }

      const upsertPayload = buildMessageUpsertPayload({
        threadId: thread.id,
        platformMessageKey: key,
        direction: message.direction,
        adapterReportedTimestamp: Boolean(message.timestamp),
        safeTimestamp,
        text: messageText,
        senderName: message.senderName ?? null,
        attachmentsJson: message.attachments.length ? JSON.stringify(message.attachments) : null,
        rawJson: message.raw ? JSON.stringify(message.raw) : null
      });
      const write = prisma.message.upsert(upsertPayload);
      if (message.direction === "OUT") {
        await write;
      } else {
        batchedMessageWrites.push(write);
        if (batchedMessageWrites.length >= 25) {
          await flushBatchedMessageWrites();
        }
      }
      if (
        message.attachments.some(
          (a) => a.kind === "voice_note" || a.kind === "audio" || a.kind === "video"
        )
      ) {
        // Both directions, audio + video. The operator's own voice notes
        // and screen / phone-camera videos carry context the AI otherwise
        // can't see (intent, tone, what they actually said), so
        // transcribing them too means a future "what did I tell them
        // about X" question can reach into the audio track of either.
        audioBearingMessageKeys.push(key);
      }
    }
    await flushBatchedMessageWrites();

    // Sweep retroactively-failed outbound sends. Messages.app accepts a
    // send (our 5s post-send poll passes), then later flips the bubble
    // to "Not Delivered" via chat.db.error — most common with
    // SMS-fallback on a recipient whose iMessage activation lags. Hard-
    // delete the Message rows so the thread reflects what the recipient
    // saw (i.e. nothing). Best-effort: a chat.db read error here must
    // not abort the rest of the scan.
    if (adapter.collectRetractedOutboundKeys) {
      try {
        const retractedKeys = await adapter.collectRetractedOutboundKeys(candidate);
        if (retractedKeys.length > 0) {
          // Honour the removal for any voice notes too: a retracted/failed
          // outbound message the recipient never kept must not leave a
          // preserved audio snapshot behind. Collect the attachment guids
          // before the rows are deleted, then drop their snapshots after.
          const removedRows = await prisma.message.findMany({
            where: {
              threadId: thread.id,
              direction: "OUT",
              platformMessageKey: { in: retractedKeys }
            },
            select: { attachmentsJson: true }
          });
          const removed = await prisma.message.deleteMany({
            where: {
              threadId: thread.id,
              direction: "OUT",
              platformMessageKey: { in: retractedKeys }
            }
          });
          for (const guid of attachmentGuidsFromRows(removedRows)) {
            deleteImessageVoiceSnapshot(guid);
          }
          if (removed.count > 0) {
            console.log(
              `[scan] removed ${removed.count} failed outbound message(s) from thread ${thread.id}`
            );
          }
        }
      } catch (error) {
        console.warn(
          `[scan] retracted-key sweep failed for thread ${thread.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (adapter.collectDeferredOutboundKeys) {
      try {
        const deferredKeys = await adapter.collectDeferredOutboundKeys(candidate);
        if (deferredKeys.length > 0) {
          const removed = await prisma.message.deleteMany({
            where: {
              threadId: thread.id,
              direction: "OUT",
              platformMessageKey: { in: deferredKeys }
            }
          });
          if (removed.count > 0) {
            console.log(
              `[scan] removed ${removed.count} deferred outbound message(s) from thread ${thread.id}`
            );
          }
        }
      } catch (error) {
        console.warn(
          `[scan] deferred-key sweep failed for thread ${thread.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const persistedAt = new Date().toISOString();
    const syncTiming = trigger
      ? {
          sourceChangedAt: trigger.sourceChangedAt,
          persistedAt,
          trigger: trigger.kind
      }
      : undefined;
    if (syncTiming && persistedMessages > 0) {
      deps.recordLatency?.({
        metric: "source_change_to_persisted_message",
        durationMs: Date.parse(syncTiming.persistedAt) - Date.parse(syncTiming.sourceChangedAt),
        platform
      });
      deps.eventBus.emit({
        type: "MESSAGES_PERSISTED",
        jobId,
        threadId: thread.id,
        platform,
        syncTiming
      });
    }
    const optionalWorkStillAllowed = (): boolean =>
      !shouldContinue || shouldContinue();
    if (!optionalWorkStillAllowed()) skipAi = true;

    // Transcription enqueue. We resolve the persisted Message ids in a
    // single query rather than per-message lookups, then hand each one to
    // the optional hook. Fire-and-forget: scans never block on OpenAI
    // latency, and the transcription service's audioFingerprint dedup
    // means re-scans of the same audio are free.
    if (
      audioBearingMessageKeys.length > 0 &&
      deps.onAudioMessage &&
      optionalWorkStillAllowed()
    ) {
      try {
        const persistedAudioRows = await prisma.message.findMany({
          where: {
            threadId: thread.id,
            platformMessageKey: { in: audioBearingMessageKeys }
          },
          select: { id: true }
        });
        for (const row of persistedAudioRows) {
          try {
            deps.onAudioMessage({ messageId: row.id });
          } catch (error) {
            console.warn(
              `[scan-queue] onAudioMessage hook threw for message ${row.id}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      } catch (error) {
        console.warn(
          `[scan-queue] failed to resolve audio message ids for thread ${thread.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // System-event placeholders (e.g. LinkedIn "X turned on read receipts")
    // shouldn't drive needs-reply state or surface as the latest preview —
    // they aren't real messages from the other party. Exclude them from
    // inbound/outbound aggregates and from lastMessage selection.
    //
    // Deleted/retracted inbound placeholders ("This message has been
    // deleted.") are non-actionable too: the other party unsent the
    // message, so it must not flip a thread back into needs-reply state
    // and must not become the "closing beat" the closed-status
    // classifier sees. They are excluded from the *inbound* side only —
    // the operator deleting their own messages is a separate concern,
    // and the preview side (latestRealMessage) keeps the placeholder so
    // the inbox row still surfaces "this message has been deleted" so
    // the operator can see what happened.
    const SYSTEM_EVENT_PLACEHOLDER = "[system event]";
    // iMessage "kept an audio message" system events. Substring filter
    // is narrow enough — the exact phrase rarely appears in normal
    // user text. Read-side defence in depth: the iMessage adapter
    // drops these at ingestion going forward; this filter catches
    // historical rows already in the DB.
    const KEPT_AUDIO_CONTAINS = "kept an audio message";
    const notSystemEvent = {
      AND: [
        { NOT: { text: SYSTEM_EVENT_PLACEHOLDER } },
        { NOT: { text: { contains: KEPT_AUDIO_CONTAINS } } }
      ]
    };
    const NON_REAL_INBOUND_TEXTS = [
      SYSTEM_EVENT_PLACEHOLDER,
      ...DELETED_INBOUND_PLACEHOLDER_STRINGS
    ];
    const notNonRealInbound = {
      AND: [
        { text: { notIn: NON_REAL_INBOUND_TEXTS } },
        { NOT: { text: { contains: KEPT_AUDIO_CONTAINS } } }
      ]
    };

    const [latestMessagesDesc, aggregateAny, aggregateInbound, aggregateOutbound, lastInboundMessage, latestRealMessage] = await Promise.all([
      prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { timestamp: "desc" },
        take: maxMessages,
        // Pull the audio transcription row alongside each message so the
        // AI context builders (summary, reply brief, classifier, suggested
        // replies) can fold the transcript text into prompts. Most
        // messages have no transcription row; Prisma returns null cleanly
        // and renderMessageBody in services/ai.ts falls back to the
        // message text as before.
        include: { audioTranscription: true }
      }),
      prisma.message.aggregate({
        where: { threadId: thread.id },
        _max: { timestamp: true }
      }),
      prisma.message.aggregate({
        where: { threadId: thread.id, direction: "IN", ...notNonRealInbound },
        _max: { timestamp: true }
      }),
      prisma.message.aggregate({
        where: { threadId: thread.id, direction: "OUT", ...notSystemEvent },
        _max: { timestamp: true }
      }),
      prisma.message.findFirst({
        where: { threadId: thread.id, direction: "IN", ...notNonRealInbound },
        orderBy: { timestamp: "desc" }
      }),
      prisma.message.findFirst({
        where: { threadId: thread.id, ...notSystemEvent },
        orderBy: { timestamp: "desc" }
      })
    ]);

    const latestMessages = [...latestMessagesDesc].reverse();
    const resolvedLastMessageAt = aggregateAny._max.timestamp ?? candidateListTimestamp;
    const resolvedLastInboundAt = aggregateInbound._max.timestamp ?? null;
    // Operator OUT reactions (iMessage tapbacks) are stored on the parent
    // message's rawJson, not as standalone Message rows, so the aggregate
    // OUT-message query misses them. Fold them into the effective
    // lastOutboundAt so a thread where the operator reacted ❤️ instead
    // of typing a reply no longer hangs as needsReply forever (#393 —
    // pilot R-0033). See services/reaction-effects.ts for the helper.
    const resolvedLastOutboundAt = effectiveLastOutboundAt(
      aggregateOutbound._max.timestamp ?? null,
      latestMessagesDesc
    );
    const hasPersistedMessages = Boolean(aggregateAny._max.timestamp);
    const messageDerivedNeedsReply = Boolean(
      resolvedLastInboundAt && (!resolvedLastOutboundAt || resolvedLastInboundAt > resolvedLastOutboundAt)
    );
    const derivedNeedsReply = hasPersistedMessages ? messageDerivedNeedsReply : Boolean(candidate.needsReplyFromList);
    const handledBoundary = applyHandledBoundary({
      needsReply: derivedNeedsReply,
      handledAt: thread.handledAt,
      lastInboundAt: resolvedLastInboundAt
    });
    const resolvedNeedsReply = handledBoundary.needsReply;
    // latestRealMessage already excludes system-event placeholders. The
    // previous fallback `?? latestMessagesDesc[0]` could surface a
    // "[system event]" row as lastMessageDirection/Text on threads where
    // the most-recent row is e.g. "X turned on read receipts" — exactly
    // the case the notSystemEvent filter is meant to suppress. Drop the
    // fallback so threads with only system events leave the existing
    // thread.lastMessage* fields unchanged.
    const lastMessage = latestRealMessage;
    let resolvedLastMessagePreview = cleanText(
      candidate.lastMessagePreview ?? lastMessage?.text ?? thread.lastMessagePreview ?? ""
    );
    // #760: an audio-only newest message resolves to a "[Voice note]"-style
    // placeholder from both the list candidate and the message text. When its
    // transcript already exists, the transcript IS the preview — otherwise a
    // re-scan would clobber the transcript that transcript-preview.ts wrote
    // through when transcription finished. latestMessagesDesc carries the
    // audioTranscription include, so this costs no extra query.
    if (isVoicePlaceholderText(resolvedLastMessagePreview) && lastMessage) {
      const transcription = latestMessagesDesc.find((m) => m.id === lastMessage.id)?.audioTranscription;
      const transcript = transcription?.transcript?.trim() ?? "";
      if (transcription?.status === "transcribed" && transcript.length > 0) {
        resolvedLastMessagePreview = previewFromTranscript(transcript);
      }
    }

    const settings = await deps.settingsStore.getSettings();
    const risk = calculateRisk({
      lastInboundAt: resolvedLastInboundAt,
      lastOutboundAt: resolvedLastOutboundAt,
      amberHours: settings.amberHours,
      redHours: settings.redHours
    });

    // Bump SUMMARY_VERSION whenever the summary prompt or output shape
    // changes — every stored hash mismatches and re-summary fires on next
    // scan. Without a bump, quiet threads keep their old cached
    // `whatTheyWant` indefinitely because the inbound message hasn't
    // changed. The hash also folds in `needsReply` because the same
    // transcript produces different summaries in active-reply vs reopen
    // mode — the cache has to invalidate when the operator's reply flips
    // a thread from active to dormant (or vice versa).
    // v5 switches to second-person ("you") in all output text. Earlier
    // v4 substituted the configured displayName, but the name + greeting
    // already personalise the shell — summaries read more naturally in
    // second person ("Ashley let you know") than third ("Ashley let
    // Richard know"). Existing v4 summaries regenerate on next scan.
    // v6 adds the Reply Brief sub-object alongside the legacy fields and
    // bans abstract coaching phrases ("deepen the connection", "grounded
    // question", "helpful nudge") from the default-visible strings.
    // Existing v5 summaries regenerate on next scan so the rail surfaces
    // the new brief shape and clean prose rather than the stripped
    // fallback derived from the older summary.
    // v7 makes direct latest-inbound questions lead the ask summary and treats
    // later acknowledgements as closing settled logistics, so stale rows like
    // "still waiting for jacket confirmation" regenerate on the next scan.
    // v8 (quality audit vs real transcripts): bans the reconnect meta-question
    // leaking into what_they_want, makes "nothing pending" first-class instead
    // of resurrecting old arcs as manufactured jobs, quotes the contact's
    // actual question (proper nouns verbatim), and bans invented times/places/
    // plans in the ask and the brief's required points.
    // v9 adds the IDENTITY discipline after a predraft claimed the contact's
    // circumstances (her visa, her MVP) as the operator's own; briefs
    // regenerate so on_you stops directing the operator to justify the
    // contact's situation. Also the era of Gemini as default provider.
    // v10 pulls the pronoun rule into its own PRONOUN_DISCIPLINE block next
    // to the output instructions (pilot R-0090 / #757 - a female contact
    // summarised as "he"): they/them unless categorically evidenced. Cached
    // summaries regenerate against the new prompt on next scan.
    const SUMMARY_VERSION = "v10-pronouns";
    const needsReplyToken = resolvedNeedsReply ? "needs:1" : "needs:0";
    const lastInboundHash = lastInboundMessage
      ? stableHash(
          `${SUMMARY_VERSION}|${needsReplyToken}|${lastInboundMessage.timestamp.toISOString()}|${cleanText(lastInboundMessage.text)}`
        )
      : null;

    const shouldRefreshSummary =
      !skipAi &&
      optionalWorkStillAllowed() &&
      !!lastInboundHash &&
      lastInboundHash !== thread.lastInboundHash;

    let summary = thread.rollingSummary;
    let whatTheyWant = thread.whatTheyWant;
    let openLoopsJson = thread.openLoopsJson;
    let toneNotesJson = thread.toneNotesJson;
    let rememberJson = thread.rememberJson;
    let replyBriefJson = thread.replyBriefJson;

    if (shouldRefreshSummary) {
      const aiSummary = await deps.aiService.updateThreadSummary({
        displayName: person.displayName,
        // #753: group framing + per-sender transcript labels.
        isGroup: thread.isGroup,
        groupName: thread.groupName ?? null,
        previousSummary: thread.rollingSummary ?? undefined,
        previousOpenLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
        previousRemember: thread.rememberJson
          ? (JSON.parse(thread.rememberJson) as RememberItem[])
          : [],
        messages: latestMessages.map(prismaMessageToPrompt).filter(isAiVisibleMessage),
        needsReply: resolvedNeedsReply
      });

      // Defensive sanitiser: AI output (or its fallback path) can contain
      // unpaired surrogates if a slice landed mid-emoji. Strip them before
      // writing — the SQLite driver rejects the resulting JSON otherwise.
      if (optionalWorkStillAllowed()) {
        summary = stripUnpairedSurrogates(aiSummary.summary);
        whatTheyWant = stripUnpairedSurrogates(aiSummary.what_they_want);
        openLoopsJson = JSON.stringify(aiSummary.open_loops.map((s) => stripUnpairedSurrogates(s)));
        toneNotesJson = JSON.stringify(aiSummary.tone_notes.map((s) => stripUnpairedSurrogates(s)));
        // remember notes are already surrogate-stripped inside updateThreadSummary.
        rememberJson = JSON.stringify(aiSummary.remember);
        // Reply Brief is already sanitised + sub-fields surrogate-stripped
        // inside updateThreadSummary. Persisted as a single JSON blob; the
        // dashboard parses on read.
        replyBriefJson = aiSummary.reply_brief ? JSON.stringify(aiSummary.reply_brief) : null;
      } else {
        skipAi = true;
      }
    }

    // Phase 3: classify on first encounter only. Once a thread has a
    // category we don't re-spend tokens on every scan. Re-classification
    // can be triggered via /control/classify-uncategorized after a wrong
    // verdict is corrected manually.
    let categoryUpdate: string | null | undefined = undefined;
    if (!skipAi && optionalWorkStillAllowed() && !thread.category && hasPersistedMessages) {
      const classified = await deps.aiService
        .classifyThreadCategory({
          platform: thread.platform as PlatformName,
          displayName: person.displayName,
          messages: latestMessages.map(prismaMessageToPrompt).filter(isAiVisibleMessage),
          summary: summary ?? null,
          whatTheyWant: whatTheyWant ?? null
        })
        .catch(() => null);
      if (classified && optionalWorkStillAllowed()) {
        categoryUpdate = classified;
      } else if (!optionalWorkStillAllowed()) {
        skipAi = true;
      }
    }

    // Phase 2.5 (#287): conversation-end classifier. Re-runs whenever the
    // last inbound text or timestamp changes (a fresh inbound flips the
    // hash), so a thread that was closed but reopens with a new message
    // gets re-evaluated automatically. The dedicated cache key is
    // deliberately narrow (only the inbound itself) so it does not churn
    // when unrelated fields like needsReply flip.
    //
    // The version tag is bumped to v2 when the classifier started
    // returning a reason alongside the verdict — bumping it forces
    // existing verdicts (which lack a reason) to re-classify on the
    // next scan that processes their thread, so the dashboard can
    // surface a "why" caption on rows already in the DB.
    let closedStatusUpdate: string | null | undefined = undefined;
    let closedStatusReasonUpdate: string | null | undefined = undefined;
    let closedStatusCacheKeyUpdate: string | null | undefined = undefined;
    // Gate the AI classifier behind the operator's chosen help level
    // (#287 phase 2.5 follow-up). "memory_only" turns off the
    // organisational AI features — scoring + close detection — so the
    // operator can pick a quieter tier without losing summaries.
    const operatorProfile = await deps.settingsStore.getOperatorProfile();
    const allowClassification = operatorProfile.aiHelpLevel !== "memory_only";
    if (!skipAi && optionalWorkStillAllowed() && lastInboundMessage && allowClassification) {
      const closedKey = stableHash(
        `closed-v3|${lastInboundMessage.timestamp.toISOString()}|${cleanText(lastInboundMessage.text)}`
      );
      if (closedKey !== thread.closedStatusCacheKey) {
        // Hide deleted-inbound placeholders from the classifier so the
        // prompt sees the prior real turn as the "closing beat". A
        // retracted message must not be treated as a fresh inbound that
        // forces the verdict to OPEN. Operator OUT messages pass through
        // untouched (we only filter the inbound side).
        const classifierMessages = latestMessages
          .filter(
            (m) =>
              m.direction !== "IN" || !isNonActionableInboundPlaceholder(m.text)
          )
          .map(prismaMessageToPrompt)
          .filter(isAiVisibleMessage);
        const verdict = await deps.aiService
          .classifyThreadClosed({
            displayName: person.displayName,
            messages: classifierMessages,
            summary: summary ?? null
          })
          .catch(() => null);
        if (verdict && optionalWorkStillAllowed()) {
          closedStatusUpdate = verdict.status;
          closedStatusReasonUpdate = verdict.reason;
          closedStatusCacheKeyUpdate = closedKey;
        }
      }
    }

    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        // personId is intentionally omitted from the update. For newly-
        // created threads it was set above in `prisma.thread.create`. For
        // existing threads the established link is the source of truth —
        // re-asserting from `person` (resolved freshly from
        // candidate.displayName / candidate.profileUrl) can revert correct
        // links when the candidate carries stale or wrong identity. The
        // rescan endpoint at index.ts rebuilds candidate from the thread's
        // currently-linked person's displayName, so unconditional writes
        // here meant any out-of-band personId repair (or a later parser
        // fix) would get reverted on the next rescan. PR #151's profileUrl-
        // first resolution still applies on first creation.
        threadUrl: candidate.threadUrl ?? thread.threadUrl,
        ...(candidate.recipientVerificationLabel !== undefined
          ? { recipientVerificationLabel: candidate.recipientVerificationLabel }
          : {}),
        unreadCount: candidate.unreadCount ?? thread.unreadCount,
        // Keep the thread's group flags current, but never wipe a known
        // name: a group renamed on another device reports isGroup with no
        // groupName, and we'd rather keep the last name we saw than blank it.
        isGroup: candidate.isGroup ?? thread.isGroup,
        groupName: candidate.groupName ?? thread.groupName,
        lastMessagePreview: resolvedLastMessagePreview || null,
        // Phase 2: track who sent the most recent message + its text, so the
        // inbox-row preview reflects the latest of either party. Without
        // these, lastMessagePreview only tracked the latest INBOUND and went
        // stale the moment the operator replied.
        lastMessageDirection: lastMessage?.direction ?? thread.lastMessageDirection,
        lastMessageText: lastMessage?.text ?? thread.lastMessageText,
        // Phase 3: only write when AI returned a confident classification.
        // undefined leaves the existing column value unchanged (Prisma
        // omits the field from the UPDATE statement).
        ...(categoryUpdate ? { category: categoryUpdate } : {}),
        // Phase 2.5 (#287): same rule — only persist when the AI gave a
        // verdict for the current inbound hash. A null verdict leaves
        // the previous decision in place so a transient provider
        // outage does not silently clear classifications.
        ...(closedStatusUpdate !== undefined ? { closedStatus: closedStatusUpdate } : {}),
        ...(closedStatusReasonUpdate !== undefined
          ? { closedStatusReason: closedStatusReasonUpdate }
          : {}),
        ...(closedStatusCacheKeyUpdate !== undefined
          ? { closedStatusCacheKey: closedStatusCacheKeyUpdate }
          : {}),
        lastMessageAt: resolvedLastMessageAt,
        lastInboundAt: resolvedLastInboundAt,
        lastOutboundAt: resolvedLastOutboundAt,
        lastInboundHash,
        // Clear snooze when a new inbound arrives on a snoozed thread.
        // Otherwise an in-window snooze would hide the contact's reply
        // until the timer expires — turning snooze into a way to silently
        // miss messages instead of just deferring stale ones.
        ...(thread.snoozedUntil &&
        resolvedLastInboundAt &&
        (!thread.lastInboundAt || resolvedLastInboundAt.getTime() > thread.lastInboundAt.getTime())
          ? { snoozedUntil: null }
          : {}),
        ...(handledBoundary.clearHandledAt ? { handledAt: null } : {}),
        riskLevel: resolvedNeedsReply ? risk.level : "GREEN",
        slaDueAt: resolvedNeedsReply ? risk.slaDueAt : null,
        riskReason: thread.handledAt && !handledBoundary.clearHandledAt
          ? "Marked done manually"
          : hasPersistedMessages
          ? risk.riskReason
          : resolvedNeedsReply
            ? "Awaiting reply (list preview signal)"
            : risk.riskReason,
        needsReply: resolvedNeedsReply,
        rollingSummary: summary,
        whatTheyWant,
        openLoopsJson,
        toneNotesJson,
        rememberJson,
        replyBriefJson,
        // Stamp the first-full-backfill marker on the FIRST successful
        // persistence of any thread that has at least one message. We don't
        // gate on the pre-click `markedFullBackfill` flag because the URL
        // token isn't always extractable from the row anchor — that would
        // leave the column null forever and break skip-if-unchanged on every
        // subsequent scan. Once stamped (idempotent), future scans use the
        // skip-if-unchanged path. The `markedFullBackfill` flag still drives
        // the scroll-to-top behaviour upstream in the adapter.
        firstFullBackfillAt:
          !thread.firstFullBackfillAt && hasPersistedMessages
            ? new Date()
            : (thread.firstFullBackfillAt ?? undefined)
      }
    });

    // Heuristic name inference for platforms whose displayName is just a
    // handle (iMessage = phone/email). Run this after the message rows are
    // persisted, on threads where the operator hasn't already named the
    // contact. The inferredName surfaces in the dashboard as a "Maybe …"
    // suggestion they can confirm into displayName.
    if (platform === "IMESSAGE" && looksLikeUnresolvedHandle(person.displayName)) {
      const recentMessages = await prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { timestamp: "desc" },
        take: 200,
        select: { direction: true, text: true }
      });
      const guess = inferContactName(
        recentMessages.map((m) => ({ direction: m.direction, text: m.text }))
      );
      if (guess && guess !== person.inferredName) {
        await prisma.person.update({
          where: { id: person.id },
          data: { inferredName: guess }
        });
      }
    }

    deps.eventBus.emit({
      type: "THREAD_UPDATED",
      jobId,
      threadId: thread.id,
      syncTiming
    });

    if (quarantinedMessageKeys.size > 0) {
      const freshness = resolveMessageIdentityFreshness(quarantinedMessageKeys.size);
      await setPlatformStatus({
        platform,
        status: freshness.status,
        lastError: freshness.lastError ?? undefined
      });
    }

    await deps.auditLog({
      platform,
      stage: "Parse",
      action: "THREAD_UPDATED",
      status: quarantinedMessageKeys.size === 0 ? "OK" : "FAIL",
      details: {
        requestId: jobId,
        jobId,
        stage: "persist",
        threadId: thread.id,
        platformThreadId: candidate.platformThreadId,
        messageCount: latestMessages.length,
        freshnessComplete: quarantinedMessageKeys.size === 0,
        quarantinedMessages: quarantinedMessageKeys.size,
        needsReply: resolvedNeedsReply
      }
    });
    runLogger?.logAction({
      stage: "persist",
      action: "thread_updated",
      result: quarantinedMessageKeys.size === 0 ? "ok" : "partial",
      counts: {
        messageCount: latestMessages.length,
        quarantinedMessages: quarantinedMessageKeys.size,
        needsReply: resolvedNeedsReply
      },
      note: candidate.displayName
    });

    return {
      updatedThreads: 1,
      parsedMessages: messages.length,
      persistedMessages,
      quarantinedMessages: quarantinedMessageKeys.size
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
    getCurrentScanPlatform: () => currentScanPlatform ?? currentJob?.platform,
    /**
     * Live snapshot of the LinkedIn streaming scan in flight, or `null` when
     * no scan is running. Drives the system status bar's determinate progress
     * indicator (see `/health` -> `scanProgress`).
     */
    getCurrentScanProgress: () =>
      currentScanProgress
        ? {
            platform: currentScanProgress.platform,
            scope: currentScanProgress.scope,
            processedRows: currentScanProgress.processedRows,
            openedRows: currentScanProgress.openedRows,
            total: currentScanProgress.total,
            startedAt: currentScanProgress.startedAt
          }
        : null,
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
        skipAi?: boolean;
        trigger?: ScanTrigger;
        shouldContinue?: () => boolean;
      }
    ) =>
      syncThread(
        input.platform,
        input.candidate,
        input.maxMessages,
        input.requestId,
        input.runLogger,
        input.messages,
        false,
        input.skipAi ?? false,
        input.trigger,
        input.shouldContinue
      ),
    createContinueGate: () => {
      const baseline = abortVersion;
      return () => abortVersion === baseline;
    },
    clearAbort
  };

  function clearAbort(): void {
    abortReason = null;
  }
}
