import { createReadStream, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import express from "express";
import compression from "compression";
import multer from "multer";
import OpenAI from "openai";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { AppSettings, NormalizedMessage, PlatformAdapter, PlatformName, RememberItem, SelectorRegistry, SuggestedRepliesOutput, ThreadStub } from "@inbox-os/core";
import { BIRTHDAY_HORIZON_DAYS, calculateRisk, daysUntilBirthday, isNonContentIMessageSystemEvent, LEGACY_APP_NAME, resolveAppName, stableHash } from "@inbox-os/core";
import { Prisma } from "@prisma/client";
import { cleanText } from "./platforms/utils";
import { prisma } from "./db";
import { resolveConnectTimeoutMs, runnerConfig, projectRoot, dataDir } from "./config";
import { ensurePathInside, safeUploadFilename, streamFileToResponse } from "./utils/fs";
import { safeJsonParse } from "./utils/json";
import { filterDismissedOpenLoops } from "./utils/open-loops";
import {
  APP_SETTINGS_KEY,
  createSettingsStore,
  OPERATOR_PROFILE_KEY
} from "./services/settings";
import {
  applyGeminiKey,
  discardStaleEnvFileStages,
  recoverEnvFileValueForStartup,
  recoverEnvFileValueTransaction,
  resolveEnvWritePath,
  stageEnvFileValue,
  validateGeminiKey
} from "./services/setup-ai-key";
import {
  getSetupPreferences,
  mutateSetupPreferences,
  SETUP_PREFERENCES_KEY,
  SetupPreferencesConflictError,
  type SetupTranscriptionMode
} from "./services/setup-preferences";
import {
  createSetupPreferencesCoordinator,
  parseSetupPreferencesRequest
} from "./services/setup-preferences-coordinator";
import {
  applyPreparedTranscriptionSetup,
  createTranscriptionSetupManager,
  sweepTranscriptionDownloadOrphans,
  TranscriptionSetupBusyError
} from "./services/transcription-setup";
import {
  reconcileSelectedPlatformLifecycle,
  shouldStartLinkedInRealtimeWatcher
} from "./services/platform-selection-reconciler";
import {
  createPlatformSelectionCoordinator,
  PlatformNotSelectedError,
  PlatformSelectionSupersededError,
  type ReservedPlatformSelectionMutation
} from "./services/platform-selection-coordinator";
import {
  createAiConsentCoordinator,
  AiConsentMutationSupersededError,
  type ReservedAiConsentMutation
} from "./services/ai-consent-coordinator";
import { createAuditService } from "./services/audit";
import { deleteDraftRevision } from "./services/draft";
import { summarizeControlBody } from "./services/control-audit";
import { createEventBus } from "./services/event-bus";
import type { StagedAttachmentOwnership } from "./services/staged-attachment-cleanup";
import {
  createStagedAttachmentRequestLifecycle,
  multipartOnly
} from "./services/staged-attachment-request";
import {
  createOutgoingAttachmentActivityTracker,
  OUTGOING_ATTACHMENT_ORPHAN_GRACE_MS,
  sweepOutgoingAttachmentOrphans
} from "./services/outgoing-attachment-orphan-sweep";
import {
  createAiService,
  contactSnapshotFingerprint,
  operatorProfileFingerprint,
  isAiVisibleMessage,
  prismaMessageToPrompt
} from "./services/ai";
import {
  loadDictationMessageExamples,
  rememberDictationMessageExample
} from "./services/dictation-message-examples";
import {
  isInferredStyleEmpty,
  selectStyleSampleTexts,
  STYLE_ANALYSIS_MIN_SAMPLE
} from "./services/reply-style-analysis";
import { briefSignatureForCache, sanitizeReplyBrief, synthesiseFallbackBrief } from "./services/reply-brief";
import { analyzeStyle, styleFingerprint } from "./services/style";
import { createSelectorTestStore } from "./services/selector-report-store";
import { decidePersonNameAction } from "./services/person-name-action";
import { decidePersonFavouriteAction } from "./services/person-favourite-action";
import { getLinkPreview } from "./services/link-preview";
import { normalizePersonGroups } from "./services/person-groups";
import { buildReconnectCandidateWhere } from "./services/reconnect-candidate-query";
import { createSelectorTestService, isSelectorTestServiceError } from "./services/selector-tests";
import { extractFailureUrl, resolveConnectFailureResponse } from "./services/failure-routing";
import { createAdapters, type WhatsAppConnectState } from "./services/platform-factory";
import { isWhatsAppScannable } from "./platforms/whatsapp/scannable";
import {
  clearPersistedWhatsAppSession,
  hasPersistedWhatsAppSession
} from "./platforms/whatsapp/session";
import { findWhatsAppMediaByGuid, streamWhatsAppMedia } from "./platforms/whatsapp/media";
import {
  isWhatsAppPollSendPreDispatchError,
  isWhatsAppPollVotePreDispatchError,
  isWhatsAppSessionUnavailableError
} from "./platforms/whatsapp-adapter";
import {
  connectedPlatformCount,
  effectivePlatformStatus,
  isPlatformEnabled
} from "./platform-availability";
import QRCode from "qrcode";
import { IMessageDb } from "./platforms/imessage-db";
import { groupStubFields } from "./platforms/imessage-group-name";
import { appendOutboundReaction } from "./platforms/linkedin-message-reactions";
import { loadBestContactResolver } from "./services/contact-resolver";
import {
  convertAudioToWhisperWav,
  streamIMessageAttachment
} from "./services/imessage-attachment-server";
import {
  hasAudibleSpeechSignal,
  readAudioSignalSummary
} from "./services/transcription/audio-signal";
import {
  imessageVoiceSnapshotMeta,
  imessageVoiceSnapshotPath,
  snapshotImessageVoice
} from "./services/imessage-voice-store";
import { createIMessageVoiceSnapshotService } from "./services/imessage-voice-snapshot";
import { createScanQueue, type ScanTrigger } from "./services/scan-queue";
import { createInstagramMessageIdentityReconciler } from "./services/instagram-message-key-upgrade";
import { MESSAGE_IDENTITY_FRESHNESS_ERROR } from "./services/message-identity-reconciliation";
import { runReassessForThread } from "./services/reassess-thread";
import { resolveSseResumeCursor } from "./services/sse-resume-cursor";
import { resummarizeThread } from "./services/resummarize-thread";
import { pickCanonicalThread, canonicalWriteTargetId } from "./services/canonical-thread";
import { parseAllowedProfileUrl, ProfileUrlPolicyError } from "./services/profile-url-policy";
import { createIMessageWatcher, type IMessageWatcher } from "./services/imessage-watcher";
import { createIMessageSelectionLifecycle } from "./services/imessage-selection-lifecycle";
import { createChangeTriggeredScan } from "./services/change-triggered-scan";
import {
  createMessageSyncLatencyTracker,
  MESSAGE_SYNC_METRICS,
  type MessageSyncMetric
} from "./services/message-sync-latency";
import {
  createSendService,
  needsLocalReconciliation,
  parsePersistedSendSource,
  SendPolicyError
} from "./services/send";
import {
  abandonUnstartedUserTriggeredIntent,
  beginUserTriggeredIntentOperation,
  createUserTriggeredIntentMiddleware,
  resolveFocusPolicyMutationIntentKey,
  resolveUserTriggeredIntentThreadId,
  userTriggeredIntentVersion
} from "./services/user-triggered-intent-middleware";
import { createSendQueue, QUEUED_MESSAGE_SOURCES } from "./services/send-queue";
import { createPlatformSessionResetCoordinator } from "./services/platform-session-reset-coordinator";
import {
  bindFocusAutoAckEvents,
  createFocusAutoAckService,
  focusAcknowledgementClientSendIds,
  focusManualAckClientSendId
} from "./services/focus-auto-ack";
import { createAdminResetCoordinator } from "./services/admin-reset-coordinator";
import { createThreadExternalActionFence } from "./services/external-action-fence";
import {
  createDurableExternalActionService,
  DurableExternalActionError,
  type DurableExternalActionProjection
} from "./services/durable-external-action";
import {
  parsePersistedSendFailure,
  persistedSendRetryEligibility
} from "./services/send-failure";
import {
  deriveRetryClientSendId,
  parseRetryAttachments
} from "./services/send-retry";
import {
  createPollSendService,
  PollSendError
} from "./services/poll-send";
import { createReassessOnSendHandler } from "./services/reassess-on-send";
import { createScheduledSendPromoter } from "./services/scheduled-send-promoter";
import {
  calendarUrls,
  createCalendarFocusService,
  mergeCalendarSummaries
} from "./services/calendar-focus";
import { fetchIcsText } from "./services/calendar-fetch";
import { summarizeCalendar } from "./services/calendar-ics";
import { createBirthdaySync, type BirthdaySync } from "./services/birthday-sync";
import { createImessageNameSync, type ImessageNameSync } from "./services/imessage-name-sync";
import {
  canSelfUpdateInPlace,
  createAutomaticUpdateScheduler,
  launchUpdateApplyAndRestart,
  readAppVersion,
  requestNativeUpdate,
  resolveUpdateFeedUrl,
  runUpdateCheck,
  stagePendingUpdate
} from "./services/system-update";
import { resolveHostDeviceInfo } from "./services/host-device";
import {
  LINKEDIN_VOICE_MIME,
  hasLinkedInVoice,
  isLinkedInVoiceGuid,
  linkedInVoicePath
} from "./services/linkedin-voice-store";
import { resolveActionTargetThreadIds } from "./services/thread-action-targets";
import { createEnrichmentQueue } from "./services/enrichment-queue";
import {
  createLocalWhisperProvider,
  createOpenAITranscriptionProvider,
  createTextRefinementService,
  createTranscriptionService,
  createTransformersWhisperProvider,
  type AttachmentResolver,
  type TranscriptionProvider
} from "./services/transcription";
import { propagateTranscriptToThreadPreview } from "./services/transcript-preview";
import { createSelfProfileService } from "./services/self-profile";
import { createConversationStartersService } from "./services/conversation-starters";
import {
  PILOT_REPORT_TYPES,
  MAX_SCREENSHOTS,
  parseScreenshotDataUrl,
  forwardPilotReport,
  fetchPilotReportStatus,
  resolveReportBuildIdentity,
  type PilotScreenshot
} from "./services/pilot-feedback";
import {
  AdminResetGuardError,
  resetPlatformInboxGraph,
  validateAdminResetGuards
} from "./services/admin-reset";
import { cleanupDemoData, seedDemoData } from "./services/demo";
import { createDemoCleanupCoordinator } from "./services/demo-cleanup-coordinator";
import type { DemoSeedManifest } from "./types/runtime";
import { checkPresenterGuard } from "./middleware/presenter-guard";
import { createKeyedMutex } from "./services/keyed-mutex";
import { createRunLogger } from "./services/run-logger";
import {
  createCompressedJsonCacheEntry,
  type CompressedJsonCacheEntry
} from "./services/compressed-json-cache";
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
import {
  applyAck,
  applyDismissToday,
  applySnoozePerson,
  applyUnsnoozePerson,
  computeTick,
  createOverdueDigestStore,
  isValidCadence,
  listSnoozedPeople,
  selectCandidates
} from "./services/overdue-digest";
import type { OverdueDigestRowInput } from "@inbox-os/core";

const app = express();
let registerUserTriggeredIntentForRequest = (
  _threadId: string
):
  | (() => void)
  | { release: () => void; ready: Promise<number | undefined> } => () => {};
let registerFocusPolicyMutationForRequest = (): (() => void) => () => {};
const registerUserTriggeredSendIntent = createUserTriggeredIntentMiddleware(
  (threadId) => registerUserTriggeredIntentForRequest(threadId),
  resolveUserTriggeredIntentThreadId
);
const registerFocusPolicyMutationIntent = createUserTriggeredIntentMiddleware(
  () => registerFocusPolicyMutationForRequest(),
  resolveFocusPolicyMutationIntentKey
);
app.use(registerUserTriggeredSendIntent);
app.use(registerFocusPolicyMutationIntent);
const runnerProcessInfo = {
  executableName: basename(process.execPath),
  executablePath: process.execPath,
  command: process.argv.join(" ")
};
// How far back the per-thread receipts lookup scans the audit log. A thread's
// own scan/send receipts are recent, so 180 days is generous while keeping the
// query off the full historical telemetry table.
const RECEIPTS_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

// Gzip JSON responses. The inbox (hundreds of rows of preview/summary text)
// and thread (up to 120 messages + reply-brief/suggested-reply JSON) payloads
// are 5-10x compressible, so this cuts transfer + client JSON.parse on every
// navigation and poll. The SSE stream (/events, text/event-stream) is
// excluded — compression buffers chunked responses and would break live
// events — and callers can opt out with an `x-no-compression` header.
app.use(
  compression({
    filter: (req, res) => {
      if (req.path === "/events") return false;
      if (req.headers["x-no-compression"]) return false;
      const type = res.getHeader("Content-Type");
      if (typeof type === "string" && type.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    }
  })
);

// Most routes carry tiny JSON. /control/pilot-feedback can carry several
// base64 screenshots, so it gets a larger limit; everything else stays tight.
const jsonSmall = express.json({ limit: "1mb" });
const jsonLarge = express.json({ limit: "32mb" });
app.use((req, res, next) => {
  if (req.path === "/control/pilot-feedback") return jsonLarge(req, res, next);
  return jsonSmall(req, res, next);
});

// Multer is loaded lazily on multipart routes (file uploads for outbound
// attachments). The default disk-storage strategy puts files under
// data/outgoing-attachments/<send-request-id>/ so the iMessage adapter
// can reference them by absolute path when shelling out to osascript.
const outgoingAttachmentsRoot = resolve(dataDir, "outgoing-attachments");
mkdirSync(outgoingAttachmentsRoot, { recursive: true });
const outgoingAttachmentActivity = createOutgoingAttachmentActivityTracker();
const outgoingAttachmentRequestActivity = new WeakMap<
  express.Request,
  Array<{ directory: string; release: () => void }>
>();
function registerOutgoingAttachmentRequestDirectory(
  req: express.Request,
  directory: string
): () => void {
  const releaseActivity = outgoingAttachmentActivity.activate(directory);
  const records = outgoingAttachmentRequestActivity.get(req) ?? [];
  const record = { directory, release: releaseActivity };
  records.push(record);
  outgoingAttachmentRequestActivity.set(req, records);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseActivity();
    const current = outgoingAttachmentRequestActivity.get(req);
    if (!current) return;
    const next = current.filter((item) => item !== record);
    if (next.length > 0) outgoingAttachmentRequestActivity.set(req, next);
    else outgoingAttachmentRequestActivity.delete(req);
  };
}
function releaseOutgoingAttachmentRequestActivity(req: express.Request): void {
  const records = outgoingAttachmentRequestActivity.get(req) ?? [];
  for (const record of records) record.release();
  outgoingAttachmentRequestActivity.delete(req);
}
async function discardFailedAttachmentUpload(req: express.Request): Promise<void> {
  const records = [...(outgoingAttachmentRequestActivity.get(req) ?? [])];
  try {
    await Promise.all(
      records.map((record) =>
        rm(record.directory, { recursive: true, force: true })
      )
    );
  } finally {
    releaseOutgoingAttachmentRequestActivity(req);
  }
}
async function discardStagedAttachments(
  attachments: Array<{ absolutePath: string }>
): Promise<void> {
  const rootPrefix = `${outgoingAttachmentsRoot}${sep}`;
  const directories = new Set(
    attachments.map((attachment) => resolve(dirname(attachment.absolutePath)))
  );
  await Promise.all(
    [...directories]
      .filter((directory) => directory.startsWith(rootPrefix))
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
}
async function sendRequestOwnsStagedAttachments(
  clientSendId: string | undefined,
  attachments: Array<{ absolutePath: string }>
): Promise<StagedAttachmentOwnership> {
  if (!clientSendId || attachments.length === 0) return "unowned";
  const row = await prisma.sendRequest.findUnique({
    where: { clientSendId },
    select: { attachmentsJson: true }
  });
  if (!row?.attachmentsJson) return "unowned";
  try {
    const persisted = JSON.parse(row.attachmentsJson) as Array<{
      absolutePath?: unknown;
    }>;
    const persistedPaths = new Set(
      persisted
        .map((attachment) => attachment.absolutePath)
        .filter((path): path is string => typeof path === "string")
    );
    return attachments.every((attachment) =>
      persistedPaths.has(attachment.absolutePath)
    )
      ? "owned"
      : "unowned";
  } catch {
    return "unknown";
  }
}
let outgoingAttachmentSweepRunning = false;
async function sweepOutgoingAttachmentOrphansOnce(): Promise<void> {
  if (outgoingAttachmentSweepRunning) return;
  outgoingAttachmentSweepRunning = true;
  try {
    await sweepOutgoingAttachmentOrphans({
      activity: outgoingAttachmentActivity,
      outgoingAttachmentsRoot,
      graceMs: OUTGOING_ATTACHMENT_ORPHAN_GRACE_MS,
      loadRows: () => prisma.sendRequest.findMany({
        select: { attachmentsJson: true }
      })
    });
  } finally {
    outgoingAttachmentSweepRunning = false;
  }
}
const uploadAttachments = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = resolve(outgoingAttachmentsRoot, uuid());
      let releaseActivity: (() => void) | undefined;
      try {
        releaseActivity = registerOutgoingAttachmentRequestDirectory(req, dir);
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (error) {
        releaseActivity?.();
        cb(error instanceof Error ? error : new Error(String(error)), dir);
      }
    },
    filename: (_req, file, cb) => {
      // Keep extension so Messages.app can sniff the right file type, but never
      // trust the client name verbatim: multer path.join()s it onto the
      // per-request dir, so a "../.." originalname would escape it (arbitrary
      // file write). safeUploadFilename strips separators and ".."/"." names.
      cb(null, safeUploadFilename(file.originalname, `${uuid()}.bin`));
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
}).array("attachments", 10);

const maybeMultipart = multipartOnly(uploadAttachments, {
  onUploadError: discardFailedAttachmentUpload
});

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

// #462 (pilot R-0061): voice-to-text dictation. The composer records a short
// audio clip and posts it here as a single `audio` field; we transcribe it
// with the existing provider and return the text for the operator to review.
// Clips land in their own temp dir and are removed once transcription
// completes (success or failure) — nothing is persisted as a Message.
const dictationUploadRoot = resolve(dataDir, "dictation-uploads");
mkdirSync(dictationUploadRoot, { recursive: true });
const dictationMimeTypes = new Set([
  "audio/aac",
  "audio/m4a",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav"
]);
const uploadDictation = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = resolve(dictationUploadRoot, uuid());
      mkdirSync(dir, { recursive: true });
      (req as express.Request & { dictationUploadDir?: string }).dictationUploadDir = dir;
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, safeUploadFilename(file.originalname, "dictation.webm"))
  }),
  fileFilter: (_req, file, cb) => {
    const mimeType = file.mimetype.toLowerCase().split(";", 1)[0] || "";
    if (!dictationMimeTypes.has(mimeType)) {
      cb(new Error("Unsupported dictation audio type."));
      return;
    }
    cb(null, true);
  },
  limits: { fileSize: 25 * 1024 * 1024 } // ~ several minutes of speech
}).single("audio");

function kindFromMime(mime: string | undefined, filename: string | undefined): "voice_note" | "photo" | "video" | "audio" | "pdf" | "sticker" | "gif" | "unknown" {
  const m = (mime ?? "").toLowerCase();
  const n = (filename ?? "").toLowerCase();
  if (m === "image/gif" || n.endsWith(".gif")) return "gif";
  if (m === "image/webp" && /sticker/i.test(n)) return "sticker";
  if (m.startsWith("image/")) return "photo";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.startsWith("audio/")) return /webm|opus|m4a|aac|caf/.test(m) || /audio.message/.test(n) ? "voice_note" : "audio";
  return "unknown";
}

const settingsStore = createSettingsStore();
const aiConsentCoordinator = createAiConsentCoordinator({
  getEnabled: async () => (await settingsStore.getSettings()).aiEnabled !== false
});

async function persistSettingRows(
  entries: ReadonlyArray<{ key: string; value: unknown }>
): Promise<void> {
  await prisma.$transaction(
    entries.map(({ key, value }) =>
      prisma.setting.upsert({
        where: { key },
        update: { valueJson: JSON.stringify(value) },
        create: { key, valueJson: JSON.stringify(value) }
      })
    )
  );
}

const setupPreferencesCoordinator = createSetupPreferencesCoordinator({
  availablePlatforms: runnerConfig.availablePlatforms,
  mutateSettings: settingsStore.mutateSettings,
  mutateOperatorProfile: settingsStore.mutateOperatorProfile,
  mutatePreferences: mutateSetupPreferences,
  persistSetupState: (settings, preferences) =>
    persistSettingRows([
      { key: APP_SETTINGS_KEY, value: settings },
      { key: SETUP_PREFERENCES_KEY, value: preferences }
    ]),
  persistCompletedState: (operatorProfile, preferences) =>
    persistSettingRows([
      { key: OPERATOR_PROFILE_KEY, value: operatorProfile },
      { key: SETUP_PREFERENCES_KEY, value: preferences }
    ])
});
const overdueDigestStore = createOverdueDigestStore(prisma);
const auditService = createAuditService();
const eventBus = createEventBus();
const messageSyncLatency = createMessageSyncLatencyTracker();
const aiService = createAiService(settingsStore, {
  isAiEnabledForNewWork: () => aiConsentCoordinator.isEnabledForNewWork()
});
const selectorReports = createSelectorTestStore();

// ---------------------------------------------------------------------------
// Version-gated response cache for the hottest polled endpoint.
//
// /data/inbox is polled every 8-10s by the app shell and the list pages, and
// every poll re-does the full row load + shaping even when nothing changed.
// The runner is the only writer of its SQLite DB, so it knows when data may
// have changed: any runner event (scans, sends, reassess) and any mutating
// HTTP request. Between those moments an identical poll is served from
// memory. A short hard TTL keeps purely time-derived fields (risk recolour,
// snooze expiry) honest even if some future write path forgets to signal.
// ---------------------------------------------------------------------------
const INBOX_CACHE_TTL_MS = 20_000;
const inboxResponseCache = new Map<string, CompressedJsonCacheEntry>();

function sendCachedInboxResponse(
  req: express.Request,
  res: express.Response,
  cached: CompressedJsonCacheEntry,
  cacheStatus: "hit" | "miss",
  startedAt: number
): void {
  res.setHeader("X-RIOS-Cache", cacheStatus);
  res.setHeader("Server-Timing", `inbox-prep;dur=${(performance.now() - startedAt).toFixed(2)}`);
  res.vary("Accept-Encoding");
  res.type("application/json");
  if (req.acceptsEncodings("gzip") === "gzip") {
    res.setHeader("Content-Encoding", "gzip");
    res.send(cached.gzip);
    return;
  }
  res.send(cached.json);
}
let dataVersion = 0;
function bumpDataVersion(): void {
  dataVersion += 1;
  inboxResponseCache.clear();
}
eventBus.subscribe(() => bumpDataVersion());
app.use((req, res, next) => {
  if (req.method !== "GET") {
    res.on("finish", bumpDataVersion);
  }
  next();
});

// Render a whatsapp-web.js QR string to a data-URL PNG (#774).
async function qrcodeToDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, { margin: 1, width: 264 });
}

// WhatsApp connect state (#774). whatsapp-web.js emits a QR string when a
// scan is needed; we render it to a data-URL PNG so the dashboard can show a
// scannable image without shipping a QR library to the browser. Latest QR +
// state live here and are read by /data/whatsapp/status.
const whatsappConnect: {
  state: WhatsAppConnectState;
  qr: string | null;
  qrDataUrl: string | null;
  updatedAt: string;
} = { state: "disconnected", qr: null, qrDataUrl: null, updatedAt: new Date().toISOString() };

// Forward reference: the WhatsApp state-change hook below fires long after
// boot, but createAdapters runs before the scan queue exists. Same settable-
// holder pattern as enqueueEnrichmentForScan.
let enqueueWhatsAppInitialScan: (() => void) | null = null;
// Debounced "an inbound WhatsApp message arrived → scan" nudge. Late-bound to
// the scan queue for the same reason.
let onWhatsAppMessageArrived:
  | ((input: { platformThreadId: string; sourceChangedAt: string }) => void)
  | null = null;
let onLinkedInInboxChanged:
  | ((change: { reason: string; sourceChangedAt: string }) => void)
  | null = null;

// Mirror the whatsapp-web.js connect state onto the WHATSAPP platforms row so
// the dashboard's "X/N connected" count, reconnect modal, and hasEverConnected
// gating (#708/#710) see WhatsApp like any other platform. connectedAt is only
// ever SET (never cleared) here — it is the durable "operator uses WhatsApp"
// signal, so a drop to disconnected keeps it and just flips status.
async function syncWhatsAppPlatformRow(state: WhatsAppConnectState): Promise<void> {
  // "qr_ready" counts as not-connected: the library is explicitly asking for
  // a re-link, so a stale CONNECTED row (e.g. operator logged out from the
  // phone) must not keep the dashboard showing WhatsApp as healthy.
  if (state !== "connected" && state !== "disconnected" && state !== "qr_ready") {
    return;
  }
  const status = state === "connected" ? "CONNECTED" : "NOT_CONNECTED";
  const connectedAt = state === "connected" ? new Date() : undefined;
  await prisma.platform.upsert({
    where: { name: "WHATSAPP" },
    update: { status, lastError: null, ...(connectedAt ? { connectedAt } : {}) },
    create: { name: "WHATSAPP", status, lastError: null, ...(connectedAt ? { connectedAt } : {}) }
  });
}

const {
  adapters,
  resolveSelectorsForPlatform,
  sessionManager,
  resolvePlatformSession
} = createAdapters({
  settingsStore,
  whatsappPrisma: prisma,
  onWhatsAppStateChange: (state) => {
    whatsappConnect.state = state;
    whatsappConnect.updatedAt = new Date().toISOString();
    if (state === "connected" || state === "disconnected") {
      whatsappConnect.qr = null;
      whatsappConnect.qrDataUrl = null;
    }
    void syncWhatsAppPlatformRow(state).catch((error) => {
      console.warn(
        `[whatsapp] platform row sync failed for state=${state}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    if (state === "connected") {
      void settingsStore.getSettings().then((settings) => {
        if (settings.enabledPlatforms.includes("WHATSAPP")) {
          enqueueWhatsAppInitialScan?.();
          return;
        }
        return reconcilePlatformSelection();
      }).catch((error) => {
        console.warn(
          `[whatsapp] selection reconciliation failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
    eventBus.emit({ type: "WHATSAPP_STATE", jobId: uuid(), state });
  },
  onWhatsAppIncomingMessage: (input) => onWhatsAppMessageArrived?.(input),
  onWhatsAppQr: (qr) => {
    whatsappConnect.qr = qr;
    whatsappConnect.updatedAt = new Date().toISOString();
    void qrcodeToDataUrl(qr)
      .then((dataUrl) => {
        whatsappConnect.qrDataUrl = dataUrl;
        eventBus.emit({ type: "WHATSAPP_STATE", jobId: uuid(), state: "qr_ready" });
      })
      .catch((error) => {
        console.warn(`[whatsapp] QR render failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  },
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
  resolvePlatformSession,
  screenshotDir: runnerConfig.screenshotDir,
  domDumpDir: runnerConfig.domDumpDir,
});

const operationMutex = createKeyedMutex();
const defaultPersonKey = "default";
const allPlatforms: PlatformName[] = runnerConfig.availablePlatforms;

type ScanQueueWithSmokeIngest = ReturnType<typeof createScanQueue> & {
  syncThreadForIngest: (input: {
    platform: PlatformName;
    candidate: ThreadStub;
    maxMessages: number;
    requestId: string;
    messages?: NormalizedMessage[];
    trigger?: ScanTrigger;
  }) => Promise<{
    updatedThreads: number;
    parsedMessages: number;
    persistedMessages: number;
    quarantinedMessages: number;
  }>;
};

// Lock-key helpers used both by control endpoints and the enrichment
// queue's defer-when-busy logic. Defined here (instead of further down)
// so the enrichment queue can be constructed alongside scan/send and
// share the same lock vocabulary.
function platformLockKey(platform: PlatformName): string {
  return `${resolvePlatformSession(platform).personKey}:${platform}`;
}
function sendLockKeyFor(platform: PlatformName): string {
  return `${resolvePlatformSession(platform).personKey}:${platform}:SEND`;
}
function enrichLockKeyFor(): string {
  return `${defaultPersonKey}:LINKEDIN:ENRICH`;
}
function globalResetLockKey(): string {
  return `${defaultPersonKey}:GLOBAL_RESET`;
}

let platformSelectionAllowsNewWork = (_platform: PlatformName): boolean => true;

// Forward reference: the scan-queue's `onNewPerson` hook needs to call
// the enrichment queue's `enqueue`, but the enrichment queue is built
// AFTER scan-queue (it depends on sessionManager + lock vocabulary that
// exists at this point). Use a settable holder so the wire-up order
// works without a refactor.
let enqueueEnrichmentForScan:
  | ((input: { personId: string; trigger: "first_seen" }) => void)
  | null = null;

// Audio transcription wiring. The provider exists only when an OpenAI
// key is configured and the feature is enabled; the service falls back
// to no-ops otherwise (returning "disabled" without touching the DB).
// The iMessage attachment resolver opens a short-lived read-only handle
// against chat.db per call, matching the existing /data/imessage-
// attachment route's pattern.
const imessageAttachmentResolver: AttachmentResolver | null = runnerConfig.imessage.enabled
  ? {
      async resolve(guid: string) {
        // Live chat.db metadata is authoritative (Apple's real mime type and
        // names); the snapshot's mime is only derived from its file
        // extension. Prefer live while the row AND file survive, and fall
        // back to our snapshot once "Expire After 2 Minutes" has deleted
        // them — that's what keeps transcription working after expiry.
        let live: {
          absolutePath: string | null;
          mimeType: string | null;
          filename: string | null;
          transferName: string | null;
        } | null = null;
        const selected =
          platformSelectionAllowsNewWork("IMESSAGE") &&
          (await settingsStore.getSettings()).enabledPlatforms.includes("IMESSAGE");
        if (selected) {
          try {
            const db = new IMessageDb(runnerConfig.imessage.dbPath);
            try {
              live = db.findAttachmentByGuid(guid) ?? null;
            } finally {
              db.close();
            }
          } catch {
            // chat.db unreadable (Full Disk Access?); the snapshot can still serve.
          }
        }
        if (live?.absolutePath && existsSync(live.absolutePath)) {
          return {
            absolutePath: live.absolutePath,
            mimeType: live.mimeType,
            filename: live.filename,
            transferName: live.transferName
          };
        }
        const snapshot = imessageVoiceSnapshotMeta(guid);
        if (snapshot) {
          // The row can outlive the file (expiry deletes the file first):
          // keep chat.db's mime/names over the extension-derived ones.
          return {
            absolutePath: snapshot.absolutePath,
            mimeType: live?.mimeType ?? snapshot.mimeType,
            filename: live?.filename ?? snapshot.filename,
            transferName: live?.transferName ?? snapshot.transferName
          };
        }
        if (!live?.absolutePath) return null;
        // Row exists, file gone, no snapshot: surface the (missing) live
        // path so the service records its missing_file skip + retention
        // warning, exactly as before snapshots existed.
        return {
          absolutePath: live.absolutePath,
          mimeType: live.mimeType,
          filename: live.filename,
          transferName: live.transferName
        };
      }
    }
  : null;

// LinkedIn voice messages have their bytes captured during scan
// (linkedin-adapter.ts -> captureLinkedInVoiceMessage) and persisted
// under data/linkedin-voice-messages/<sha256(urn)>.m4a. The resolver
// just rebuilds that path from the URN we set as the attachment guid.
// Returns null when the file isn't on disk yet (e.g. the scan happened
// before the audio fetch landed) so the transcription service records a
// `missing_file` skip the operator can manually re-attempt.
const linkedinAttachmentResolver: AttachmentResolver = {
  async resolve(urn: string) {
    if (!hasLinkedInVoice(urn)) return null;
    return {
      absolutePath: linkedInVoicePath(urn),
      mimeType: LINKEDIN_VOICE_MIME,
      filename: "voice-message.m4a",
      transferName: "Voice message"
    };
  }
};

// Composite resolver dispatched on the guid format. iMessage attachments
// are UUID-shaped (`3C3CA15E-7C18-...`); LinkedIn voice notes set the
// message key as the guid. That key is either a real LinkedIn event URN
// (`urn:li:msg_message:...`) or — when the bubble had no stable DOM id —
// a content fingerprint (`li-msg-fp:...`) or the raw positional fallback
// (`li-msg-<index>`); the voice store hashes whichever key we used to
// write the file, so all three LinkedIn shapes must route to the LinkedIn
// resolver. Falls back to null when neither resolver recognises the id so
// the transcription service skips gracefully instead of crashing.
const compositeAttachmentResolver: AttachmentResolver | null =
  imessageAttachmentResolver || linkedinAttachmentResolver
    ? {
        async resolve(id: string) {
          if (isLinkedInVoiceGuid(id)) {
            return linkedinAttachmentResolver.resolve(id);
          }
          return imessageAttachmentResolver?.resolve(id) ?? null;
        }
      }
    : null;

// Provider selection. With audio transcription off, the service stays
// disabled and no provider is constructed. With it on, we pick exactly
// one provider per the operator's `AUDIO_TRANSCRIPTION_PROVIDER`:
//   - "local-whisper": runs whisper.cpp on this Mac. No OpenAI call.
//   - "openai": uses /v1/audio/transcriptions. Kept as an explicit
//     fallback for operators who don't have whisper.cpp set up yet
//     or want a quality comparison.
// A misconfigured provider (missing command/model for local, missing
// API key for openai) leaves `provider = null` so the service marks
// each row as skipped with the appropriate reason on the first run
// rather than throwing.
let transcriptionProvider: TranscriptionProvider | null = null;
const tierProviders: Partial<
  Record<"fast" | "standard" | "max", TranscriptionProvider>
> = {};
if (runnerConfig.audioTranscription.enabled) {
  const prog = runnerConfig.audioTranscription.progressive;
  if (prog.enabled && runnerConfig.audioTranscription.provider === "local-whisper") {
    // Progressive (multi-tier) local Whisper. Each configured tier
    // gets its own provider instance — same CLI binary, same threads
    // / timeout / extra args, different `ggml-*.bin` model file. The
    // service runs them in sequence (fast → standard → max) and
    // writes a separate attempt row per tier; missing tier paths are
    // silently skipped.
    const lw = runnerConfig.audioTranscription.localWhisper;
    if (!lw.command) {
      console.warn(
        "[transcription] progressive mode enabled but LOCAL_WHISPER_COMMAND is unset; " +
          "voice notes will be skipped with reason local_whisper_not_configured"
      );
    } else {
      const baseLwConfig = {
        command: lw.command,
        timeoutMs: lw.timeoutMs,
        threads: lw.threads,
        extraArgs: lw.extraArgs
      };
      if (prog.fastModelPath) {
        tierProviders.fast = createLocalWhisperProvider({
          config: { ...baseLwConfig, modelPath: prog.fastModelPath }
        });
      }
      if (prog.standardModelPath) {
        tierProviders.standard = createLocalWhisperProvider({
          config: { ...baseLwConfig, modelPath: prog.standardModelPath }
        });
      }
      if (prog.maxModelPath) {
        tierProviders.max = createLocalWhisperProvider({
          config: { ...baseLwConfig, modelPath: prog.maxModelPath }
        });
      }
      if (
        !tierProviders.fast &&
        !tierProviders.standard &&
        !tierProviders.max
      ) {
        console.warn(
          "[transcription] progressive mode enabled but no tier model paths set; " +
            "voice notes will be skipped"
        );
      }
    }
  } else if (runnerConfig.audioTranscription.provider === "local-whisper") {
    // Single-model local-whisper (pre-progressive behaviour). Kept
    // intact for operators who haven't migrated to the tier env vars.
    const lw = runnerConfig.audioTranscription.localWhisper;
    if (!lw.command || !lw.modelPath) {
      console.warn(
        "[transcription] AUDIO_TRANSCRIPTION_PROVIDER=local-whisper but " +
          "LOCAL_WHISPER_COMMAND or LOCAL_WHISPER_MODEL_PATH is unset; " +
          "voice notes will be skipped with reason local_whisper_not_configured"
      );
    } else {
      transcriptionProvider = createLocalWhisperProvider({
        config: {
          command: lw.command,
          modelPath: lw.modelPath,
          timeoutMs: lw.timeoutMs,
          threads: lw.threads,
          extraArgs: lw.extraArgs
        }
      });
    }
  } else if (runnerConfig.audioTranscription.provider === "transformers") {
    // Local transformers.js + ONNX — the pilot default. Needs no external
    // binary or build tools; the model is downloaded into data/models on
    // install. The provider self-skips gracefully (reason
    // transformers_model_unavailable) until the model is present, so no
    // missing-config warning is needed here.
    const tw = runnerConfig.audioTranscription.transformers;
    transcriptionProvider = createTransformersWhisperProvider({
      config: {
        modelId: tw.modelId,
        modelDir: tw.modelDir,
        timeoutMs: tw.timeoutMs
      }
    });
  } else {
    if (!runnerConfig.openAiApiKey) {
      console.warn(
        "[transcription] AUDIO_TRANSCRIPTION_ENABLED=true but OPENAI_API_KEY is unset; voice notes will be skipped"
      );
    } else {
      transcriptionProvider = createOpenAITranscriptionProvider({
        apiKey: runnerConfig.openAiApiKey,
        modelLabel: runnerConfig.audioTranscription.model
      });
    }
  }
}

// #462: the best provider available for one-shot dictation. Prefers the
// single configured provider, else the balanced "standard" progressive tier
// (then max, then fast). Null when transcription isn't configured at all, in
// which case the dictation route and capability probe both report it off.
function pickDictationProvider(): TranscriptionProvider | null {
  return (
    transcriptionProvider ??
    tierProviders.standard ??
    tierProviders.max ??
    tierProviders.fast ??
    null
  );
}

// GPT-5-nano text refinement is text-only — never receives audio
// bytes. Constructed only when the operator opts in AND the OpenAI
// key is present. The refiner itself short-circuits on a null client,
// but we leave it null here so wiring is explicit.
const refinementConfig = runnerConfig.audioTranscription.refinement;
const refinementClient =
  refinementConfig.enabled && runnerConfig.openAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.openAiApiKey })
    : null;
const textRefinementService = refinementConfig.enabled
  ? createTextRefinementService({
      client: refinementClient,
      canDispatch: async () => {
        if (!aiConsentCoordinator.isEnabledForNewWork()) return false;
        const settings = await settingsStore.getSettings();
        return (
          aiConsentCoordinator.isEnabledForNewWork() &&
          settings.aiEnabled !== false
        );
      },
      config: {
        model: refinementConfig.model,
        timeoutMs: refinementConfig.timeoutMs
      }
    })
  : null;
if (refinementConfig.enabled && !refinementClient) {
  console.warn(
    "[transcription] AUDIO_TRANSCRIPTION_REFINEMENT_ENABLED=true but OPENAI_API_KEY is unset; " +
      "refinement will be skipped (local transcripts unaffected)"
  );
}

// Nearby-thread resolver for the refinement prompt. Reads the same
// prisma instance as the rest of the service; pulled into a small
// dep so progressive tests can stub a fixed conversation context.
const nearbyMessagesResolver = textRefinementService
  ? {
      async fetch(input: {
        messageId: string;
        threadId: string;
        radius: number;
      }) {
        const radius = Math.max(1, Math.min(input.radius, 20));
        const target = await prisma.message.findUnique({
          where: { id: input.messageId },
          select: { timestamp: true }
        });
        if (!target) return [];
        const [before, after] = await Promise.all([
          prisma.message.findMany({
            where: {
              threadId: input.threadId,
              timestamp: { lt: target.timestamp }
            },
            orderBy: { timestamp: "desc" },
            take: radius,
            select: { direction: true, timestamp: true, text: true }
          }),
          prisma.message.findMany({
            where: {
              threadId: input.threadId,
              timestamp: { gt: target.timestamp }
            },
            orderBy: { timestamp: "asc" },
            take: radius,
            select: { direction: true, timestamp: true, text: true }
          })
        ]);
        return [...before.reverse(), ...after]
          .filter((m) => (m.text ?? "").trim().length > 0)
          .map((m) => ({
            direction: m.direction === "OUT" ? ("OUT" as const) : ("IN" as const),
            timestamp: m.timestamp.toISOString(),
            text: m.text
          }));
      }
    }
  : null;

// The setup assistant can turn local transcription on without restarting the
// runner. When transcription was off at boot there is no provider yet, so use
// a small model-aware proxy that builds the chosen Transformers provider on
// first use and keeps one cached instance per model.
if (
  runnerConfig.audioTranscription.provider === "transformers" ||
  (!runnerConfig.audioTranscription.enabled && !transcriptionProvider)
) {
  const setupProviders = new Map<string, TranscriptionProvider>();
  transcriptionProvider = {
    id: "transformers",
    modelLabel: "whisper",
    transcribe(request) {
      const config = runnerConfig.audioTranscription.transformers;
      let provider = setupProviders.get(config.modelId);
      if (!provider) {
        provider = createTransformersWhisperProvider({
          config: {
            modelId: config.modelId,
            modelDir: config.modelDir,
            timeoutMs: config.timeoutMs
          }
        });
        setupProviders.set(config.modelId, provider);
      }
      return provider.transcribe(request);
    }
  };
}

const transcriptionServiceConfig = {
  enabled: runnerConfig.audioTranscription.enabled,
  apiKey: runnerConfig.openAiApiKey ?? null,
  model: runnerConfig.audioTranscription.model,
  language: runnerConfig.audioTranscription.language,
  maxBytes: runnerConfig.audioTranscription.maxBytes,
  maxSeconds: runnerConfig.audioTranscription.maxSeconds
};

const transcriptionService = createTranscriptionService({
  prisma,
  provider: transcriptionProvider,
  providers:
    Object.keys(tierProviders).length > 0 ? tierProviders : undefined,
  refiner: textRefinementService,
  refinementEnabled: refinementConfig.enabled,
  nearbyMessages: nearbyMessagesResolver,
  attachmentResolver: compositeAttachmentResolver,
  config: transcriptionServiceConfig,
  // #760: a finished transcript replaces the "[Voice note]" placeholder in
  // the thread's inbox/Today preview. THREAD_UPDATED bumps the version-gated
  // /data/inbox cache and nudges the dashboard over SSE.
  onTranscriptSelected: (messageId) => {
    void propagateTranscriptToThreadPreview(prisma, messageId)
      .then((result) => {
        if (result.updated && result.threadId) {
          eventBus.emit({ type: "THREAD_UPDATED", jobId: uuid(), threadId: result.threadId });
        }
      })
      .catch((error) => {
        console.warn(
          `[transcription] preview propagation failed for message ${messageId}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }
});

const imessageVoiceSnapshotService = createIMessageVoiceSnapshotService({
  enabled: () => runnerConfig.audioTranscription.enabled,
  loadAttachmentsJson: async (messageId) => {
    const row = await prisma.message.findUnique({
      where: { id: messageId },
      select: { attachmentsJson: true }
    });
    return row?.attachmentsJson ?? null;
  },
  openDatabase: () => new IMessageDb(runnerConfig.imessage.dbPath),
  existingSnapshotPath: (guid) => imessageVoiceSnapshotPath(guid),
  snapshot: (guid, sourcePath) => snapshotImessageVoice(guid, sourcePath),
  enqueue: (messageId, shouldContinue) =>
    transcriptionService.enqueueMessage(messageId, shouldContinue)
});

const transcriptionSetup = createTranscriptionSetupManager({
  modelDir: runnerConfig.audioTranscription.transformers.modelDir,
  downloadScript: resolve(projectRoot, "scripts", "fetch-whisper-model.mjs"),
  initialEnabled: () => transcriptionServiceConfig.enabled,
  initialModelId: () => runnerConfig.audioTranscription.transformers.modelId,
  applyRuntime: (_mode, enabled, modelId) => {
    process.env.AUDIO_TRANSCRIPTION_ENABLED = String(enabled);
    process.env.AUDIO_TRANSCRIPTION_PROVIDER = "transformers";
    process.env.AUDIO_TRANSCRIPTION_LOCAL_MODEL = modelId;
    runnerConfig.audioTranscription.enabled = enabled;
    runnerConfig.audioTranscription.provider = "transformers";
    runnerConfig.audioTranscription.transformers.modelId = modelId;
    runnerConfig.audioTranscription.progressive.enabled = false;
    transcriptionServiceConfig.enabled = enabled;
  }
});

const scanQueue = createScanQueue({
  adapters,
  messageIdentityReconcilers: {
    INSTAGRAM: createInstagramMessageIdentityReconciler(prisma)
  },
  eventBus,
  settingsStore,
  aiService,
  platformMutex: operationMutex,
  personKey: defaultPersonKey,
  screenshotDir: runnerConfig.screenshotDir,
  domDumpDir: runnerConfig.domDumpDir,
  auditLog: (input) => auditService.log(input),
  recordLatency: (input) => messageSyncLatency.record(input),
  onNewPerson: (input) => enqueueEnrichmentForScan?.(input),
  // WhatsApp only scans while the operator has linked a device: an unlinked
  // scan would launch a headless whatsapp-web.js Puppeteer and park it on a
  // QR nobody sees. WHATSAPP_ENABLED stays the master switch. A skip here is
  // not a failure — no platform-row status or lastError is written. Rule
  // extracted to a pure helper so it's unit-tested (whatsapp/scannable.ts).
  isPlatformScannable: (platform) =>
    platform !== "WHATSAPP" ||
    isWhatsAppScannable({
      enabled: runnerConfig.whatsapp.enabled,
      state: whatsappConnect.state
    }),
  isPlatformSelectedForNewWork: (platform) =>
    platformSelectionAllowsNewWork(platform),
  onAudioMessage: (input) => {
    void imessageVoiceSnapshotService.handle(
      input.messageId,
      async () => {
        if (
          !input.shouldContinue() ||
          !platformSelectionAllowsNewWork(input.platform)
        ) return false;
        const settings = await settingsStore.getSettings();
        return (
          input.shouldContinue() &&
          platformSelectionAllowsNewWork(input.platform) &&
          settings.enabledPlatforms.includes(input.platform)
        );
      },
      input.platform === "IMESSAGE" && runnerConfig.imessage.enabled,
      () =>
        input.shouldContinue() &&
        platformSelectionAllowsNewWork(input.platform)
    );
  }
}) as ScanQueueWithSmokeIngest;

// Late-bind the initial-scan kick now that the scan queue exists (the
// WhatsApp state-change hook above was wired before this point).
enqueueWhatsAppInitialScan = () => {
  void settingsStore.getSettings().then((settings) => {
    if (!settings.enabledPlatforms.includes("WHATSAPP")) return;
    const result = scanQueue.enqueueScan("WHATSAPP", {
      respectCooldown: true,
      coalesceWithPending: true
    });
    void auditService.log({
      platform: "WHATSAPP",
      stage: "Scan",
      action: "WHATSAPP_CONNECT_INITIAL_SCAN",
      status: result.ok ? "OK" : "FAIL",
      details: result.ok
        ? { jobId: result.jobId, status: result.status }
        : { blocked: result.blocked, blockReason: result.reason }
    });
  });
};

const whatsappChangeTriggeredScan = createChangeTriggeredScan({
  platform: "WHATSAPP",
  debounceMs: 750,
  enqueue: (signal) => {
    if (whatsappConnect.state !== "connected") return { ok: true };
    const result = scanQueue.enqueueScan("WHATSAPP", {
      respectCooldown: true,
      coalesceWithPending: true,
      platformThreadId: signal.platformThreadId,
      trigger: {
        kind: "platform_event",
        sourceChangedAt: signal.sourceChangedAt,
        reason: signal.reason
      }
    });
    void auditService.log({
      platform: "WHATSAPP",
      stage: "Scan",
      action: "WHATSAPP_MESSAGE_WATCH_TRIGGER",
      status: result.ok ? "OK" : "FAIL",
      details: result.ok
        ? { jobId: result.jobId, status: result.status }
        : { blocked: result.blocked, blockReason: result.reason }
    });
    return result;
  },
  log: (line) => console.log(line)
});
onWhatsAppMessageArrived = (input) => {
  void settingsStore.getSettings().then((settings) => {
    if (!settings.enabledPlatforms.includes("WHATSAPP")) return;
    whatsappChangeTriggeredScan.notify({
      reason: "message",
      sourceChangedAt: input.sourceChangedAt,
      platformThreadId: input.platformThreadId
    });
  });
};

const imessageChangeTriggeredScan = createChangeTriggeredScan({
  platform: "IMESSAGE",
  debounceMs: 25,
  enqueue: (signal) =>
    scanQueue.enqueueScan("IMESSAGE", {
      respectCooldown: true,
      coalesceWithPending: true,
      trigger: {
        kind: "filesystem",
        sourceChangedAt: signal.sourceChangedAt,
        reason: signal.reason
      }
    }),
  log: (line) => console.log(line)
});

const linkedinChangeTriggeredScan = createChangeTriggeredScan({
  platform: "LINKEDIN",
  debounceMs: 500,
  enqueue: (signal) =>
    scanQueue.enqueueScan("LINKEDIN", {
      respectCooldown: true,
      coalesceWithPending: true,
      trigger: {
        kind: "browser_change",
        sourceChangedAt: signal.sourceChangedAt,
        reason: signal.reason
      }
    }),
  log: (line) => console.log(line)
});
onLinkedInInboxChanged = ({ reason, sourceChangedAt }) => {
  if (scanQueue.isScanning() && scanQueue.getCurrentScanPlatform() === "LINKEDIN") return;
  void settingsStore.getSettings().then((settings) => {
    if (!settings.enabledPlatforms.includes("LINKEDIN")) return;
    linkedinChangeTriggeredScan.notify({
      reason,
      sourceChangedAt
    });
  });
};

function startLinkedInRealtimeWatcher(): void {
  const realtimeAdapter = adapters.LINKEDIN as
    | (PlatformAdapter & {
        startInboxRealtimeWatcher?: (input: {
          debounceMs: number;
          onChange: (change: { reason: string; sourceChangedAt: string }) => void;
          log?: (line: string) => void;
        }) => { stop(): void };
      })
    | undefined;
  realtimeAdapter?.startInboxRealtimeWatcher?.({
    debounceMs: 300,
    onChange: (change) => onLinkedInInboxChanged?.(change),
    log: (line) => console.log(line)
  });
}

// Boot-time WhatsApp resume. The connect state machine lives in memory, so a
// runner restart forgets a linked session even though whatsapp-web.js's
// LocalAuth persists on disk. Re-initialise the client when the operator has
// EITHER a persisted on-disk session OR a platforms row with connectedAt —
// both mean "this operator uses WhatsApp". The disk session is the older
// ground truth and covers the migration case (linked before this wiring, so
// no platforms row exists yet). On resume LocalAuth restores without a QR and
// the "ready" event marks the row CONNECTED and kicks the initial scan. If the
// phone unlinked us meanwhile, the client emits "qr" and the row flips
// NOT_CONNECTED via the qr_ready sync, surfacing the reconnect path. Never
// runs for operators who never linked — no surprise Puppeteer.
if (runnerConfig.whatsapp.enabled && adapters.WHATSAPP) {
  void (async () => {
    const settings = await settingsStore.getSettings();
    if (!settings.enabledPlatforms.includes("WHATSAPP")) {
      return;
    }
    const row = await prisma.platform.findUnique({ where: { name: "WHATSAPP" } });
    const shouldResume =
      Boolean(row?.connectedAt) ||
      hasPersistedWhatsAppSession(runnerConfig.profileDirs.WHATSAPP);
    if (!shouldResume) {
      return;
    }
    whatsappConnect.state = "connecting";
    whatsappConnect.updatedAt = new Date().toISOString();
    await adapters.WHATSAPP!.ensureConnected();
  })().catch((error) => {
    console.warn(
      `[whatsapp] boot resume failed: ${error instanceof Error ? error.message : String(error)}`
    );
    whatsappConnect.state = "disconnected";
    whatsappConnect.updatedAt = new Date().toISOString();
  });
}

const sendService = createSendService({
  adapters,
  eventBus,
  settingsStore,
  auditLog: (input) => auditService.log(input),
  onPlatformResult: (input) => messageSyncLatency.finishSend(input),
  // Same per-platform mutex key the scan queue uses, so a send and a scan
  // never drive the shared managed page at the same time.
  withPlatformLock: withPlatformControlLock,
  withExternalActionLock,
  assertPlatformSelected: assertPlatformSelectedForExternalAction
});
registerUserTriggeredIntentForRequest = (threadId) =>
  sendService.registerDurableUserTriggeredIntent(threadId);
registerFocusPolicyMutationForRequest = () =>
  sendService.registerFocusPolicyMutationIntent();
const pollSendService = createPollSendService({
  prisma,
  settingsStore,
  auditLog: (input) => auditService.log(input),
  eventBus,
  withExternalActionLock,
  withPlatformLock: withPlatformControlLock
});
async function projectDurableExternalAction(row: DurableExternalActionProjection): Promise<void> {
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  if (row.actionType === "poll_vote") {
    if (
      !Array.isArray(payload.selectedOptions) ||
      payload.selectedOptions.some((option) => typeof option !== "string")
    ) {
      throw new Error("poll vote reconciliation payload is invalid");
    }
    return;
  }
  const message = await prisma.message.findUnique({ where: { id: row.targetMessageId } });
  if (!message || message.threadId !== row.threadId) {
    throw new Error("message missing during external-action reconciliation");
  }
  if (row.actionType === "message_reaction") {
    if (typeof payload.emoji !== "string" || !payload.emoji) {
      throw new Error("reaction reconciliation payload is invalid");
    }
    await prisma.message.update({
      where: { id: message.id },
      data: { rawJson: appendOutboundReaction(message.rawJson, payload.emoji) }
    });
    return;
  }
  if (row.actionType === "message_edit") {
    if (typeof payload.text !== "string" || !payload.text) {
      throw new Error("edit reconciliation payload is invalid");
    }
    await prisma.message.update({
      where: { id: message.id },
      data: { text: payload.text }
    });
    return;
  }
  throw new Error(`unsupported durable external action: ${row.actionType}`);
}

const durableExternalActionService = createDurableExternalActionService({
  prisma,
  project: projectDurableExternalAction,
  withExternalActionLock,
  withPlatformLock: withPlatformControlLock
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
const focusAutoAck = createFocusAutoAckService({
  settingsStore,
  sendQueue,
  auditLog: (input) => auditService.log(input),
  loadSendRequest: (clientSendId) =>
    prisma.sendRequest.findUnique({
      where: { clientSendId },
      select: { threadId: true, source: true, status: true }
    }),
  loadThread: async (threadId) => {
    const [thread, latestInbound, latestOutbound] = await Promise.all([
      prisma.thread.findUnique({
        where: { id: threadId },
        select: {
          id: true,
          platform: true,
          isGroup: true,
          category: true,
          person: {
            select: {
              id: true,
              displayName: true,
              birthday: true,
              favouritedAt: true
            }
          }
        }
      }),
      prisma.message.findFirst({
        where: { threadId, direction: "IN" },
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        select: { timestamp: true }
      }),
      prisma.message.findFirst({
        where: { threadId, direction: "OUT" },
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        select: { timestamp: true }
      })
    ]);
    if (!thread) return null;
    return {
      threadId: thread.id,
      platform: thread.platform,
      isGroup: thread.isGroup,
      category:
        thread.category === "genuine"
          ? "genuine"
          : thread.category === "outreach"
            ? "outreach"
            : null,
      person: thread.person,
      latestInboundAt: latestInbound?.timestamp ?? null,
      latestOutboundAt: latestOutbound?.timestamp ?? null
    };
  }
});
bindFocusAutoAckEvents(eventBus, focusAutoAck);
// Pick up any SendRequests left in PENDING from a previous runner process
// (e.g. crashed mid-send, or restarted while a send was queued behind a
// scan). The queue's `running` guard prevents duplicate processing.
sendQueue.resume();
void pollSendService.reconcileSentProjections().catch((error) => {
  console.warn(
    `[poll-send] startup reconciliation failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
});
void durableExternalActionService.reconcileSentProjections().catch((error) => {
  console.warn(
    `[external-action] startup reconciliation failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
});

// Immediate reassess when the operator sends a reply. The scan loop only
// refreshes a thread's brief when its lastInboundHash changes, so a dashboard
// send (which flips needsReply but adds no inbound) would otherwise leave the
// right rail showing the points the operator JUST answered as still
// outstanding until the next scan happens to run. Subscribe to MESSAGE_SENT,
// recompute the brief right away, then emit THREAD_UPDATED so the dashboard
// refetches /data/thread. Inbound stays scan-driven (the scan reassesses
// inline on detection; there is no push channel for iMessage / LinkedIn).
// Per-thread dedupe, a hard timeout, and non-blocking failure handling live
// in the handler module so this stays a thin wiring line.
const reassessOnSend = createReassessOnSendHandler({
  resummarize: (threadId) => resummarizeThreadById(threadId),
  onReassessed: (threadId) =>
    eventBus.emit({ type: "THREAD_UPDATED", jobId: uuid(), threadId }),
  onError: (threadId, error) =>
    console.warn(
      `[ai] reassess-on-send failed for threadId=${threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
});
eventBus.subscribe((event) => reassessOnSend.handle(event));

// Promotes SCHEDULED SendRequests to PENDING when their scheduledFor
// timestamp has elapsed, then kicks the send-queue worker. Runs every
// 30s — coarse enough to be cheap, fine enough that "send in 5 minutes"
// fires within ~30s of the target time.
const scheduledSendPromoter = createScheduledSendPromoter({
  sendQueue,
  eventBus
});
scheduledSendPromoter.start();

// Calendar auto-focus (issue #786): while the operator has a calendar
// subscription enabled, open a Focus window on its own whenever a live event
// is happening and close it when the event ends. Runs every 60s; the feed is
// cached between network fetches. No-op until a URL is saved and enabled.
const calendarFocusService = createCalendarFocusService({
  settingsStore,
  phraseEvent: async ({ activity, operatorProfile }) => {
    const rows = await prisma.message.findMany({
      where: { direction: "OUT" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: 200,
      select: { text: true, direction: true, sentVia: true }
    });
    const composed = await aiService.composeFocusNote({
      activity,
      operatorProfile,
      voiceSampleTexts: selectStyleSampleTexts(rows, 8)
    });
    return composed ? { close: composed.close, professional: composed.professional } : null;
  }
});
calendarFocusService.start();

// Syncs contact birthdays from the macOS AddressBook into Person rows once
// at boot and then daily. Mac-only and read-only against Contacts; a no-op
// when Contacts data is unreadable. Feeds the dashboard's birthday surfaces.
const birthdaySync: BirthdaySync | null =
  runnerConfig.contacts.birthdaySyncEnabled && runnerConfig.platformAvailability.IMESSAGE
    ? createBirthdaySync()
    : null;

// Rewrites existing iMessage rows whose name is still a raw phone/email handle
// to the real contact name (live macOS Contacts + optional vCard), once at
// boot and then daily. Repairs threads imported before a contact source was
// wired in so a pilot stops seeing bare numbers (issue #676). Mac-only;
// idempotent (steady-state ticks write nothing). Also feeds the dashboard's
// "this Mac has no saved contacts" hint via getHealth().
let imessageNameSync: ImessageNameSync | null = null;
if (runnerConfig.platformAvailability.IMESSAGE) {
  imessageNameSync = createImessageNameSync();
}

let imessageWatcher: IMessageWatcher | null = null;

async function probeIMessageConnection(): Promise<void> {
  try {
    const probe = new IMessageDb(runnerConfig.imessage.dbPath);
    probe.close();
    await prisma.platform.upsert({
      where: { name: "IMESSAGE" },
      update: { status: "CONNECTED", lastError: null },
      create: { name: "IMESSAGE", status: "CONNECTED" }
    });
  } catch (error) {
    await prisma.platform.upsert({
      where: { name: "IMESSAGE" },
      update: {
        status: "NOT_CONNECTED",
        lastError: error instanceof Error ? error.message : "chat.db unreadable"
      },
      create: { name: "IMESSAGE", status: "NOT_CONNECTED" }
    });
  }
}

const imessageSelectionLifecycle = createIMessageSelectionLifecycle({
  probe: probeIMessageConnection,
  startBirthdaySync: () => birthdaySync?.start(),
  stopBirthdaySync: () => birthdaySync?.stop(),
  startNameSync: () => imessageNameSync?.start(),
  stopNameSync: () => imessageNameSync?.stop(),
  startWatcher: () => {
    imessageWatcher ??= createIMessageWatcher({
      dbPath: runnerConfig.imessage.dbPath,
      debounceMs: runnerConfig.imessage.watchDebounceMs,
      onChange: ({ reason, sourceChangedAt }) => {
        void settingsStore.getSettings().then((settings) => {
          if (!settings.enabledPlatforms.includes("IMESSAGE")) return;
          imessageChangeTriggeredScan.notify({ reason, sourceChangedAt });
          void auditService.log({
            platform: "IMESSAGE",
            stage: "Scan",
            action: "IMESSAGE_WATCH_TRIGGER",
            status: "OK",
            details: { reason, sourceChangedAt, status: "change_coalesced" }
          });
        });
      }
    });
    imessageWatcher.start();
  },
  stopWatcher: () => imessageWatcher?.stop()
});

async function reconcileIMessageSelection(selected: boolean): Promise<void> {
  if (!runnerConfig.imessage.enabled) return;
  await imessageSelectionLifecycle.reconcile(selected);
}

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
  },
  isPlatformSelected: async (platform) =>
    platformSelectionAllowsNewWork(platform) &&
    (await settingsStore.getSettings()).enabledPlatforms.includes(platform)
});
// Auto-enrichment is OFF by default. Visiting strangers' profiles
// to scrape their posts/headline/etc. is the highest-fingerprint
// activity in this app — it looks like profile enumeration, which
// is exactly what LinkedIn's anti-scraping models watch for.
// Reading your own DMs looks like normal inbox usage; bulk-visiting
// 40 strangers' profiles a day does not. We keep the manual
// enrichment paths (POST /control/person/:id/enrich, the bulk
// re-enrich admin endpoint) so the operator can opt into a single
// "research this person" action. Set ENRICH_AUTO_ENABLED=1 to turn
// the periodic + on-scan auto-enrichment back on.
const autoEnrichmentEnabled = runnerConfig.platformAvailability.LINKEDIN && (
  (process.env.ENRICH_AUTO_ENABLED ?? "").toLowerCase() === "1"
  || (process.env.ENRICH_AUTO_ENABLED ?? "").toLowerCase() === "true"
);
enqueueEnrichmentForScan = (input) => {
  if (!autoEnrichmentEnabled) return;
  void enrichmentQueue.enqueue(input.personId, input.trigger);
};
if (autoEnrichmentEnabled) {
  enrichmentQueue.start();
} else {
  console.warn(
    "[enrichment-queue] auto-enrichment disabled (ENRICH_AUTO_ENABLED unset). " +
      "Manual triggers via /control/person/:id/enrich still work."
  );
}

async function withPlatformControlLockUnchecked<T>(
  platform: PlatformName,
  work: () => Promise<T>
): Promise<T> {
  return operationMutex.runExclusive(platformLockKey(platform), work);
}

async function withPlatformControlLock<T>(platform: PlatformName, work: () => Promise<T>): Promise<T> {
  if (!platformSelectionAllowsNewWork(platform)) {
    throw new PlatformNotSelectedError(platform);
  }
  return withPlatformControlLockUnchecked(platform, async () => {
    if (!platformSelectionAllowsNewWork(platform)) {
      throw new PlatformNotSelectedError(platform);
    }
    const settings = await settingsStore.getSettings();
    if (!settings.enabledPlatforms.includes(platform)) {
      throw new PlatformNotSelectedError(platform);
    }
    return work();
  });
}

async function withExternalActionLock<T>(
  platform: PlatformName,
  work: () => Promise<T>
): Promise<T> {
  return operationMutex.runExclusive(sendLockKeyFor(platform), work);
}

async function withGlobalResetLock<T>(work: () => Promise<T>): Promise<T> {
  return operationMutex.runExclusive(globalResetLockKey(), work);
}

async function assertPlatformSelectedForExternalAction(
  platform: PlatformName
): Promise<void> {
  if (!platformSelectionAllowsNewWork(platform)) {
    throw new PlatformNotSelectedError(platform);
  }
  const settings = await settingsStore.getSettings();
  if (
    !platformSelectionAllowsNewWork(platform) ||
    !settings.enabledPlatforms.includes(platform)
  ) {
    throw new PlatformNotSelectedError(platform);
  }
}

async function withWhatsAppSessionLocks<T>(
  work: () => Promise<T>
): Promise<T> {
  return withExternalActionLock("WHATSAPP", () =>
    withPlatformControlLockUnchecked("WHATSAPP", work)
  );
}

const platformSelectionCoordinator = createPlatformSelectionCoordinator({
  platforms: allPlatforms,
  getEnabledPlatforms: async () => (await settingsStore.getSettings()).enabledPlatforms,
  requestAbort: (reason) => scanQueue.requestAbort(reason),
  withGlobalResetLock,
  withPlatformLocks: (platform, work) =>
    withExternalActionLock(platform, () => withPlatformControlLockUnchecked(platform, work))
});
platformSelectionAllowsNewWork = (platform) =>
  platformSelectionCoordinator.isPlatformSelectedForNewWork(platform);

const managedSessionPlatforms: PlatformName[] = [
  "LINKEDIN",
  "INSTAGRAM",
  "TIKTOK",
  "GOOGLE_MESSAGES",
  "WHATSAPP"
];

async function reconcilePlatformSelection(): Promise<void> {
  const selectedPlatforms = await settingsStore.getSettings()
    .then((settings) => settings.enabledPlatforms);
  await reconcileIMessageSelection(selectedPlatforms.includes("IMESSAGE"));
  await reconcileSelectedPlatformLifecycle({
    getEnabledPlatforms: async () => (await settingsStore.getSettings()).enabledPlatforms,
    getCurrentScanPlatform: () => scanQueue.getCurrentScanPlatform(),
    requestAbort: (reason) => scanQueue.requestAbort(reason),
    managedPlatforms: managedSessionPlatforms.filter((platform) => Boolean(adapters[platform])),
    withPlatformLocks: (platform, work) =>
      withExternalActionLock(platform, () => withPlatformControlLockUnchecked(platform, work)),
    closeSession: async (platform) => {
      await adapters[platform]?.closeSession("disabled_by_settings");
      if (platform === "WHATSAPP") {
        whatsappConnect.state = "disconnected";
        whatsappConnect.updatedAt = new Date().toISOString();
      }
    }
  });
}

function schedulePlatformSelectionReconciliation(): void {
  void reconcilePlatformSelection().catch((error) => {
    console.warn(
      `[platform-selection] could not apply platform selection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
}

function abortCurrentScanIfDeselected(selectedPlatforms: readonly PlatformName[]): void {
  const activePlatform = scanQueue.getCurrentScanPlatform();
  if (activePlatform && !selectedPlatforms.includes(activePlatform)) {
    scanQueue.requestAbort("platform_deselected");
  }
}

const demoCleanupCoordinator = createDemoCleanupCoordinator({
  resolvePlatforms: async (threadIds) => {
    if (threadIds.length === 0) return [];
    const rows = await prisma.thread.findMany({
      where: { id: { in: [...threadIds] } },
      select: { platform: true }
    });
    return rows.map((row) => row.platform as PlatformName);
  },
  withGlobalResetLock,
  withExternalActionLock
});

async function cleanupDemoManifest(
  manifest: DemoSeedManifest,
  afterCleanup: () => Promise<void> = async () => undefined
): Promise<void> {
  await demoCleanupCoordinator.run(manifest.threadIds, async () => {
    await cleanupDemoData(manifest, {
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir
    });
    await settingsStore.setDemoSeedManifest(null);
    await afterCleanup();
  });
}

function parsePlatform(value: unknown): PlatformName {
  const parsed = z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "GOOGLE_MESSAGES"]).parse(value);
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
  if (
    value !== "LINKEDIN" &&
    value !== "INSTAGRAM" &&
    value !== "TIKTOK" &&
    value !== "IMESSAGE" &&
    value !== "GOOGLE_MESSAGES"
  ) {
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
  if (path.startsWith("/platform/test-selectors")) {
    return "Scan";
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

function connectTimeoutMsForCurrentProfile(platform?: PlatformName): number {
  if (platform === "GOOGLE_MESSAGES") return 120_000;
  if (platform === "INSTAGRAM") return resolveConnectTimeoutMs("personal", process.env);
  return resolveConnectTimeoutMs(runnerConfig.browserProfile.mode, process.env);
}

function platformBrowserProfileDetails(platform: PlatformName, launchUserDataDir: string) {
  if (platform === "INSTAGRAM") {
    return {
      profileMode: "isolated" as const,
      fallbackBehavior: "error" as const,
      syncMode: null,
      sourceUserDataDir: null,
      launchUserDataDir,
      profileDirectory: null,
      profileName: "Instagram",
      profileResolutionStrategy: "dedicated_standard_chrome"
    };
  }

  return {
    profileMode: runnerConfig.browserProfile.mode,
    fallbackBehavior: runnerConfig.browserProfile.fallbackBehavior,
    syncMode: runnerConfig.browserProfile.personalProfileSyncMode,
    sourceUserDataDir: runnerConfig.browserProfile.personalChromeUserDataDir,
    launchUserDataDir,
    profileDirectory: runnerConfig.browserProfile.personalChromeProfileDirectory,
    profileName: runnerConfig.browserProfile.personalChromeProfileName,
    profileResolutionStrategy:
      runnerConfig.browserProfile.personalChromeProfileResolutionStrategy
  };
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
  await mkdir(resolvePlatformSession("INSTAGRAM").profileDir, { recursive: true });
}

interface ThreadActionTarget {
  threadId: string;
  platform: PlatformName;
  platformThreadId: string;
  threadUrl?: string;
  displayName: string;
  recipientVerificationLabel?: string;
  personId: string;
}

async function findThreadStub(threadId: string): Promise<ThreadActionTarget | null> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { person: true }
  });

  if (!thread) {
    return null;
  }
  if (!runnerConfig.availablePlatforms.includes(thread.platform as PlatformName)) {
    return null;
  }

  return {
    threadId: thread.id,
    platform: thread.platform as PlatformName,
    platformThreadId: thread.platformThreadId,
    threadUrl: thread.threadUrl ?? undefined,
    displayName: thread.person.displayName,
    recipientVerificationLabel: thread.recipientVerificationLabel ?? undefined,
    personId: thread.personId
  };
}

async function getThreadStub(threadId: string): Promise<ThreadActionTarget> {
  const target = await findThreadStub(threadId);
  if (!target) throw new Error("Thread not found");
  return target;
}

const threadExternalActionFence = createThreadExternalActionFence({
  discoverPlatform: async (threadId) => {
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { platform: true }
    });
    const platform = thread?.platform as PlatformName | undefined;
    return platform && runnerConfig.availablePlatforms.includes(platform) ? platform : null;
  },
  loadTarget: findThreadStub,
  withExternalActionLock,
  withPlatformLock: withPlatformControlLock
});

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

async function actionTargetThreadIds(threadId: string): Promise<string[]> {
  return resolveActionTargetThreadIds(prisma, threadId);
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

async function loadOverdueDigestRows(): Promise<OverdueDigestRowInput[]> {
  // Mirrors the projection used by /data/inbox so the digest's idea of
  // "overdue" stays in lockstep with what Today calls overdue (#360
  // amendment 2). loadVisibleThreadRows already hides archived rows and
  // thread-level snoozes; the digest service does the rest of the filtering.
  const [visibleRows, scheduledSends, riskSettings] = await Promise.all([
    loadVisibleThreadRows(),
    prisma.sendRequest.findMany({
      where: { status: "SCHEDULED" },
      select: { threadId: true, scheduledFor: true }
    }),
    settingsStore.getSettings()
  ]);
  const riskThresholds = { amberHours: riskSettings.amberHours, redHours: riskSettings.redHours };
  const counts = personThreadCounts(visibleRows);
  const scheduledByThread = new Map<string, Date>();
  for (const row of scheduledSends) {
    if (!row.scheduledFor) continue;
    const existing = scheduledByThread.get(row.threadId);
    if (!existing || row.scheduledFor.getTime() < existing.getTime()) {
      scheduledByThread.set(row.threadId, row.scheduledFor);
    }
  }
  return visibleRows.map((row) => {
    const count = counts.get(personThreadCountKey(row.source.platform, row.source.personId)) ?? 1;
    const shaped = toInboxRow(row, count, riskThresholds);
    const scheduledFor = scheduledByThread.get(shaped.id);
    return {
      threadId: shaped.id,
      personId: row.source.personId,
      personName: shaped.personName,
      riskLevel: shaped.riskLevel,
      needsReply: shaped.needsReply,
      lastInboundAt: shaped.lastInboundAt,
      lastMessageAt: shaped.lastMessageAt,
      lastMessageDirection: shaped.lastMessageDirection,
      preview: shaped.preview,
      whatTheyWant: shaped.whatTheyWant,
      archivedAt: shaped.archivedAt,
      snoozedUntil: shaped.snoozedUntil,
      scheduledSendAt: scheduledFor ? scheduledFor.toISOString() : null,
      closedStatus: shaped.closedStatus
    } satisfies OverdueDigestRowInput;
  });
}

// Shared Prisma projection for inbox-row shaping. Hoisted so the visible-row
// query and the canonical-sibling query below select the IDENTICAL field set —
// shapeThreadRows adopts AI fields from a canonical sibling, so any field it
// reads must be present on BOTH result sets or the two would silently drift.
const threadRowSelect = {
  id: true,
  platform: true,
  platformThreadId: true,
  threadUrl: true,
  personId: true,
  isGroup: true,
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
  closedStatus: true,
  closedStatusReason: true,
  reconnectScore: true,
  reconnectScoreReason: true,
  updatedAt: true,
  person: {
    select: {
      id: true,
      displayName: true,
      inferredName: true,
      platform: true,
      avatarUrl: true,
      birthday: true,
      birthYear: true,
      tagsJson: true,
      favouritedAt: true
    }
  },
  _count: {
    select: {
      messages: true
    }
  }
} satisfies Prisma.ThreadSelect;

async function loadVisibleThreadRows(options?: {
  /** When true, return ONLY archived threads. When false/undefined, return ONLY non-archived. */
  archived?: boolean;
}): Promise<ReturnType<typeof shapeThreadRows>> {
  const now = new Date();
  const threads = await prisma.thread.findMany({
    where: options?.archived
      ? {
          platform: { in: runnerConfig.availablePlatforms },
          archivedAt: { not: null }
        }
      : {
          platform: { in: runnerConfig.availablePlatforms },
          archivedAt: null,
          // Hide snoozed threads from active views until the timer expires.
          // The dashboard polls every 10s, so threads resurface naturally
          // within that window once snoozedUntil <= now.
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
        },
    select: threadRowSelect
  });

  // shapeThreadRows collapses an iMessage person's sibling handle-chats to one
  // row and sources its AI fields (whatTheyWant, summary, preview, …) from the
  // CANONICAL sibling — the most-recent-inbound one, which the thread endpoint
  // also resolves over ALL siblings. The `threads` query above is visibility-
  // filtered (active-only, or archived-only), so the live sibling can be absent
  // from it; load the person's FULL sibling set so the inbox picks canonical
  // over the same population the rail does and the two can't disagree (#499
  // follow-up). Only iMessage persons need this; other platforms are 1:1.
  const imessagePersonIds = [
    ...new Set(
      threads
        .filter((thread) => thread.platform === "IMESSAGE")
        .map((thread) => thread.personId)
    )
  ];
  const canonicalSiblings =
    imessagePersonIds.length > 0
      ? await prisma.thread.findMany({
          where: { platform: "IMESSAGE", personId: { in: imessagePersonIds } },
          select: threadRowSelect
        })
      : [];

  return shapeThreadRows(threads as ThreadRowSource[], canonicalSiblings as ThreadRowSource[]);
}

const adminResetCoordinator = createAdminResetCoordinator({
  platforms: allPlatforms,
  requestAbort: (reason) => scanQueue.requestAbort(reason),
  clearAbort: () => scanQueue.clearAbort(),
  clearInFlight: () => {
    connectInFlight.clear();
    suggestedRepliesInFlight.clear();
    threadSummaryRefreshInFlight.clear();
  },
  withGlobalResetLock,
  withExternalActionLock,
  withPlatformLock: withPlatformControlLockUnchecked,
  resetGraph: (platform) => resetPlatformInboxGraph(platform),
  auditLog: (input) => auditService.log(input)
});

app.post("/admin/reset", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "WHATSAPP", "GOOGLE_MESSAGES"]).default("LINKEDIN"),
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
  const resetResult = await adminResetCoordinator.reset({
    platform: payload.platform,
    requestId
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
  // When auto-enrichment is disabled the queue is inert — nothing
  // drains it. Counting raw PENDING/RUNNING rows would surface stale
  // leftovers (and zombie RUNNING rows from a killed runner that
  // never got recovered, because recovery only runs inside start()).
  // That lit up "Enriching 13 profiles · 1 in flight" in the UI for
  // work that will never happen. Report the queue as empty when it
  // isn't running; the DB rows stay harmless and the queue's own
  // start() recovery picks them up if ENRICH_AUTO_ENABLED is set.
  const [platforms, enrichmentPending, enrichmentRunning] = await Promise.all([
    prisma.platform.findMany({ where: { name: { in: runnerConfig.availablePlatforms } } }),
    autoEnrichmentEnabled
      ? prisma.enrichmentJob.count({
          where: {
            status: "PENDING",
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
          }
        })
      : Promise.resolve(0),
    autoEnrichmentEnabled
      ? prisma.enrichmentJob.count({ where: { status: "RUNNING" } })
      : Promise.resolve(0)
  ]);
  const lastScanAt = platforms
    .map((platform) => platform.lastScanAt)
    .filter(Boolean)
    .sort((a, b) => (a!.getTime() > b!.getTime() ? -1 : 1))[0];

  const runnerStatus = scanQueue.isScanning() ? "SCANNING" : "ONLINE";
  const connectedPlatforms = connectedPlatformCount(
    runnerConfig.availablePlatforms,
    platforms,
    whatsappConnect.state
  );

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
      // #338/#362: scope + openedRows so the dashboard TopStatus can
      // tell an "update" (incremental) scan apart from a "full" sweep.
      // Update-mode copy uses "checked" + "updated" (openedRows is the
      // count of threads we actually opened — i.e. rows that had new
      // content worth a look). Full-mode keeps the X/total denominator.
      scope: snap.scope,
      processedRows: snap.processedRows,
      openedRows: snap.openedRows,
      total,
      percent,
      etaSeconds
    };
  })();

  res.json({
    application: "relationship-inbox-os",
    runnerStatus,
    lastScanAt: lastScanAt?.toISOString() ?? null,
    queueDepth: scanQueue.getQueueDepth(),
    connectedPlatforms,
    availablePlatforms: runnerConfig.availablePlatforms,
    // Host machine identity for phone Settings and App updates.
    // Resolved once in services/host-device so hostname/ComputerName logic is
    // not duplicated across /health and /system/version / update-check.
    hostDevice: (() => {
      const host = resolveHostDeviceInfo();
      return {
        hostname: host.hostname,
        platform: host.platform,
        label: host.label,
        kind: host.kind
      };
    })(),
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

  // Prefer the live `Last-Event-ID` header over the mount-time `sinceEventId`
  // query param: on the browser's native auto-reconnect both arrive, but the
  // query param is frozen at AppShell mount while the header reflects the last
  // event actually delivered. Letting the stale param win replayed the whole
  // buffered window on every reconnect (see resolveSseResumeCursor).
  const sinceEventId = resolveSseResumeCursor(req.query.sinceEventId, req.header("last-event-id"));
  const oldest = eventBus.oldestEventId();

  // Immediate comment frame: EventSource fires `open` only once response
  // bytes arrive, and the dashboard's /events-proxy (and `next start`'s
  // streaming layer) forwards headers only with the first body byte. With a
  // quiet runner the first byte used to be the 15s keepalive, so a freshly
  // opened app could sit "connecting" for up to 15s. A comment frame is
  // ignored by EventSource but opens the pipe instantly.
  res.write(": connected\n\n");

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
    streamFileToResponse(resolved, res, 404);
  } catch {
    res.status(400).json({ error: "Invalid artifact name" });
  }
});

app.post("/control/imessage/permission-help", asyncRoute(async (_req, res) => {
  if (process.platform !== "darwin") {
    res.status(400).json({ error: "macOS only" });
    return;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const ranSteps: string[] = [];
  try {
    await run("osascript", ["-e", 'tell application "Messages" to count of services'], { timeout: 8_000 });
    ranSteps.push("messages_probe_ok");
  } catch (error) {
    ranSteps.push(`messages_probe_denied:${((error as Error).message ?? "").slice(0, 80)}`);
  }
  try {
    await run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], { timeout: 5_000 });
    ranSteps.push("settings_opened");
  } catch {
    ranSteps.push("settings_open_failed");
  }
  const requester = process.env.RIOS_DESKTOP === "1" ? resolveAppName() : "your terminal app";
  res.json({
    ok: true,
    steps: ranSteps,
    message: `In Automation, turn on Messages under ${requester}, return to the app, then retry. For file attachments, also turn on ${requester} in Accessibility. No permissions were reset.`
  });
}));

app.post("/control/imessage/full-disk-access", asyncRoute(async (_req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "open Full Disk Access", kind: "external-action" })) return;
  if (process.platform !== "darwin") {
    res.status(400).json({ error: "macOS only", runnerProcess: runnerProcessInfo });
    return;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    await run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], { timeout: 5_000 });
  } catch {
    res.status(500).json({
      error: "Could not open Full Disk Access settings.",
      runnerProcess: runnerProcessInfo
    });
    return;
  }
  res.json({
    ok: true,
    runnerProcess: runnerProcessInfo,
    message: `Opened Full Disk Access. Enable ${runnerProcessInfo.executableName}, then quit and restart the app.`
  });
}));

// One-shot historical iMessage backfill. The recurring scan is
// deliberately scoped to unread + the ~30 most-recent threads for
// efficiency, so dormant conversations (e.g. someone you stopped
// texting months ago) never enter the DB. This walks chat.db for every
// NON-automated conversation with activity inside the window and pushes
// each through the same idempotent syncThreadForIngest path the scanner
// uses — so it dedupes against already-ingested rows (safe to re-run)
// and does NOT trigger AI enrichment (that stays gated as today).
// `dryRun` reports what would be ingested without writing.
app.post("/control/imessage/import-history", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      sinceDays: z.number().int().min(1).max(4000).optional(),
      dryRun: z.boolean().optional()
    })
    .parse(req.body ?? {});
  const sinceDays = payload.sinceDays ?? 365;
  const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  try {
    const result = await platformSelectionCoordinator.withSelectedPlatform("IMESSAGE", async () => {
      let db: IMessageDb;
      try {
        db = new IMessageDb(runnerConfig.imessage.dbPath);
      } catch {
        return {
          statusCode: 503,
          body: { error: "cannot open chat.db (Full Disk Access?)" }
        };
      }
      let rows: ReturnType<IMessageDb["listThreads"]>;
      try {
        rows = db.listThreads(5000, { unreadOnly: false });
      } finally {
        db.close();
      }
      const candidates = rows.filter(
        (row) => row.lastMessageAt !== undefined && Date.parse(row.lastMessageAt) >= cutoffMs
      );
      const resolver = loadBestContactResolver({
        vcfPath: runnerConfig.imessage.contactsVcfPath
      });
      const resolveName = (row: (typeof rows)[number]): string => {
        if (row.userSetName) return row.userSetName;
        if (row.isGroup) return row.displayName;
        return resolver.resolve(row.chatIdentifier) ?? row.displayName;
      };
      if (payload.dryRun) {
        return {
          statusCode: 200,
          body: {
            ok: true,
            dryRun: true,
            sinceDays,
            totalNonAutomatedChats: rows.length,
            wouldIngest: candidates.length,
            sample: candidates.slice(0, 8).map((candidate) => resolveName(candidate))
          }
        };
      }

      const requestId = uuid();
      const startedAt = Date.now();
      const summary = {
        threadsIngested: 0,
        messagesParsed: 0,
        updatedThreads: 0,
        threadFailures: 0
      };
      const shouldContinue = scanQueue.createContinueGate();
      let index = 0;
      for (const r of candidates) {
        if (!shouldContinue()) break;
        index += 1;
        const candidate: ThreadStub = {
          platformThreadId: r.guid,
          displayName: resolveName(r),
          lastMessagePreview: r.lastMessagePreview ?? "",
          lastMessageAt: r.lastMessageAt,
          ...groupStubFields(r)
        };
        try {
          // High maxMessages so a full year of even chatty threads is
          // pulled; chat.db reads are cheap and the upsert is idempotent.
          const partial = await scanQueue.syncThreadForIngest({
            platform: "IMESSAGE",
            candidate,
            maxMessages: 20000,
            requestId,
            // Raw historical ingest: no per-thread AI (enrichment is gated;
            // the recurring scanner does AI for active threads).
            skipAi: true,
            shouldContinue
          });
          summary.threadsIngested += 1;
          summary.updatedThreads += partial.updatedThreads ?? 0;
          summary.messagesParsed += partial.parsedMessages ?? 0;
        } catch (error) {
          summary.threadFailures += 1;
          console.warn(
            `[imessage-import] thread ${index}/${candidates.length} "${r.displayName}" failed (skipped): ${
              error instanceof Error ? error.message : String(error)
            }\n${error instanceof Error ? error.stack ?? "(no stack)" : ""}`
          );
        }
        if (index % 25 === 0 || index === candidates.length) {
          console.log(
            `[imessage-import] ${index}/${candidates.length} threads · ${summary.messagesParsed} msgs · ${summary.threadFailures} failed`
          );
        }
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          sinceDays,
          requestId,
          threadsConsidered: candidates.length,
          ...summary,
          durationMs: Date.now() - startedAt
        }
      };
    });
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    if (error instanceof PlatformNotSelectedError) {
      res.status(409).json({
        error: "iMessage is no longer selected in Settings.",
        reason: "platform_not_selected"
      });
      return;
    }
    throw error;
  }
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
  // Live chat.db metadata is authoritative (Apple's real mime type and
  // names); the snapshot's mime is only derived from its file extension.
  // Serve the live file while the row AND file survive, and fall back to
  // our snapshot once Apple's "Expire After 2 Minutes" has deleted them —
  // that's what keeps replay working after expiry.
  let live: ReturnType<IMessageDb["findAttachmentByGuid"]> | null = null;
  let dbOpenFailed = false;
  const settings = await settingsStore.getSettings();
  const selected =
    platformSelectionAllowsNewWork("IMESSAGE") &&
    settings.enabledPlatforms.includes("IMESSAGE");
  if (selected) {
    try {
      const db = new IMessageDb(runnerConfig.imessage.dbPath);
      try {
        live = db.findAttachmentByGuid(guid) ?? null;
      } finally {
        db.close();
      }
    } catch {
      dbOpenFailed = true;
    }
  }
  if (live?.absolutePath && existsSync(live.absolutePath)) {
    await streamIMessageAttachment({
      absolutePath: live.absolutePath,
      mimeType: live.mimeType,
      transferName: live.transferName,
      filename: live.filename,
      res
    });
    return;
  }
  const snapshot = imessageVoiceSnapshotMeta(guid);
  if (snapshot) {
    // The row can outlive the file (expiry deletes the file first): keep
    // chat.db's mime/names over the extension-derived ones.
    await streamIMessageAttachment({
      absolutePath: snapshot.absolutePath,
      mimeType: live?.mimeType ?? snapshot.mimeType,
      transferName: live?.transferName ?? snapshot.transferName,
      filename: live?.filename ?? snapshot.filename,
      res
    });
    return;
  }
  if (!selected) {
    res.status(409).json({
      error: "iMessage is not selected in Settings.",
      reason: "platform_not_selected"
    });
    return;
  }
  if (dbOpenFailed) {
    res.status(503).json({ error: "cannot open chat.db (Full Disk Access?)" });
    return;
  }
  if (!live) {
    res.status(404).json({ error: "attachment not found in chat.db" });
    return;
  }
  if (!live.absolutePath) {
    res.status(404).json({ error: "attachment file path unresolved" });
    return;
  }
  // Row exists, file gone, no snapshot: let the streamer report the missing
  // file exactly as it did before snapshots existed.
  await streamIMessageAttachment({
    absolutePath: live.absolutePath,
    mimeType: live.mimeType,
    transferName: live.transferName,
    filename: live.filename,
    res
  });
}));

app.get("/data/whatsapp-attachment/:guid", asyncRoute(async (req, res) => {
  const { guid } = z.object({ guid: z.string().min(1).max(220) }).parse(req.params);
  const media = await findWhatsAppMediaByGuid(guid, runnerConfig.whatsapp.mediaDir);
  if (!media) {
    res.status(404).json({ error: "whatsapp attachment not found" });
    return;
  }
  await streamWhatsAppMedia({ ...media, res });
}));

app.get("/data/google-messages-attachment/:guid", asyncRoute(async (req, res) => {
  const { guid } = z.object({
    guid: z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{1,9}$/i)
  }).parse(req.params);
  const absolutePath = ensurePathInside(runnerConfig.googleMessages.mediaDir, guid);
  if (!existsSync(absolutePath)) {
    res.status(404).json({ error: "Google Messages attachment not found" });
    return;
  }
  res.sendFile(absolutePath);
}));

// Stream a LinkedIn voice-message audio file to the dashboard. Mirror
// of /data/imessage-attachment but for the bytes captured by the
// LinkedIn adapter during scan (`captureLinkedInVoiceMessage`). The
// URN doubles as the lookup key — the resolver and the store agree on
// hashing the URN to derive the on-disk filename. 404s when the file
// hasn't been captured yet (e.g. the operator opened the dashboard
// before the deep-fetch scan picked the message up).
app.get("/data/linkedin-voice-message/:urn", asyncRoute(async (req, res) => {
  const rawUrn = req.params.urn;
  const urnParam = typeof rawUrn === "string" ? rawUrn : "";
  const { urn } = z
    .object({
      urn: z
        .string()
        .min(8)
        .max(400)
        // The voice guid is the message key the adapter persisted under:
        // a real `urn:li:` event urn, a `li-msg-fp:...` fingerprint for an
        // id-less bubble (the common case, ~120 chars), or the legacy
        // positional `li-msg-<index>`. All three are valid; only the
        // single canonical predicate decides membership.
        .refine(isLinkedInVoiceGuid, {
          message: "not a LinkedIn voice-message guid"
        })
    })
    .parse({ urn: decodeURIComponent(urnParam) });
  if (!hasLinkedInVoice(urn)) {
    res.status(404).json({ error: "linkedin voice message not yet captured" });
    return;
  }
  const path = linkedInVoicePath(urn);
  res.setHeader("Content-Type", LINKEDIN_VOICE_MIME);
  res.setHeader("Cache-Control", "private, max-age=3600");
  streamFileToResponse(path, res, 404);
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
    enabled: settings.aiEnabled !== false,
    activeProvider,
    activeModel,
    configuredProviders,
    activeProviderConfigured: configuredProviders.includes(activeProvider)
  });
}));

// First-run setup (#845): save a Gemini API key from the setup wizard.
// Validates the key live against Google before persisting, writes it into
// the .env the runner reads (atomic parse-and-update, other keys and
// comments preserved), then applies it to the live process so AI calls use
// it immediately — no restart. The key value is never logged.
app.post("/control/setup/ai-key", asyncRoute(async (req, res) => {
  const payload = z.object({
    key: z.unknown(),
    expectedRevision: z.number().int().nonnegative()
  }).parse(req.body);
  let result;
  try {
    result = await operationMutex.runExclusive("setup:gemini-key", async () => {
      const envWritePath = resolveEnvWritePath();
      const currentSettings = await settingsStore.getSettings();
      const recovery = recoverEnvFileValueTransaction(
        envWritePath,
        currentSettings.setupGeminiKeyTransactionId
      );
      if (recovery === "active") {
        throw new Error("The setup key is still being committed by another runner.");
      }
      discardStaleEnvFileStages(envWritePath);
      return applyGeminiKey(payload.key, {
        validate: (key) => validateGeminiKey(key, runnerConfig.geminiBaseUrl),
        stage: (key) => stageEnvFileValue(envWritePath, "GEMINI_API_KEY", key),
        commitState: (transactionId) =>
          aiConsentCoordinator.mutate(
            true,
            () => setupPreferencesCoordinator.enableAiProvider(
              "gemini",
              payload.expectedRevision,
              transactionId
            )
          ),
        applyRuntime: (key) => {
          process.env.GEMINI_API_KEY = key;
          runnerConfig.geminiApiKey = key;
        }
      });
    });
  } catch (error) {
    if (error instanceof SetupPreferencesConflictError) {
      res.status(409).json({
        error: "Setup changed in another window. Review the latest choices and try again.",
        preferences: error.current
      });
      return;
    }
    throw error;
  }
  if (!result.ok) {
    res.status(result.status).json({
      error: result.message,
      ...(result.state ? { preferences: result.state } : {})
    });
    return;
  }
  res.json({ ok: true, provider: "gemini", preferences: result.state });
}));

app.get("/data/setup/status", asyncRoute(async (_req, res) => {
  const [preferences, settings, platformRows, operatorProfile] = await Promise.all([
    getSetupPreferences(),
    settingsStore.getSettings(),
    prisma.platform.findMany({
      where: { name: { in: runnerConfig.availablePlatforms } },
      select: { name: true, status: true, connectedAt: true, lastError: true }
    }),
    settingsStore.getOperatorProfile()
  ]);
  const platforms = runnerConfig.availablePlatforms.map((platform) => {
    const row = platformRows.find((entry) => entry.name === platform);
    return {
      name: platform,
      status: effectivePlatformStatus(platform, row?.status, whatsappConnect.state),
      connectedAt: row?.connectedAt ?? null,
      lastError: row?.lastError ?? null
    };
  });
  const available = new Set(platforms.map((platform) => platform.name));
  res.json({
    preferences: {
      ...preferences,
      selectedPlatforms: settings.enabledPlatforms.filter((platform) => available.has(platform)),
      aiEnabled: settings.aiEnabled !== false
    },
    settings: {
      enabledPlatforms: settings.enabledPlatforms,
      aiEnabled: settings.aiEnabled !== false,
      automaticUpdates: settings.automaticUpdates
    },
    platforms,
    operatorProfile,
    transcription: transcriptionSetup.status(),
    contacts: imessageNameSync?.getHealth() ?? null,
    version: readAppVersion(projectRoot).version
  });
}));

app.post("/control/setup/preferences", asyncRoute(async (req, res) => {
  const completeFocusPolicyMutation = beginUserTriggeredIntentOperation(res);
  let selectionMutation: ReservedPlatformSelectionMutation | null = null;
  let aiMutation: ReservedAiConsentMutation | null = null;
  try {
    const request = parseSetupPreferencesRequest(req.body);
    if (request.kind === "complete") {
      const result = await setupPreferencesCoordinator.complete(request.payload);
      res.json({ ok: true, ...result });
      return;
    }
    selectionMutation = request.payload.selectedPlatforms
      ? platformSelectionCoordinator.reserveMutation(request.payload.selectedPlatforms)
      : null;
    aiMutation = request.payload.aiEnabled !== undefined
      ? aiConsentCoordinator.reserveMutation(request.payload.aiEnabled)
      : null;
    const persist = () => setupPreferencesCoordinator.update(request.payload);
    const persistWithSelection = () => selectionMutation
      ? selectionMutation.run(persist)
      : persist();
    const preferences = aiMutation
      ? await aiMutation.run(persistWithSelection)
      : await persistWithSelection();
    abortCurrentScanIfDeselected((await settingsStore.getSettings()).enabledPlatforms);
    schedulePlatformSelectionReconciliation();
    res.json({ ok: true, preferences });
  } catch (error) {
    await selectionMutation?.cancel();
    await aiMutation?.cancel();
    if (error instanceof SetupPreferencesConflictError) {
      res.status(409).json({
        error: "Setup changed in another window. Review the latest choices and try again.",
        preferences: error.current
      });
      return;
    }
    if (error instanceof PlatformSelectionSupersededError) {
      res.status(409).json({
        error: "Platform choices changed in another window. Review the latest choices and try again.",
        preferences: await getSetupPreferences()
      });
      return;
    }
    if (error instanceof AiConsentMutationSupersededError) {
      res.status(409).json({
        error: "AI choices changed in another window. Review the latest choice and try again.",
        preferences: await getSetupPreferences()
      });
      return;
    }
    throw error;
  } finally {
    completeFocusPolicyMutation();
  }
}));

app.post("/control/setup/complete", asyncRoute(async (req, res) => {
  const payload = z.object({
    completedAt: z.string().datetime(),
    expectedRevision: z.number().int().nonnegative().optional()
  }).parse(req.body);
  try {
    const result = await setupPreferencesCoordinator.complete(payload);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SetupPreferencesConflictError) {
      res.status(409).json({
        error: "Setup changed in another window. Review the latest choices and try again.",
        preferences: error.current
      });
      return;
    }
    throw error;
  }
}));

app.get("/data/setup/transcription", asyncRoute(async (_req, res) => {
  res.json(transcriptionSetup.status());
}));

app.post("/control/setup/transcription", asyncRoute(async (req, res) => {
  const payload = z.object({
    mode: z.enum(["off", "standard", "enhanced"]),
    removeDownloadedModels: z.boolean().optional()
  }).parse(req.body) as { mode: SetupTranscriptionMode; removeDownloadedModels?: boolean };
  try {
    const result = await applyPreparedTranscriptionSetup({
      manager: transcriptionSetup,
      mode: payload.mode,
      removeDownloadedModels: payload.removeDownloadedModels,
      persistPreferences: () => setupPreferencesCoordinator.update({
        transcriptionMode: payload.mode
      })
    });
    res.status(result.status.phase === "downloading" ? 202 : 200).json({
      ...result.status,
      preferences: result.preferences
    });
  } catch (error) {
    if (error instanceof TranscriptionSetupBusyError) {
      const preferences = await getSetupPreferences();
      res.status(409).json({
        ...error.status,
        error: error.message,
        preferences
      });
      return;
    }
    throw error;
  }
}));

// ---- System / self-update -------------------------------------------------
// Logic lives in services/system-update.ts (testable in isolation). The
// POST /system/update stages a pending intent for the start wrapper fallback,
// then launches a detached helper that applies the update and starts the app
// again after this runner and the dashboard shut down.

app.get("/system/version", asyncRoute(async (_req, res) => {
  const version = readAppVersion(projectRoot);
  const host = resolveHostDeviceInfo();
  res.json({
    ...version,
    hostDeviceLabel: host.label,
    hostDeviceKind: host.kind
  });
}));

app.get("/system/update-check", asyncRoute(async (_req, res) => {
  const packaged = process.env.RIOS_PACKAGED_APP === "1";
  const settings = await settingsStore.getSettings();
  const feedUrl = resolveUpdateFeedUrl(projectRoot, runnerConfig.updateFeedUrl);
  const host = resolveHostDeviceInfo();
  const hostFields = {
    hostDeviceLabel: host.label,
    hostDeviceKind: host.kind
  };
  if (!feedUrl) {
    const current = readAppVersion(projectRoot);
    res.json({
      configured: false,
      automaticUpdates: settings.automaticUpdates,
      currentVersion: current.version,
      currentReleaseNotes: current.releaseNotes ?? [],
      latestVersion: current.version,
      updateAvailable: false,
      releaseNotes: [],
      commit: current.commit,
      channel: current.channel,
      build: current.build,
      ...hostFields
    });
    return;
  }
  const result = await runUpdateCheck({ projectRoot, feedUrl });
  const current = readAppVersion(projectRoot);
  res.json({
    configured: true,
    automaticUpdates: settings.automaticUpdates,
    applyMode: packaged && (
      !canSelfUpdateInPlace(projectRoot, packaged) ||
      !process.env.RIOS_NATIVE_UPDATE_REQUEST?.trim()
    ) ? "replace_app" : "automatic",
    ...result,
    commit: current.commit,
    channel: current.channel,
    build: current.build,
    ...hostFields
  });
}));

type UpdateStartResult =
  | { status: "started"; fromVersion: string; toVersion: string; logPath: string }
  | { status: "already_starting" }
  | { status: "no_feed_configured" }
  | { status: "dev_checkout" }
  | { status: "check_failed"; error: string }
  | { status: "no_update_available"; currentVersion: string }
  | { status: "replace_app_required"; message: string };

let updateLaunchInProgress = false;
let updateStartInProgress = false;

async function checkAndStartAvailableUpdate(): Promise<UpdateStartResult> {
  const packaged = process.env.RIOS_PACKAGED_APP === "1";
  const nativeRequestPath = packaged ? process.env.RIOS_NATIVE_UPDATE_REQUEST?.trim() || "" : "";
  const feedUrl = resolveUpdateFeedUrl(projectRoot, runnerConfig.updateFeedUrl);
  if (!feedUrl) return { status: "no_feed_configured" };
  if (existsSync(join(projectRoot, ".git"))) {
    return { status: "dev_checkout" };
  }
  const check = await runUpdateCheck({ projectRoot, feedUrl });
  if (check.error) {
    return { status: "check_failed", error: check.error };
  }
  if (!check.updateAvailable) {
    return { status: "no_update_available", currentVersion: check.currentVersion };
  }
  if (packaged && (!canSelfUpdateInPlace(projectRoot, packaged) || !nativeRequestPath)) {
    return {
      status: "replace_app_required",
      message:
        `Quit ${resolveAppName()}, install the latest DMG by replacing the app in Applications, then reopen it. Remove the old ${LEGACY_APP_NAME} app if it is still in Applications. Your data and settings in Application Support are preserved.`
    };
  }
  const intent = {
    requestedAt: new Date().toISOString(),
    fromVersion: check.currentVersion,
    toVersion: check.latestVersion,
    feedUrl
  };
  if (nativeRequestPath) {
    requestNativeUpdate(nativeRequestPath, intent);
    updateLaunchInProgress = true;
    return {
      status: "started",
      fromVersion: intent.fromVersion,
      toVersion: intent.toVersion,
      logPath: nativeRequestPath
    };
  }
  stagePendingUpdate(dataDir, intent);
  const restart = launchUpdateApplyAndRestart({
    projectRoot,
    feedUrl
  });
  updateLaunchInProgress = true;
  return {
    status: "started",
    fromVersion: intent.fromVersion,
    toVersion: intent.toVersion,
    logPath: restart.logPath
  };
}

async function startAvailableUpdate(): Promise<UpdateStartResult> {
  if (updateLaunchInProgress && process.env.RIOS_PACKAGED_APP === "1") {
    const nativeRequestPath = process.env.RIOS_NATIVE_UPDATE_REQUEST?.trim() || "";
    if (nativeRequestPath && !existsSync(nativeRequestPath)) updateLaunchInProgress = false;
  }
  if (updateLaunchInProgress || updateStartInProgress) return { status: "already_starting" };
  updateStartInProgress = true;
  try {
    return await checkAndStartAvailableUpdate();
  } finally {
    updateStartInProgress = false;
  }
}

app.post("/system/update", asyncRoute(async (_req, res) => {
  // /system/update is NOT a /control/ path, so the dashboard's default-deny
  // fetch interceptor never sees it — the Settings app update button
  // would otherwise start a real self-update mid-presentation. Gate
  // it server-side as an external action (blocked live + sandbox).
  if (await checkPresenterGuard(res, settingsStore, { action: "update and restart the app", kind: "external-action" })) return;
  const result = await startAvailableUpdate();
  if (result.status === "started") {
    res.status(202).json({
      ok: true,
      updating: true,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      logPath: result.logPath,
      message: `Update started. ${resolveAppName()} will reopen when it finishes.`
    });
    return;
  }
  if (result.status === "check_failed") {
    res.status(502).json({ ok: false, reason: result.status, error: result.error });
    return;
  }
  if (result.status === "replace_app_required") {
    res.status(409).json({ ok: false, reason: result.status, message: result.message });
    return;
  }
  if (result.status === "dev_checkout") {
    res.status(409).json({
      ok: false,
      reason: result.status,
      message: "This checkout is updated with git, not the student updater."
    });
    return;
  }
  if (result.status === "no_update_available") {
    res.status(409).json({ ok: false, reason: result.status, currentVersion: result.currentVersion });
    return;
  }
  if (result.status === "already_starting") {
    res.status(202).json({ ok: true, updating: true, message: "The update is already starting." });
    return;
  }
  res.status(409).json({ ok: false, reason: result.status });
}));

const automaticUpdateScheduler = createAutomaticUpdateScheduler({
  async isEnabled() {
    const settings = await settingsStore.getSettings();
    return settings.automaticUpdates &&
      !settings.demoMode &&
      settings.presenterDemoMode !== "sandbox" &&
      settings.presenterDemoMode !== "live" &&
      !settings.presenterReadOnly;
  },
  async installIfAvailable() {
    const result = await startAvailableUpdate();
    if (result.status === "started") {
      console.log(`[system-update] automatic update ${result.fromVersion} -> ${result.toVersion} started`);
    } else if (result.status === "check_failed") {
      console.warn(`[system-update] automatic check failed: ${result.error}`);
    }
  },
  onError(error) {
    console.warn(
      `[system-update] automatic update failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

async function persistSettingsUpdate(
  update: Partial<AppSettings>,
  selectionMutation?: ReservedPlatformSelectionMutation,
  aiMutation?: ReservedAiConsentMutation
) {
  const persist = async () => {
    if (update.enabledPlatforms !== undefined || update.aiEnabled !== undefined) {
      await setupPreferencesCoordinator.updateFromSettings(update);
      return settingsStore.getSettings();
    }
    return settingsStore.updateSettings(update);
  };
  const persistWithSelection = () => selectionMutation
    ? selectionMutation.run(persist)
    : update.enabledPlatforms !== undefined
      ? platformSelectionCoordinator.mutate(update.enabledPlatforms, persist)
      : persist();
  return aiMutation
    ? aiMutation.run(persistWithSelection)
    : update.aiEnabled !== undefined
      ? aiConsentCoordinator.mutate(update.aiEnabled, persistWithSelection)
      : persistWithSelection();
}

app.post("/control/settings", asyncRoute(async (req, res) => {
  const completeFocusPolicyMutation = beginUserTriggeredIntentOperation(res);
  let selectionMutation: ReservedPlatformSelectionMutation | undefined;
  let aiMutation: ReservedAiConsentMutation | undefined;
  try {
  const quietHoursWindowSchema = z
    .object({
      start: z.string().regex(/^\d{1,2}:\d{2}$/),
      end: z.string().regex(/^\d{1,2}:\d{2}$/)
    })
    .optional();
  const payload = z
    .object({
      scanIntervalSeconds: z.number().int().min(10).max(3600).optional(),
      automaticUpdates: z.boolean().optional(),
      amberHours: z.number().int().min(1).max(72).optional(),
      redHours: z.number().int().min(1).max(168).optional(),
      headless: z.boolean().optional(),
      maxMessagesPerThread: z.number().int().min(5).max(100).optional(),
      enabledPlatforms: z.array(z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "WHATSAPP", "GOOGLE_MESSAGES"])).optional(),
      demoMode: z.boolean().optional(),
      presenterDemoMode: z.enum(["off", "sandbox", "live"]).optional(),
      presenterReadOnly: z.boolean().optional(),
      recentThreadSweepCount: z.number().int().min(5).max(100).optional(),
      aiEnabled: z.boolean().optional(),
      aiProvider: z.enum(["openai", "glm", "gemini"]).optional(),
      // Empty string from the dashboard is normalised to undefined client-side,
      // but accept either here defensively. Length cap matches typical model
      // ids while preventing accidental megabyte payloads.
      glmModel: z.string().max(100).optional(),
      geminiModel: z.string().max(100).optional(),
      // Shared host quiet hours: phone Settings and Mac AppShell scan path.
      quietHoursEnabled: z.boolean().optional(),
      quietHoursWindow: quietHoursWindowSchema
    })
    .parse(req.body);

  selectionMutation = payload.enabledPlatforms
    ? platformSelectionCoordinator.reserveMutation(payload.enabledPlatforms)
    : undefined;
  aiMutation = payload.aiEnabled !== undefined
    ? aiConsentCoordinator.reserveMutation(payload.aiEnabled)
    : undefined;

  const previous = await settingsStore.getSettings();

  // Presenter sandbox piggybacks on the existing demoMode plumbing so the
  // scan-queue guard at scan-queue.ts:841 still fires. Live read-only does
  // NOT touch demoMode — real threads remain visible, just read-only.
  const derivedDemoMode = payload.presenterDemoMode === "sandbox"
    ? true
    : payload.presenterDemoMode === "live" || payload.presenterDemoMode === "off"
      ? false
      : payload.demoMode;

  const updatePayload = { ...payload, demoMode: derivedDemoMode };
  const isLeavingDemo = previous.demoMode && derivedDemoMode === false;
  if (isLeavingDemo) {
    const manifest = await settingsStore.getDemoSeedManifest();
    let next = previous;
    if (manifest) {
      await cleanupDemoManifest(manifest);
    }
    next = await persistSettingsUpdate(updatePayload, selectionMutation, aiMutation);
    abortCurrentScanIfDeselected(next.enabledPlatforms);
    schedulePlatformSelectionReconciliation();
    res.json(next);
    return;
  }

  const next = await persistSettingsUpdate(updatePayload, selectionMutation, aiMutation);
  abortCurrentScanIfDeselected(next.enabledPlatforms);
  schedulePlatformSelectionReconciliation();

  const isEnteringDemo = !previous.demoMode && next.demoMode;
  const seedMode = next.presenterDemoMode === "sandbox" ? "full-presenter-demo" : "generic";

  if (isEnteringDemo) {
    const previousManifest = await settingsStore.getDemoSeedManifest();
    if (previousManifest) {
      await cleanupDemoManifest(previousManifest);
    }

    const manifest = await seedDemoData({
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      mode: seedMode
    });
    await settingsStore.setDemoSeedManifest(manifest);
  }

  res.json(next);
  } catch (error) {
    await selectionMutation?.cancel();
    await aiMutation?.cancel();
    if (error instanceof PlatformSelectionSupersededError) {
      res.status(409).json({
        error: "Platform choices changed in another window. Review the latest choices and try again."
      });
      return;
    }
    if (error instanceof AiConsentMutationSupersededError) {
      res.status(409).json({
        error: "AI choices changed in another window. Review the latest choice and try again."
      });
      return;
    }
    throw error;
  } finally {
    completeFocusPolicyMutation();
  }
}));

// Overdue-reply digest (#360). One calm digest; off by default; cadence is
// daily / weekly / off; click → /today, never per-thread. These endpoints
// are read-only by default — only /ack mutates `lastDigestAt` and per-person
// memory, and only after the dashboard has actually fired a notification.
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const localDateSchema = z.string().regex(LOCAL_DATE_RE, "expected YYYY-MM-DD");

app.get("/data/overdue-digest/settings", asyncRoute(async (_req, res) => {
  res.json(await overdueDigestStore.get());
}));

app.post("/control/overdue-digest/settings", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "change overdue-digest settings", kind: "operator-write" })) return;
  const payload = z
    .object({ cadence: z.enum(["off", "daily", "weekly"]) })
    .parse(req.body ?? {});
  const current = await overdueDigestStore.get();
  if (!isValidCadence(payload.cadence)) {
    res.status(400).json({ error: "invalid_cadence" });
    return;
  }
  const next = await overdueDigestStore.put({ ...current, cadence: payload.cadence });
  res.json(next);
}));

app.get("/data/overdue-digest/preview", asyncRoute(async (_req, res) => {
  const [settings, rows] = await Promise.all([overdueDigestStore.get(), loadOverdueDigestRows()]);
  const nowIso = new Date().toISOString();
  const candidates = selectCandidates({ rows, settings, nowIso });
  res.json({
    settings,
    candidates,
    snoozed: listSnoozedPeople(settings, nowIso)
  });
}));

app.post("/control/overdue-digest/tick", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "run the overdue-digest tick", kind: "operator-write" })) return;
  const payload = z.object({ localDate: localDateSchema }).parse(req.body ?? {});
  const [settings, rows] = await Promise.all([overdueDigestStore.get(), loadOverdueDigestRows()]);
  const result = computeTick({
    settings,
    rows,
    nowIso: new Date().toISOString(),
    localDate: payload.localDate
  });
  res.json(result);
}));

app.post("/control/overdue-digest/ack", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "acknowledge the overdue digest", kind: "operator-write" })) return;
  const payload = z
    .object({
      included: z
        .array(
          z.object({
            personId: z.string().min(1),
            displayName: z.string(),
            stateKey: z.string().min(1)
          })
        )
        .min(1),
      // The dashboard-local date the digest fired on. Persisted so the daily
      // cadence compares like-for-like local dates (#628). Optional so a stale
      // dashboard build that omits it still acks (falls back to the UTC prefix).
      localDate: localDateSchema.optional()
    })
    .parse(req.body ?? {});
  const current = await overdueDigestStore.get();
  // Refuse to ack when cadence is off — the dashboard should never reach
  // this state but the guard keeps memory honest if it somehow does.
  if (current.cadence === "off") {
    res.status(409).json({ error: "cadence_off" });
    return;
  }
  const nowIso = new Date().toISOString();
  const next = await overdueDigestStore.put(applyAck(current, payload.included, nowIso, payload.localDate));
  await auditService.log({
    action: "OVERDUE_DIGEST_FIRED",
    stage: "Notify",
    status: "OK",
    details: { count: payload.included.length, cadence: current.cadence }
  });
  res.json(next);
}));

app.post("/control/overdue-digest/dismiss-today", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "dismiss today's overdue digest", kind: "operator-write" })) return;
  const payload = z.object({ localDate: localDateSchema }).parse(req.body ?? {});
  const current = await overdueDigestStore.get();
  const next = await overdueDigestStore.put(applyDismissToday(current, payload.localDate));
  res.json(next);
}));

app.post("/control/overdue-digest/snooze-person", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "snooze a person in the overdue digest", kind: "operator-write" })) return;
  const payload = z
    .object({
      personId: z.string().min(1),
      displayName: z.string().default(""),
      days: z.number().int().min(1).max(60).default(7)
    })
    .parse(req.body ?? {});
  const current = await overdueDigestStore.get();
  const until = new Date(Date.now() + payload.days * 24 * 60 * 60 * 1000).toISOString();
  const next = await overdueDigestStore.put(
    applySnoozePerson(current, payload.personId, payload.displayName, until)
  );
  res.json(next);
}));

app.post("/control/overdue-digest/unsnooze-person", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "unsnooze a person in the overdue digest", kind: "operator-write" })) return;
  const payload = z.object({ personId: z.string().min(1) }).parse(req.body ?? {});
  const current = await overdueDigestStore.get();
  const next = await overdueDigestStore.put(applyUnsnoozePerson(current, payload.personId));
  res.json(next);
}));

// Single source of truth for "get out of presenter demo cleanly". Reached
// from the always-visible exit banner, the Settings recovery card, and as
// a CLI fallback. Never wrapped by the presenter guard — must always
// succeed even when the runner is in read-only mode.
app.post("/control/presenter-demo/reset", asyncRoute(async (_req, res) => {
  const manifest = await settingsStore.getDemoSeedManifest();
  if (manifest) {
    await cleanupDemoManifest(manifest, async () => {
      await settingsStore.updateSettings({
        demoMode: false,
        presenterDemoMode: "off",
        presenterReadOnly: false
      });
    });
  } else {
    await settingsStore.updateSettings({
      demoMode: false,
      presenterDemoMode: "off",
      presenterReadOnly: false
    });
  }
  res.json({ ok: true });
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

// #287 phase 3.5. AI-score LinkedIn dormant threads for the Reconnect
// page. Picks up to `limit` candidates that lack a fresh score, calls
// the AI scorer for each, and persists score + reason + cache key.
// Always safe to call: missing AI keys, transient outages, or a
// per-thread failure simply leave the existing column unchanged. The
// dashboard's deterministic relationship-signal ranking continues to
// work in the absence of any AI score.
app.post("/control/reconnect/refresh-scores", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "refresh reconnect scores", kind: "external-action" })) return;
  const limit = Math.min(
    Math.max(1, Number(req.body?.limit) || 20),
    100
  );

  // Honour the operator's AI tier (#287 F3). "memory_only" turns off
  // the organisational AI features, so the endpoint short-circuits to
  // a no-op response instead of calling the model. The dashboard's
  // refresh button surfaces the "disabled_by_settings" status in its
  // result message.
  const operatorProfile = await settingsStore.getOperatorProfile();
  if (operatorProfile.aiHelpLevel === "memory_only") {
    res.json({
      status: "disabled_by_settings",
      scored: 0,
      skipped: 0,
      failed: 0,
      candidates_seen: 0,
      limit
    });
    return;
  }

  const horizonCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Mirror the dashboard's isReconnectCandidate predicate
  // (apps/dashboard/lib/reconnect.ts): a dormant thread with a queued reply
  // (scheduledSendAt set) drops off the Reconnect page, so the runner must not
  // spend an AI call scoring - and persist a reconnectScore onto - a row the
  // dashboard never shows. Fetch the SCHEDULED sendRequest threadIds first
  // (same source /data/inbox uses) and exclude them from the candidate query.
  const scheduledSends = await prisma.sendRequest.findMany({
    where: { status: "SCHEDULED" },
    select: { threadId: true }
  });
  const scheduledThreadIds = [...new Set(scheduledSends.map((s) => s.threadId))];

  const candidates = await prisma.thread.findMany({
    where: buildReconnectCandidateWhere(horizonCutoff, scheduledThreadIds),
    select: {
      id: true,
      platform: true,
      lastMessageAt: true,
      lastInboundAt: true,
      rollingSummary: true,
      reconnectScore: true,
      reconnectScoreCacheKey: true,
      person: {
        select: {
          displayName: true,
          enrichment: { select: { headline: true, currentRole: true, currentCompany: true } }
        }
      },
      _count: { select: { messages: true } },
      messages: {
        orderBy: { timestamp: "desc" },
        take: 6,
        select: {
          direction: true,
          text: true,
          timestamp: true,
          audioTranscription: { select: { status: true, transcript: true } }
        }
      }
    },
    orderBy: { lastMessageAt: "desc" },
    take: limit * 4 // overfetch so we can skip cache hits without blocking the limit
  });

  let scored = 0;
  let skipped = 0;
  let failed = 0;
  let unavailable = false;

  for (const thread of candidates) {
    if (scored >= limit) break;

    const outboundCount = thread.messages.filter((m) => m.direction === "OUT").length;
    const totalCount = thread._count?.messages ?? thread.messages.length;
    const lastInbound = thread.messages.find((m) => m.direction === "IN");
    const daysDormant = thread.lastMessageAt
      ? Math.max(0, Math.floor((Date.now() - thread.lastMessageAt.getTime()) / (24 * 60 * 60 * 1000)))
      : 0;

    // Cache key intentionally narrow: only re-score when the signals
    // the AI was given actually change. A new outbound message would
    // also un-dormant the thread, so this is mostly defensive.
    const cacheKey = stableHash(
      [
        "reconnect-v1",
        thread.lastMessageAt?.toISOString() ?? "no-last",
        String(outboundCount),
        String(totalCount),
        cleanText(lastInbound?.text ?? "")
      ].join("|")
    );

    if (thread.reconnectScoreCacheKey === cacheKey && thread.reconnectScore !== null) {
      skipped += 1;
      continue;
    }

    const enrichment = thread.person.enrichment;
    const blurb = enrichment
      ? [enrichment.currentRole, enrichment.currentCompany, enrichment.headline]
          .filter((s) => s && s.trim().length > 0)
          .join(" · ")
      : null;

    // Oldest-first turns for the prompt examples.
    const orderedMessages = [...thread.messages]
      .reverse()
      .map(prismaMessageToPrompt).filter(isAiVisibleMessage);

    const verdict = await aiService
      .scoreReconnectCandidate({
        displayName: thread.person.displayName,
        contactBlurb: blurb,
        daysDormant,
        operatorOutboundCount: outboundCount,
        totalMessageCount: totalCount,
        messages: orderedMessages,
        summary: thread.rollingSummary
      })
      .catch(() => null);

    if (!verdict) {
      // null can mean "no AI client" or "transient failure"; either way,
      // there is no point hammering the loop. Mark and exit.
      unavailable = true;
      failed += 1;
      break;
    }

    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        reconnectScore: verdict.score,
        reconnectScoreReason: verdict.reason,
        reconnectScoreCacheKey: cacheKey
      }
    });
    scored += 1;
  }

  res.json({
    status: unavailable ? "ai_unavailable" : "ok",
    scored,
    skipped,
    failed,
    candidates_seen: candidates.length,
    limit
  });
}));

// #287 phase 2.5 follow-up. AI-classify the close status of threads
// that have never had a verdict (or whose cache key has drifted). The
// scan-queue classifies threads as new inbound messages arrive, so this
// is for the long tail: dormant threads, threads that pre-date the AI
// classifier, threads classified before the v2 cache key (which added
// the reason caption). Same fail-open contract as the reconnect
// refresher: per-thread failures break the loop cleanly rather than
// hammering when the provider is unavailable.
app.post("/control/closed-status/refresh-stale", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "refresh closed verdicts", kind: "external-action" })) return;
  const limit = Math.min(
    Math.max(1, Number(req.body?.limit) || 30),
    150
  );

  // Honour the operator's chosen AI tier (#287 F3): "memory_only" turns
  // off organisational AI features, so this trigger should also be a
  // no-op rather than calling the model behind the operator's back.
  const operatorProfile = await settingsStore.getOperatorProfile();
  if (operatorProfile.aiHelpLevel === "memory_only") {
    res.json({
      status: "disabled_by_settings",
      scored: 0,
      skipped: 0,
      failed: 0,
      candidates_seen: 0,
      limit
    });
    return;
  }

  // The whole point of this endpoint is to refill missing reasons too,
  // so we target rows where either the verdict OR the reason is null.
  // Threads with a cache key matching the current v2 hash will skip the
  // AI call inside the loop via the cache check.
  const candidates = await prisma.thread.findMany({
    where: {
      // Only classify threads with an inbound message at all - the
      // classifier short-circuits to "open" for OUT-last threads via a
      // deterministic reason. There is nothing to refill there.
      lastInboundAt: { not: null },
      OR: [
        { closedStatus: null },
        { closedStatusReason: null }
      ]
    },
    select: {
      id: true,
      closedStatusCacheKey: true,
      lastInboundAt: true,
      lastInboundHash: true,
      rollingSummary: true,
      person: { select: { displayName: true } },
      messages: {
        orderBy: { timestamp: "desc" },
        take: 5,
        select: {
          direction: true,
          text: true,
          timestamp: true,
          audioTranscription: { select: { status: true, transcript: true } }
        }
      }
    },
    orderBy: { lastMessageAt: "desc" },
    take: limit * 3
  });

  let scored = 0;
  let skipped = 0;
  let failed = 0;
  let unavailable = false;

  for (const thread of candidates) {
    if (scored >= limit) break;

    const orderedMessages = [...thread.messages].reverse().map(prismaMessageToPrompt).filter(isAiVisibleMessage);
    const lastInbound = orderedMessages.filter((m) => m.direction === "IN").pop();
    if (!lastInbound) {
      // Defensive: lastInboundAt was non-null but the messages slice
      // did not contain an IN message (perhaps newer outbound messages
      // pushed it out of the top 5). Skip rather than guessing.
      skipped += 1;
      continue;
    }

    const cacheKey = stableHash(
      `closed-v3|${lastInbound.timestamp}|${cleanText(lastInbound.text)}`
    );

    if (thread.closedStatusCacheKey === cacheKey) {
      skipped += 1;
      continue;
    }

    const verdict = await aiService
      .classifyThreadClosed({
        displayName: thread.person.displayName,
        messages: orderedMessages,
        summary: thread.rollingSummary
      })
      .catch(() => null);

    if (!verdict) {
      unavailable = true;
      failed += 1;
      break;
    }

    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        closedStatus: verdict.status,
        closedStatusReason: verdict.reason,
        closedStatusCacheKey: cacheKey
      }
    });
    scored += 1;
  }

  res.json({
    status: unavailable ? "ai_unavailable" : "ok",
    scored,
    skipped,
    failed,
    candidates_seen: candidates.length,
    limit
  });
}));

app.post("/control/scan", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "run a scan", kind: "external-action" })) return;
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "WHATSAPP", "GOOGLE_MESSAGES"]).optional(),
      maxThreads: z.number().nullable().optional(),
      maxOpens: z.number().nullable().optional(),
      forceFallback: z.boolean().nullable().optional(),
      scope: z.enum(["update", "full"]).optional()
    })
    .parse(req.body ?? {});

  if (payload.platform && !runnerConfig.availablePlatforms.includes(payload.platform)) {
    res.status(404).json({ ok: false, reason: "platform_disabled" });
    return;
  }
  const settings = await settingsStore.getSettings();
  if (payload.platform && !settings.enabledPlatforms.includes(payload.platform)) {
    res.status(409).json({ ok: false, reason: "platform_not_selected" });
    return;
  }

  // #774: never let a WhatsApp scan run before the operator has linked a
  // device. The scan path calls ensureConnected(), which for a disconnected
  // WhatsApp would launch a fresh whatsapp-web.js session and pop a QR - so
  // a routine autoscan tick must no-op instead of hijacking the connect
  // flow. Manual + post-link scans (state === "connected") pass through.
  if (payload.platform === "WHATSAPP" && whatsappConnect.state !== "connected") {
    res.status(409).json({ ok: false, reason: "whatsapp_not_connected" });
    return;
  }

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
  if (await checkPresenterGuard(res, settingsStore, { action: "connect a platform", kind: "external-action" })) return;
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "GOOGLE_MESSAGES"]) }).parse(req.body);
  const platform = parsePlatform(payload.platform);
  const requestId = getControlTrace(res)?.requestId ?? uuid();
  const startedAt = Date.now();
  const connectTimeoutMs = connectTimeoutMsForCurrentProfile(platform);

  try {
  await platformSelectionCoordinator.withSelectedPlatform(platform, async () => {
    const platformSession = resolvePlatformSession(platform);
    const browserProfileDetails = platformBrowserProfileDetails(
      platform,
      platformSession.profileDir
    );
    await auditService.log({
      platform,
      stage: "Connect",
      action: "CONNECT_START",
      status: "OK",
      details: {
        requestId,
        ...browserProfileDetails,
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
        // Connect is operator-initiated: a launch it triggers should be
        // VISIBLE (the operator may need to complete a login / 2FA), unlike
        // the hidden background launches that scans and sends use. Mark the
        // visible intent for the launch, and reveal an already-warm-but-hidden
        // window so manual sign-in is reachable even when no new launch fires.
        const releaseVisible = platformSession.sessionManager.markVisibleLaunch(platform);
        trackedPromise = (
          platformAdapter.connectInteractively?.() ?? platformAdapter.ensureConnected()
        )
          .finally(() =>
            platformSession.sessionManager
              .revealWindow(platform, platformSession.personKey)
              .catch(() => undefined)
          )
          .finally(() => releaseVisible())
          .finally(() => {
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
      if (platform === "LINKEDIN") {
        const settings = await settingsStore.getSettings();
        if (settings.enabledPlatforms.includes("LINKEDIN")) {
          startLinkedInRealtimeWatcher();
        }
      }

      await auditService.log({
        platform,
        stage: "Connect",
        action: "CONNECT_OK",
        status: "OK",
        details: {
          requestId,
          durationMs: Date.now() - startedAt,
          ...browserProfileDetails,
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
          ...browserProfileDetails,
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
  } catch (error) {
    if (error instanceof PlatformNotSelectedError) {
      res.status(409).json({
        error: "Select this message source in Settings before connecting it.",
        reason: "platform_not_selected"
      });
      return;
    }
    throw error;
  }
}));

app.post("/control/platform/test-selectors", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "run selector tests", kind: "external-action" })) return;
  const payload = z
    .object({
      platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "GOOGLE_MESSAGES"]),
      key: z
        .enum([
          "thread_list",
          "thread_item",
          "unread_badge",
          "thread_snippet",
          "thread_link",
          "thread_identity",
          "conversation_header",
          "message_container",
          "message_item",
          "message_text",
          "message_id",
          "message_direction_in",
          "message_direction_out",
          "message_timestamp",
          "message_sender",
          "message_media",
          "message_deleted",
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

// SEND IS USER-TRIGGERED ONLY — by design, never on a timer, never
// from a background loop, never as part of a scan. Reading is
// low-risk (looks like inbox usage); sending is high-risk (creates
// a side-effect on someone else's account, which is where LinkedIn's
// abuse models pay closest attention). Every entry to this endpoint
// must originate from an explicit operator action in the UI.
// Anything that drifts toward "auto-send" — auto-replies, scheduled
// outreach loops, batch send-all — should land in a separate gated
// surface, never inline here.
app.post("/control/thread/:threadId/send", maybeMultipart, asyncRoute(async (req, res) => {
  const completeUserTriggeredIntent = beginUserTriggeredIntentOperation(res);
  const requestIntentVersion = userTriggeredIntentVersion(res);
  const stagedAttachmentRequest = createStagedAttachmentRequestLifecycle(req, {
    discard: discardStagedAttachments,
    releaseActivity: () => releaseOutgoingAttachmentRequestActivity(req),
    resolveOwnership: sendRequestOwnsStagedAttachments
  });
  let stagedAttachments: Array<{
    absolutePath: string;
    contentDigest: string;
    displayName: string;
    kind: ReturnType<typeof kindFromMime>;
    mimeType: string;
  }> = [];
  const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
  try {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "send", kind: "thread-mutation" })) return;
  // For multipart bodies, multer puts file metadata on req.files and
  // string fields on req.body. Reuse the same JSON schema for the field
  // values so the validation flow is identical between JSON and multipart.
  const payload = z
    .object({
      text: z.string(),
      clientSendId: z.string().uuid(),
      clientRequestedAt: z.string().datetime().optional(),
      consumeDraftText: z.string().max(5000).optional(),
      consumeDraftUpdatedAt: z.string().datetime().optional(),
      // Optional ISO 8601 timestamp. When present, the send is persisted
      // as SCHEDULED and the scheduled-send promoter flips it to PENDING
      // when the time elapses. When absent, the send is enqueued
      // immediately (existing behaviour).
      scheduledFor: z.string().datetime().optional(),
      source: z.literal("focus_ack").optional(),
      focusWindowId: z.string().min(1).max(80).optional(),
      // App-level threading. When the dashboard's focused-thread composer
      // sends a reply, it includes the parent Message.id here. The send
      // itself still goes out as a regular text bubble — the threading is
      // only persisted on our side and rendered by the dashboard.
      replyToMessageId: z.string().min(1).optional(),
      recoveryPredecessorClientSendId: z.string().uuid().optional()
    })
    .refine(
      (value) =>
        (value.consumeDraftText === undefined) ===
        (value.consumeDraftUpdatedAt === undefined),
      { message: "consumeDraftText and consumeDraftUpdatedAt must be provided together" }
    )
    .parse(req.body);
  stagedAttachments = await Promise.all(
    uploadedFiles.map(async (f) => ({
      absolutePath: f.path,
      displayName: f.originalname,
      mimeType: f.mimetype,
      kind: kindFromMime(f.mimetype, f.originalname),
      contentDigest: await sha256File(f.path)
    }))
  );
  if (stagedAttachments.length === 0 && payload.text.trim().length === 0) {
    res.status(400).json({ error: "send must have text, attachments, or both" });
    return;
  }
  if (payload.source && payload.scheduledFor) {
    res.status(400).json({ error: "focus acknowledgements cannot be scheduled" });
    return;
  }
  if (payload.source === "focus_ack" && !payload.focusWindowId) {
    res.status(400).json({ error: "focus_window_required" });
    return;
  }

  // Reject early for unsupported platforms — without this, the SendRequest
  // queues, the worker hits `adapter.sendMessage(undefined)` and records a
  // confusing "Cannot read properties of undefined" on the FAILED row.
  // Same guard as /open and /rescan; see requireAdapter.
  const target = await getThreadStub(threadId);
  requireAdapter(target.platform);
  if (!platformSelectionAllowsNewWork(target.platform)) {
    throw new PlatformNotSelectedError(target.platform);
  }
  const sendSettings = await settingsStore.getSettings();
  if (!sendSettings.enabledPlatforms.includes(target.platform)) {
    throw new PlatformNotSelectedError(target.platform);
  }

  // Schedule path: persist a SCHEDULED row and return immediately. The
  // dashboard renders a "scheduled for X" pill instead of pushing the
  // bubble through the optimistic-send timeline. The promoter takes
  // over from there.
  if (payload.scheduledFor) {
    try {
      stagedAttachmentRequest.markPersistenceAttempted(payload.clientSendId);
      const scheduleResult = await sendService.enqueueScheduledSend({
        threadId,
        text: payload.text,
        clientSendId: payload.clientSendId,
        scheduledFor: new Date(payload.scheduledFor),
        attachments: stagedAttachments,
        replyToMessageId: payload.replyToMessageId,
        recoveryPredecessorClientSendId:
          payload.recoveryPredecessorClientSendId,
        consumeDraft:
          payload.consumeDraftText !== undefined && payload.consumeDraftUpdatedAt
            ? {
                text: payload.consumeDraftText,
                updatedAt: new Date(payload.consumeDraftUpdatedAt)
              }
            : undefined
      });
      if (scheduleResult.replayed) {
        await discardStagedAttachments(stagedAttachments);
      }
      stagedAttachmentRequest.markHandled();
      res.json({
        clientSendId: scheduleResult.clientSendId,
        status: scheduleResult.status,
        scheduledFor: scheduleResult.scheduledFor,
        replayed: scheduleResult.replayed,
        draftConsumed: scheduleResult.draftConsumed,
        // Surfaced for parity with enqueueAndKick's response shape so the
        // dashboard doesn't need a separate fetch to refresh the bar.
        activeCount: await sendQueue.getActiveCount(),
        queuePosition: -1
      });
      return;
    } catch (error) {
      await auditService.log({
        platform: target.platform,
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
    messageSyncLatency.startSend(
      payload.clientSendId,
      payload.clientRequestedAt ?? new Date().toISOString()
    );
    stagedAttachmentRequest.markPersistenceAttempted(payload.clientSendId);
    const queueResult = await sendQueue.enqueueAndKick({
      threadId,
      text: payload.text,
      clientSendId: payload.clientSendId,
      attachments: stagedAttachments,
      source: payload.source ?? "manual",
      focusWindowId: payload.focusWindowId,
      focusIntentVersion:
        payload.source === "focus_ack" ? requestIntentVersion : undefined,
      rearmPolicyBlockedFocusAcknowledgement: payload.source === "focus_ack",
      replyToMessageId: payload.replyToMessageId,
      recoveryPredecessorClientSendId:
        payload.recoveryPredecessorClientSendId,
      consumeDraft:
        payload.consumeDraftText !== undefined && payload.consumeDraftUpdatedAt
          ? {
              text: payload.consumeDraftText,
              updatedAt: new Date(payload.consumeDraftUpdatedAt)
            }
          : undefined
    });
    if (queueResult.replayed) {
      await discardStagedAttachments(stagedAttachments);
    }
    stagedAttachmentRequest.markHandled();
    res.json(queueResult);
  } catch (error) {
    await auditService.log({
      platform: target.platform,
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
  } finally {
    await stagedAttachmentRequest.finalize();
    completeUserTriggeredIntent();
  }
}));

app.post("/control/thread/:threadId/send-poll", asyncRoute(async (req, res) => {
  const completeUserTriggeredIntent = beginUserTriggeredIntentOperation(res);
  try {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "send a poll", kind: "thread-mutation" })) return;
  const payload = z
    .object({
      question: z.string().trim().min(1).max(280),
      options: z
        .array(z.string().trim().min(1).max(280))
        .min(2)
        .max(12)
        .transform((options) => Array.from(new Set(options))),
      allowMultipleAnswers: z.boolean().optional().default(false),
      clientSendId: z.string().uuid()
    })
    .parse(req.body ?? {});
  if (payload.options.length < 2) {
    res.status(400).json({ error: "poll must have at least two different options" });
    return;
  }

  const clientSendId = payload.clientSendId;

  const outcome = await threadExternalActionFence.run(threadId, async (target) => {
    const adapter = requireAdapter(target.platform);
    if (!adapter.sendPoll) {
      res.status(400).json({ error: `${target.platform} adapter does not support sending polls` });
      return;
    }
    const threadRow = await prisma.thread.findUnique({
      where: { id: threadId },
      include: { person: true }
    });
    if (!threadRow) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    const threadStub: ThreadStub = {
      platformThreadId: target.platformThreadId,
      displayName: target.displayName,
      recipientVerificationLabel: target.recipientVerificationLabel,
      threadUrl: target.threadUrl,
      lastMessagePreview: ""
    };

    try {
      const result = await pollSendService.send({
        clientSendId,
        thread: {
          id: threadRow.id,
          platform: target.platform,
          lastInboundAt: threadRow.lastInboundAt,
          lastOutboundAt: threadRow.lastOutboundAt,
          lastMessageAt: threadRow.lastMessageAt
        },
        question: payload.question,
        options: payload.options,
        allowMultipleAnswers: payload.allowMultipleAnswers,
        beforeDispatch: () =>
          assertPlatformSelectedForExternalAction(target.platform),
        isPreDispatchFailure: isWhatsAppPollSendPreDispatchError,
        dispatch: () =>
          adapter.sendPoll!(threadStub, {
            question: payload.question,
            options: payload.options,
            allowMultipleAnswers: payload.allowMultipleAnswers
          })
      });
      res.status(result.status === "pending" ? 202 : 200).json(result);
    } catch (error) {
      if (!(error instanceof PollSendError)) throw error;
      res.status(error.statusCode).json({
        error: error.message,
        failure: error.failure
      });
    }
  });
  if (outcome.status === "missing") {
    res.status(404).json({ error: "thread not found" });
  }
  } finally {
    completeUserTriggeredIntent();
  }
}));

app.post("/control/thread/:threadId/update-send", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "update a scheduled send", kind: "thread-mutation" })) return;
  // Either text, scheduledFor, or both. Empty body 400s — there's
  // nothing to do if the operator didn't send a change.
  const payload = z
    .object({
      clientSendId: z.string().uuid(),
      text: z.string().max(5000).optional(),
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
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "cancel a send", kind: "thread-mutation" })) return;
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
  const completeUserTriggeredIntent = beginUserTriggeredIntentOperation(res);
  const requestIntentVersion = userTriggeredIntentVersion(res);
  try {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "retry a send", kind: "thread-mutation" })) return;
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
  const retryEligibility = persistedSendRetryEligibility(original.status, original.errorJson);
  if (!retryEligibility.allowed) {
    res.status(409).json({ error: retryEligibility.reason });
    return;
  }
  const originalSource = parsePersistedSendSource(original.source);
  if (!originalSource) {
    res.status(409).json({ error: "invalid_send_source" });
    return;
  }

  // Preserve the original send's attachments and reply-threading so a retry
  // re-sends the same message, not a text-only stub. Staged attachment files
  // persist after a FAILED send (the send service doesn't unlink them), so the
  // original absolutePath references are still valid.
  let retryAttachments;
  try {
    retryAttachments = parseRetryAttachments(original.attachmentsJson);
  } catch {
    res.status(409).json({ error: "invalid_attachment_metadata" });
    return;
  }
  if (originalSource === "focus_auto_ack") {
    res.status(409).json({ error: "automatic_focus_ack_retry_not_operator_triggered" });
    return;
  }
  if (originalSource === "focus_ack") {
    const [profile, focusThread] = await Promise.all([
      settingsStore.getOperatorProfile(),
      prisma.thread.findUnique({
        where: { id: threadId },
        select: { personId: true }
      })
    ]);
    if (
      !focusThread ||
      !profile.focusWindow.windowId ||
      original.clientSendId !==
        focusManualAckClientSendId(profile.focusWindow.windowId, focusThread.personId)
    ) {
      res.status(409).json({ error: "focus_window_changed" });
      return;
    }
    const queueResult = await sendQueue.enqueueAndKick({
      threadId,
      text: original.requestText,
      clientSendId: original.clientSendId,
      source: "focus_ack",
      focusWindowId: profile.focusWindow.windowId,
      focusIntentVersion: requestIntentVersion,
      retryFailedFocusAcknowledgement: true,
      attachments: retryAttachments,
      replyToMessageId: original.replyToMessageId ?? undefined
    });
    res.json(queueResult);
    return;
  }
  const newClientSendId = deriveRetryClientSendId(original.clientSendId);
  try {
    const queueResult = await sendQueue.enqueueAndKick({
      threadId,
      text: original.requestText,
      clientSendId: newClientSendId,
      source: originalSource,
      attachments: retryAttachments,
      replyToMessageId: original.replyToMessageId ?? undefined,
      recoveryPredecessorClientSendId: original.clientSendId
    });
    res.json({ ...queueResult, clientSendId: newClientSendId });
  } catch (error) {
    await auditService.log({
      platform: retryTarget.platform,
      stage: "Send",
      action: "SEND_RETRY_FAIL",
      status: "FAIL",
      details: { threadId, originalClientSendId: payload.clientSendId, ...summarizeError(error) }
    });
    throw error;
  }
  } finally {
    completeUserTriggeredIntent();
  }
}));

app.post("/control/thread/:threadId/focus-ack/complete", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, {
    threadId,
    action: "complete a focus acknowledgement",
    kind: "thread-mutation"
  })) return;
  const payload = z.object({
    clientSendId: z.string().uuid(),
    focusWindowId: z.string().min(1).max(80)
  }).parse(req.body);
  const request = await prisma.sendRequest.findUnique({
    where: { clientSendId: payload.clientSendId },
    include: { thread: { select: { personId: true } } }
  });
  if (!request) {
    res.status(404).json({ error: "send_request_not_found" });
    return;
  }
  if (
    request.threadId !== threadId ||
    (request.source !== "focus_ack" && request.source !== "focus_auto_ack")
  ) {
    res.status(409).json({ error: "focus_ack_intent_mismatch" });
    return;
  }
  if (request.status !== "SENT") {
    res.status(409).json({ error: `focus_ack_not_delivered:${request.status}` });
    return;
  }
  const profile = await settingsStore.getOperatorProfile();
  const windowStartedAt = Date.parse(profile.focusWindow.startedAt);
  if (
    profile.focusWindow.windowId !== payload.focusWindowId ||
    !Number.isFinite(windowStartedAt) ||
    request.createdAt.getTime() < windowStartedAt ||
    !focusAcknowledgementClientSendIds(
      payload.focusWindowId,
      request.thread.personId
    ).includes(request.clientSendId)
  ) {
    res.status(409).json({ error: "focus_window_changed" });
    return;
  }
  const acknowledged = await settingsStore.acknowledgeFocusWindowPerson(
    payload.focusWindowId,
    request.thread.personId
  );
  if (!acknowledged) {
    res.status(409).json({ error: "focus_window_changed" });
    return;
  }
  res.json({ status: "acknowledged", clientSendId: payload.clientSendId });
}));

app.post("/control/thread/:threadId/open", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "open the thread in the browser", kind: "external-action" })) return;
  const target = await getThreadStub(threadId);
  const adapter = requireAdapter(target.platform);

  await withPlatformControlLock(target.platform, async () => {
    try {
      await adapter.openThread({
        platformThreadId: target.platformThreadId,
        displayName: target.displayName,
        recipientVerificationLabel: target.recipientVerificationLabel,
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
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "open the contact profile", kind: "external-action" })) return;
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

// React to a single message (#408, Phase 1). User-triggered only, like
// /send: it creates a visible side-effect on the contact's conversation, so
// it goes through the presenter guard and the per-platform control lock.
// Adapters without a reaction surface (iMessage today) return a clean 400.
app.post("/control/thread/:threadId/message/:messageId/react", asyncRoute(async (req, res) => {
  const { threadId, messageId } = z
    .object({ threadId: z.string().min(1), messageId: z.string().min(1) })
    .parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "react to a message", kind: "thread-mutation" })) return;
  const payload = z.object({
    clientActionId: z.string().uuid(),
    emoji: z.string().trim().min(1).max(16)
  }).parse(req.body ?? {});

  const outcome = await threadExternalActionFence.run(threadId, async (target) => {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.threadId !== threadId) {
      res.status(404).json({ error: "message not found in thread" });
      return;
    }
    const adapter = requireAdapter(target.platform);
    if (!adapter.reactToMessage) {
      res.status(400).json({ error: `${target.platform} adapter does not support message reactions` });
      return;
    }
    const threadStub: ThreadStub = {
      platformThreadId: target.platformThreadId,
      displayName: target.displayName,
      recipientVerificationLabel: target.recipientVerificationLabel,
      threadUrl: target.threadUrl,
      lastMessagePreview: ""
    };

    try {
      const result = await durableExternalActionService.execute({
        clientActionId: payload.clientActionId,
        threadId,
        targetMessageId: messageId,
        actionType: "message_reaction",
        payload: { emoji: payload.emoji },
        beforeDispatch: () =>
          assertPlatformSelectedForExternalAction(target.platform),
        dispatch: () =>
          adapter.reactToMessage!(threadStub, message.platformMessageKey, payload.emoji),
        auditSuccess: () =>
          auditService.log({
            platform: target.platform,
            stage: "Send",
            action: "MESSAGE_REACT",
            status: "OK",
            details: { threadId, messageId, emoji: payload.emoji }
          }),
        auditFailure: (error) =>
          auditService.log({
            platform: target.platform,
            stage: "Send",
            action: "MESSAGE_REACT_FAIL",
            status: "FAIL",
            details: { threadId, messageId, emoji: payload.emoji, ...summarizeError(error) }
          })
      });
      res.json({
        status: "ok",
        emoji: payload.emoji,
        replayed: result.replayed,
        reconciliationPending: result.reconciliationPending ?? false
      });
    } catch (error) {
      if (error instanceof DurableExternalActionError) {
        res.status(409).json({ error: error.message, reason: error.reason });
        return;
      }
      throw error;
    }
  });
  if (outcome.status === "missing") {
    res.status(404).json({ error: "thread not found" });
  }
}));

app.post("/control/thread/:threadId/message/:messageId/edit", asyncRoute(async (req, res) => {
  const { threadId, messageId } = z
    .object({ threadId: z.string().min(1), messageId: z.string().min(1) })
    .parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "edit a message", kind: "thread-mutation" })) return;
  const payload = z.object({
    clientActionId: z.string().uuid(),
    text: z.string().trim().min(1).max(8_000)
  }).parse(req.body ?? {});

  const outcome = await threadExternalActionFence.run(threadId, async (target) => {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.threadId !== threadId) {
      res.status(404).json({ error: "message not found in thread" });
      return;
    }
    if (message.direction !== "OUT") {
      res.status(400).json({ error: "only outbound messages can be edited" });
      return;
    }
    const adapter = requireAdapter(target.platform);
    if (!adapter.editMessage) {
      res.status(400).json({ error: `${target.platform} adapter does not support message edits` });
      return;
    }
    const threadStub: ThreadStub = {
      platformThreadId: target.platformThreadId,
      displayName: target.displayName,
      recipientVerificationLabel: target.recipientVerificationLabel,
      threadUrl: target.threadUrl,
      lastMessagePreview: ""
    };

    try {
      const result = await durableExternalActionService.execute({
        clientActionId: payload.clientActionId,
        threadId,
        targetMessageId: messageId,
        actionType: "message_edit",
        payload: { text: payload.text },
        beforeDispatch: () =>
          assertPlatformSelectedForExternalAction(target.platform),
        dispatch: () =>
          adapter.editMessage!(threadStub, message.platformMessageKey, payload.text),
        auditSuccess: () =>
          auditService.log({
            platform: target.platform,
            stage: "Send",
            action: "MESSAGE_EDIT",
            status: "OK",
            details: { threadId, messageId }
          }),
        auditFailure: (error) =>
          auditService.log({
            platform: target.platform,
            stage: "Send",
            action: "MESSAGE_EDIT_FAIL",
            status: "FAIL",
            details: { threadId, messageId, ...summarizeError(error) }
          })
      });
      res.json({
        status: "ok",
        text: payload.text,
        replayed: result.replayed,
        reconciliationPending: result.reconciliationPending ?? false
      });
    } catch (error) {
      if (error instanceof DurableExternalActionError) {
        res.status(409).json({ error: error.message, reason: error.reason });
        return;
      }
      throw error;
    }
  });
  if (outcome.status === "missing") {
    res.status(404).json({ error: "thread not found" });
  }
}));

app.post("/control/thread/:threadId/message/:messageId/poll-vote", asyncRoute(async (req, res) => {
  const { threadId, messageId } = z
    .object({ threadId: z.string().min(1), messageId: z.string().min(1) })
    .parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "vote on a poll", kind: "thread-mutation" })) return;
  const payload = z.object({
    clientActionId: z.string().uuid(),
    selectedOptions: z.array(z.string().trim().min(1).max(280)).min(1).max(12)
  }).parse(req.body ?? {});

  const outcome = await threadExternalActionFence.run(threadId, async (target) => {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.threadId !== threadId) {
      res.status(404).json({ error: "message not found in thread" });
      return;
    }
    if (!message.platformMessageKey) {
      res.status(400).json({ error: "message has no platform key" });
      return;
    }
    const adapter = requireAdapter(target.platform);
    if (!adapter.voteOnPoll) {
      res.status(400).json({ error: `${target.platform} adapter does not support poll votes` });
      return;
    }
    const threadStub: ThreadStub = {
      platformThreadId: target.platformThreadId,
      displayName: target.displayName,
      recipientVerificationLabel: target.recipientVerificationLabel,
      threadUrl: target.threadUrl,
      lastMessagePreview: ""
    };

    try {
      const result = await durableExternalActionService.execute({
        clientActionId: payload.clientActionId,
        threadId,
        targetMessageId: messageId,
        actionType: "poll_vote",
        payload: { selectedOptions: payload.selectedOptions },
        beforeDispatch: () =>
          assertPlatformSelectedForExternalAction(target.platform),
        isPreDispatchFailure: isWhatsAppPollVotePreDispatchError,
        dispatch: () =>
          adapter.voteOnPoll!(threadStub, message.platformMessageKey!, payload.selectedOptions),
        auditSuccess: () =>
          auditService.log({
            platform: target.platform,
            stage: "Send",
            action: "POLL_VOTE",
            status: "OK",
            details: { threadId, messageId, optionCount: payload.selectedOptions.length }
          }),
        auditFailure: (error) =>
          auditService.log({
            platform: target.platform,
            stage: "Send",
            action: "POLL_VOTE_FAIL",
            status: "FAIL",
            details: {
              threadId,
              messageId,
              optionCount: payload.selectedOptions.length,
              ...summarizeError(error)
            }
          })
      });
      res.json({
        status: "ok",
        selectedOptions: payload.selectedOptions,
        replayed: result.replayed,
        reconciliationPending: result.reconciliationPending ?? false
      });
    } catch (error) {
      if (isWhatsAppPollVotePreDispatchError(error)) {
        res.status(409).json({
          error: error.message,
          reason: error.reason
        });
        return;
      }
      if (error instanceof DurableExternalActionError) {
        res.status(409).json({ error: error.message, reason: error.reason });
        return;
      }
      throw error;
    }
  });
  if (outcome.status === "missing") {
    res.status(404).json({ error: "thread not found" });
  }
}));

// Live poll tallies for the dashboard's "View votes" affordance
// (R-0100 / #818). Read-only: no presenter guard, no audit row. Fetched on
// demand because platform-side tallies mutate continuously — persisting
// counts at scan time would show stale numbers within minutes.
app.get("/control/thread/:threadId/message/:messageId/poll-votes", asyncRoute(async (req, res) => {
  const { threadId, messageId } = z
    .object({ threadId: z.string().min(1), messageId: z.string().min(1) })
    .parse(req.params);

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.threadId !== threadId) {
    res.status(404).json({ error: "message not found in thread" });
    return;
  }
  if (!message.platformMessageKey) {
    res.status(400).json({ error: "message has no platform key" });
    return;
  }

  const target = await getThreadStub(threadId);
  const adapter = requireAdapter(target.platform);
  if (!adapter.getPollVotes) {
    res.status(400).json({ error: `${target.platform} adapter does not support poll votes` });
    return;
  }
  const threadStub: ThreadStub = {
    platformThreadId: target.platformThreadId,
    displayName: target.displayName,
    recipientVerificationLabel: target.recipientVerificationLabel,
    threadUrl: target.threadUrl,
    lastMessagePreview: ""
  };

  // Serialised with sends/votes on the same platform lock — wweb.js store
  // reads are cheap, but interleaving them with an in-flight send has
  // produced Puppeteer races elsewhere, so stay consistent with poll-vote.
  try {
    const votes = await withPlatformControlLock(target.platform, () =>
      adapter.getPollVotes!(threadStub, message.platformMessageKey!)
    );
    res.json({ votes });
  } catch (error) {
    if (isWhatsAppSessionUnavailableError(error)) {
      res.status(409).json({
        error: "WhatsApp lost its connection. Reconnect it in Settings, then try again.",
        reason: "whatsapp_session_unavailable"
      });
      return;
    }
    throw error;
  }
}));

app.post("/control/thread/:threadId/rescan", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "rescan the thread", kind: "external-action" })) return;
  const target = await getThreadStub(threadId);
  // Reject early for unsupported platforms — see requireAdapter. Without
  // this, scanQueue.syncThread → adapter.fetchThreadMessages crashes with
  // a confusing "Cannot read properties of undefined" TypeError.
  requireAdapter(target.platform);
  const requestId = getControlTrace(res)?.requestId ?? uuid();
  const settings = await settingsStore.getSettings();
  if (!settings.enabledPlatforms.includes(target.platform)) {
    res.status(409).json({ error: "This message source is not selected in Settings.", reason: "platform_not_selected" });
    return;
  }
  const shouldContinue = scanQueue.createContinueGate();

  // For iMessage we render one row per Person but chat.db may have several
  // chats with that human (phone + email). Rescanning ONLY the canonical
  // thread leaves the sibling rows stale, which the operator perceives as
  // "the rescan messed it up". So for iMessage we walk every sibling
  // thread of the same Person and refresh each.
  const targets =
    target.platform === "IMESSAGE"
      ? await prisma.thread.findMany({
          where: { platform: target.platform, personId: target.personId },
          select: {
            id: true,
            platformThreadId: true,
            threadUrl: true,
            recipientVerificationLabel: true,
            person: { select: { displayName: true } }
          }
        })
      : [{
          id: target.threadId,
          platformThreadId: target.platformThreadId,
          threadUrl: target.threadUrl,
          recipientVerificationLabel: target.recipientVerificationLabel,
          person: { displayName: target.displayName }
        }];

  // Per-thread rescan: open ONLY this thread and re-parse its messages,
  // instead of triggering a full-inbox scan via enqueueScan(). The full-
  // inbox path takes 30-90s on a populated inbox; opening one thread is
  // typically <5s. Wraps in the platform control lock so it serialises
  // against any in-flight scan / send / open-thread operation.
  // Emit scoped progress events keyed on threadId. The TopStatus ticker
  // surfaces these as "Checking <name>'s messages" — ongoing work belongs
  // in the ticker, not the thread header (the thread page only uses the
  // events to guard against double-clicks and refresh on finish).
  // personName rides along so the ticker can name the contact without a
  // /data/thread round-trip.
  eventBus.emit({
    type: "SCAN_THREAD_STARTED",
    jobId: requestId,
    threadId: target.threadId,
    platform: target.platform,
    personName: target.displayName
  });
  try {
    const result = await platformSelectionCoordinator.withSelectedPlatform(target.platform, async () => {
      const aggregate = {
        updatedThreads: 0,
        parsedMessages: 0,
        persistedMessages: 0,
        quarantinedMessages: 0,
        newMessages: 0,
        freshnessComplete: true
      };
      eventBus.emit({
        type: "SCAN_THREAD_PROGRESS",
        jobId: requestId,
        threadId: target.threadId,
        platform: target.platform,
        stage: targets.length > 1 ? "Reading sibling threads" : "Reading messages",
        personName: target.displayName
      });
      // Message-count delta across the whole sibling cohort = "did this
      // check find anything new". parsedMessages can't answer that — it
      // counts every message re-parsed, new or not. Counted inside the
      // lock so a concurrent scan can't skew the baseline.
      const targetIds = targets.map((t) => t.id);
      const messagesBefore = await prisma.message.count({ where: { threadId: { in: targetIds } } });
      for (const t of targets) {
        if (!shouldContinue()) break;
        const candidate: ThreadStub = {
          platformThreadId: t.platformThreadId,
          displayName: t.person.displayName,
          recipientVerificationLabel: t.recipientVerificationLabel ?? undefined,
          threadUrl: t.threadUrl ?? undefined,
          lastMessagePreview: ""
        };
        const partial = await scanQueue.syncThreadForIngest({
          platform: target.platform,
          candidate,
          maxMessages: settings.maxMessagesPerThread,
          requestId,
          shouldContinue
        });
        aggregate.updatedThreads += partial.updatedThreads ?? 0;
        aggregate.parsedMessages += partial.parsedMessages ?? 0;
        aggregate.persistedMessages += partial.persistedMessages ?? 0;
        aggregate.quarantinedMessages += partial.quarantinedMessages ?? 0;
      }
      eventBus.emit({
        type: "SCAN_THREAD_PROGRESS",
        jobId: requestId,
        threadId: target.threadId,
        platform: target.platform,
        stage: "Saving updates",
        personName: target.displayName
      });
      const messagesAfter = await prisma.message.count({ where: { threadId: { in: targetIds } } });
      aggregate.newMessages = Math.max(0, messagesAfter - messagesBefore);
      aggregate.freshnessComplete = aggregate.quarantinedMessages === 0;
      return aggregate;
    });
    eventBus.emit({
      type: "SCAN_THREAD_FINISHED",
      jobId: requestId,
      threadId: target.threadId,
      platform: target.platform,
      updatedThreads: result.updatedThreads,
      parsedMessages: result.parsedMessages,
      personName: target.displayName,
      newMessages: result.newMessages,
      freshnessComplete: result.freshnessComplete
    });
    await auditService.log({
      platform: target.platform,
      stage: "Scan",
      action: "RESCAN_THREAD",
      status: result.freshnessComplete ? "OK" : "FAIL",
      details: {
        requestId,
        threadId: target.threadId,
        platformThreadId: target.platformThreadId,
        scope: "single_thread",
        ...result
      }
    });
    const responseBody = {
      ok: result.freshnessComplete,
      requestId,
      threadId: target.threadId,
      scope: "single_thread",
      warning: result.freshnessComplete ? undefined : MESSAGE_IDENTITY_FRESHNESS_ERROR,
      ...result
    };
    if (!result.freshnessComplete) {
      res.status(409).json({
        ...responseBody,
        error: "Message check incomplete. Some historical messages could not be verified safely."
      });
      return;
    }
    res.json(responseBody);
  } catch (error) {
    eventBus.emit({
      type: "SCAN_THREAD_FINISHED",
      jobId: requestId,
      threadId: target.threadId,
      platform: target.platform,
      updatedThreads: 0,
      parsedMessages: 0,
      personName: target.displayName,
      // No newMessages and failed:true — the ticker must not render a
      // confident "No new messages from X" for a check that errored.
      failed: true
    });
    if (error instanceof PlatformNotSelectedError) {
      await auditService.log({
        platform: target.platform,
        stage: "Scan",
        action: "RESCAN_THREAD_CANCELLED",
        status: "OK",
        details: {
          requestId,
          threadId: target.threadId,
          reason: "platform_not_selected"
        }
      });
      res.status(409).json({
        error: "This message source is no longer selected in Settings.",
        reason: "platform_not_selected"
      });
      return;
    }
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

// Resummarize a thread end-to-end: fetch + AI call + persist. Returns
// false if the thread was missing. Called from the /data/thread
// self-heal path when a stored summary still matches the fallback
// updateThreadSummary writes on AI failure (no API key / quota /
// model error).
// Thin wrapper over services/resummarize-thread.ts. The pipeline (and the
// issue #385 transcript-refresh clearing wired into the summary write) lives
// there so it is testable without booting Express. `race` opts two AI
// providers into the cross-provider race; only operator-initiated paths
// (Reassess) set it — it doubles provider spend per raced call.
async function resummarizeThreadById(
  threadId: string,
  options?: { race?: boolean }
): Promise<
  | { ok: true; summary: string; whatTheyWant: string; openLoops: string[]; needsReply: boolean }
  // `ai_unavailable` joins `not_found` when the AI call returned the fallback
  // (every provider failed) — resummarizeThread skips the write in that case.
  // Both the /data/thread self-heal and the Reassess endpoint already branch on
  // `ok` alone, so this is purely a wider failure tag, not new control flow.
  | { ok: false; reason: "not_found" | "ai_unavailable" }
> {
  // Redirect the WRITE to the canonical sibling so AI fields land on the row
  // the readers (/data/thread) source from. Without this, a send-side reassess
  // (reassess-on-send) or the stale-summary self-heal — both of which fire on
  // whatever row the caller passed — write the fresh brief/summary onto a
  // dormant iMessage sibling while the rail reads the live one, so the operator
  // sees nothing change. runReassessForThread already pre-resolves canonical;
  // resolving again here is idempotent (canonical-of-canonical is itself).
  // Non-iMessage / single-sibling threads resolve to `threadId` unchanged.
  const writeTargetId = await resolveCanonicalWriteTargetId(threadId);
  return resummarizeThread({ prisma, aiService, siblingThreadIds }, writeTargetId, options);
}

// Resolve the canonical sibling id an AI-field write should target for a given
// requested thread, mirroring /data/thread's resolution. Only IMESSAGE Persons
// with >1 handle-sibling are redirected; everything else short-circuits to the
// requested id with no extra query.
async function resolveCanonicalWriteTargetId(threadId: string): Promise<string> {
  const requested = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true, platform: true, personId: true }
  });
  if (!requested || requested.platform !== "IMESSAGE") return threadId;
  const siblingRows = await prisma.thread.findMany({
    where: { platform: requested.platform, personId: requested.personId },
    select: { id: true, lastInboundAt: true, _count: { select: { messages: true } } }
  });
  return canonicalWriteTargetId(
    threadId,
    requested.platform,
    siblingRows.map((row) => ({
      id: row.id,
      lastInboundAt: row.lastInboundAt,
      messageCount: row._count?.messages ?? 0
    }))
  );
}

// On-demand transcription for a single message. Used by the thread UI's
// "Transcribe voice message" affordance under untranscribed voice notes:
// the operator can spend a single OpenAI call without waiting for the
// next scan to re-persist the row. Fingerprint dedup still applies (a
// repeat click returns the existing row's status rather than billing
// twice).
app.post("/control/message/:messageId/transcribe", asyncRoute(async (req, res) => {
  const { messageId } = z.object({ messageId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { action: "transcribe a voice message", kind: "external-action" })) return;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { thread: { select: { platform: true } } }
  });
  if (!message) {
    res.status(404).json({ ok: false, reason: "missing_message", message: "Message not found." });
    return;
  }
  const platform = message.thread.platform;

  // Manual clicks always force a fresh attempt. Auto-scan keeps
  // fingerprint dedup; the operator's deliberate "Try again" should
  // re-check the disk state (e.g. when a missing_file row was written
  // before iCloud finished downloading the audio).
  const outcome = await platformSelectionCoordinator.withSelectedPlatform(
    platform,
    () => transcriptionService.transcribeMessage(messageId, {
      force: true,
      shouldContinue: () => platformSelectionAllowsNewWork(platform)
    })
  );

  if (outcome.kind === "disabled") {
    res.status(409).json({
      ok: false,
      reason: "disabled",
      message:
        "Audio transcription is off. Set AUDIO_TRANSCRIPTION_ENABLED=true with a valid OPENAI_API_KEY in the runner config."
    });
    return;
  }
  if (outcome.kind === "no_audio") {
    res.status(422).json({
      ok: false,
      reason: "no_audio",
      message: "This message has no voice or audio attachment."
    });
    return;
  }
  if (outcome.kind === "missing_message") {
    res.status(404).json({ ok: false, reason: "missing_message", message: "Message not found." });
    return;
  }

  // outcome.kind === "processed": fingerprint dedup may have skipped the
  // call even on a fresh request (existing row). Read the row back so the
  // response always reflects what's currently persisted.
  const row = await prisma.messageAudioTranscription.findUnique({
    where: { messageId },
    select: {
      status: true,
      transcript: true,
      provider: true,
      model: true,
      language: true,
      durationSeconds: true,
      errorMessage: true,
      // Progressive bookkeeping: lets the on-demand "Try again" UI
      // path render the same Improving transcript... hint as the
      // initial scan path without a second round-trip.
      selectedTier: true,
      selectedModel: true,
      selectedProvider: true,
      refinementModel: true,
      refinementConfidence: true,
      updatedAt: true
    }
  });

  // Surface the truth-based pending-tiers map on the response so the
  // dashboard immediately renders the right "Improving transcript..."
  // state without a follow-up poll.
  const isImproving = transcriptionService
    .getPendingTiers(messageId)
    .some((t) => t === "standard" || t === "max" || t === "refinement");
  res.json({
    ok: true,
    counts: {
      attachments: outcome.attachments,
      transcribed: outcome.ok,
      failed: outcome.failed,
      skipped: outcome.skipped
    },
    transcription: row ? { ...row, isImproving } : null
  });
}));

// #462 (pilot R-0061): does the runner have a transcription provider wired
// up? The composer reads this once to decide whether to enable the Dictate
// control (vs. show it disabled with an explanation).
app.get("/data/transcription-capabilities", asyncRoute(async (_req, res) => {
  res.json({
    dictationAvailable: pickDictationProvider() !== null,
    dictationUploadMode: process.platform === "darwin" ? "native-audio" : "wav"
  });
}));

// #462 (pilot R-0061): transcribe a one-shot dictation clip into text. Posts
// a single `audio` field (multipart); returns { ok, text }. Nothing is
// persisted — the operator reviews/edits the text in the composer before any
// send. The temp upload is always cleaned up.
app.post(
  "/control/transcribe-dictation",
  (req, res, next) =>
    uploadDictation(req, res, (err: unknown) => {
      if (err) {
        const uploadDir = (req as express.Request & { dictationUploadDir?: string }).dictationUploadDir;
        if (uploadDir) {
          try {
            rmSync(uploadDir, { recursive: true, force: true });
          } catch {}
        }
        res
          .status(400)
          .json({ ok: false, error: err instanceof Error ? err.message : "Upload failed." });
        return;
      }
      next();
    }),
  asyncRoute(async (req, res) => {
    const file = req.file as Express.Multer.File | undefined;
    const uploadDir = (req as express.Request & { dictationUploadDir?: string }).dictationUploadDir;
    const cleanup = () => {
      if (uploadDir || file) {
        try {
          rmSync(uploadDir || file!.destination, { recursive: true, force: true });
        } catch {
          /* best-effort temp cleanup */
        }
      }
    };
    if (!file) {
      res.status(400).json({ ok: false, error: "No audio uploaded." });
      return;
    }
    const provider = pickDictationProvider();
    if (!provider) {
      cleanup();
      res.status(503).json({
        ok: false,
        reason: "unavailable",
        error:
          "Voice transcription is not configured on the runner. Enable AUDIO_TRANSCRIPTION_ENABLED (local Whisper or OpenAI) to use dictation."
      });
      return;
    }
    try {
      const wavPath = await convertAudioToWhisperWav(file.path);
      if (wavPath) {
        try {
          if (!hasAudibleSpeechSignal(readAudioSignalSummary(wavPath))) {
            res.status(422).json({
              ok: false,
              reason: "no_speech",
              error: "The microphone did not capture clear speech. Check the selected microphone and try again."
            });
            return;
          }
        } catch {
          res.status(422).json({
            ok: false,
            reason: "invalid_audio",
            error: "The recording could not be read. Try recording it again."
          });
          return;
        }
      }
      const outcome = await provider.transcribe({
        filePath: file.path,
        mimeType: file.mimetype || "audio/webm",
        filename: file.originalname || "dictation.webm",
        language: runnerConfig.audioTranscription.language,
        // local-whisper ignores this (model is baked into the provider);
        // the OpenAI provider uses it as the audio model id.
        model: runnerConfig.audioTranscription.model
      });
      if (outcome.kind === "ok") {
        res.json({ ok: true, text: outcome.result.text });
      } else if (outcome.kind === "skipped") {
        res.status(422).json({ ok: false, reason: "skipped", error: outcome.reason });
      } else {
        res.status(502).json({ ok: false, reason: "failed", error: outcome.errorMessage });
      }
    } finally {
      cleanup();
    }
  })
);

app.post("/control/thread/:threadId/format-dictation-messages", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (
    await checkPresenterGuard(res, settingsStore, {
      threadId,
      action: "turn a transcript into messages",
      kind: "thread-mutation"
    })
  ) return;
  const { transcript } = z
    .object({ transcript: z.string().trim().min(1).max(12_000) })
    .strict()
    .parse(req.body);
  const [thread, operatorProfile, acceptedExamples] = await Promise.all([
    prisma.thread.findUnique({
      where: { id: threadId },
      select: {
        person: { select: { displayName: true } },
        messages: {
          orderBy: { timestamp: "desc" },
          take: 8,
          select: { direction: true, text: true }
        }
      }
    }),
    settingsStore.getOperatorProfile(),
    loadDictationMessageExamples()
  ]);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  const nearbyInbound = thread.messages.filter((message) => message.direction === "IN");
  const totalInboundCharacters = nearbyInbound.reduce(
    (total, message) => total + message.text.trim().length,
    0
  );
  const result = await aiService.formatDictationMessages({
    transcript,
    contactName: thread.person.displayName,
    operatorProfile: {
      displayName: operatorProfile.displayName,
      about: operatorProfile.about,
      preferredStyle: operatorProfile.preferredStyle,
      commonPhrases: operatorProfile.commonPhrases,
      avoidedPhrases: operatorProfile.avoidedPhrases,
      acceptedExamples
    },
    recentInbound: {
      messageCount: nearbyInbound.length,
      totalCharacters: totalInboundCharacters,
      averageCharacters: nearbyInbound.length
        ? Math.round(totalInboundCharacters / nearbyInbound.length)
        : 0
    }
  });
  if (!result) {
    res.status(502).json({ error: "Could not turn this transcript into messages. Your transcript is still safe." });
    return;
  }
  res.json(result);
}));

app.post("/control/thread/:threadId/dictation-message-example", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (
    await checkPresenterGuard(res, settingsStore, {
      threadId,
      action: "save a dictation voice example",
      kind: "thread-mutation"
    })
  ) return;
  const { messages } = z
    .object({
      messages: z.array(z.string().trim().min(1).max(4_000)).min(1).max(40)
    })
    .strict()
    .parse(req.body);
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true }
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  await rememberDictationMessageExample(messages);
  res.json({ ok: true });
}));

// Issue #331. Reads the operator's in-flight draft against the thread's
// active open loops and returns the subset the draft already addresses.
// The dashboard debounces calls here while the operator types so the
// reply checklist can auto-tick covered items. Caps the draft at 5k chars
// before validation so a runaway paste never burns model tokens.
app.post("/control/thread/:threadId/check-draft", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "check draft coverage", kind: "thread-mutation" })) return;
  const payload = z
    .object({
      draft: z.string().min(1).max(5000)
    })
    .parse(req.body);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: {
        // Tail of the conversation gives the model just enough context
        // to judge whether a short ack actually answers a specific loop.
        orderBy: { timestamp: "desc" },
        take: 8,
        // Audio transcripts flow into the recentMessages context the
        // same way they flow into the summary path, so a draft that
        // answers a voice-only inbound question can auto-tick.
        include: { audioTranscription: true }
      }
    }
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  if (!runnerConfig.availablePlatforms.includes(thread.platform as PlatformName)) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const rawOpenLoops = thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [];
  const dismissed = new Set(
    thread.dismissedOpenLoopsJson ? (JSON.parse(thread.dismissedOpenLoopsJson) as string[]) : []
  );
  // Only check against loops the operator hasn't set aside. Sending
  // dismissed loops to the model would burn tokens on items the user
  // has explicitly opted out of and produces phantom auto-ticks for rows
  // the dashboard no longer renders.
  const openLoops = rawOpenLoops.filter((loop) => !dismissed.has(loop));
  if (openLoops.length === 0) {
    res.json({ items: [] });
    return;
  }

  const recentMessages = [...thread.messages].reverse().map(prismaMessageToPrompt).filter(isAiVisibleMessage);

  const { items } = await aiService.checkDraftCoverage({
    displayName: thread.person.displayName,
    draft: payload.draft,
    openLoops,
    recentMessages
  });

  res.json({ items });
}));

// "Tell the AI what you want to say, get it back in your voice."
// The operator types a brief intent (a sentence or two) and gets back
// a sendable draft calibrated to how they've previously written on
// this thread. Used by the dashboard's Compose card on the thread
// page when the suggested replies don't fit.
app.post("/control/thread/:threadId/compose", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "compose a reply", kind: "thread-mutation" })) return;
  const payload = z.object({ intent: z.string().min(1).max(2000) }).parse(req.body);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: {
        // Most RECENT 80, made chronological by the reverse below. An
        // asc + take would feed composeInVoice the OLDEST 80 and miss
        // the live conversation on long threads.
        orderBy: { timestamp: "desc" },
        take: 80,
        // Voice-note transcripts must reach composeInVoice. Without this,
        // a contact whose last message is an audio note is rendered to the
        // model as the bare "[Voice note]" placeholder and the draft answers
        // nothing the contact actually said.
        include: { audioTranscription: { select: { status: true, transcript: true } } }
      }
    }
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const orderedMessages = [...thread.messages].reverse();
  const voiceSamples = orderedMessages
    .filter((m) => m.direction === "OUT")
    .map((m) => m.text);

  // Writing-style profiles (issue #299) — so the rewrite matches how the
  // operator and contact actually write to each other, not only the
  // generic voice tier.
  const operatorStyle = analyzeStyle(voiceSamples);
  const contactStyle = analyzeStyle(
    orderedMessages.filter((m) => m.direction === "IN").map((m) => m.text)
  );

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
    tags: safeJsonParse<string[]>(thread.person.tagsJson, [])
  };

  const [composeOperatorProfile, composeContactSnapshot] = await Promise.all([
    settingsStore.getOperatorProfile(),
    conversationStartersService.toContactSnapshot(thread.personId, thread.person.displayName)
  ]);

  const text = await aiService.composeInVoice({
    intent: payload.intent,
    platform: thread.platform as PlatformName,
    displayName: thread.person.displayName,
    // #753: group framing - the draft reads naturally to the whole group.
    isGroup: thread.isGroup,
    groupName: thread.groupName ?? null,
    voiceSamples,
    threadMessages: orderedMessages.map(prismaMessageToPrompt),
    relationshipContext,
    operatorProfile: composeOperatorProfile,
    contact: composeContactSnapshot,
    operatorStyle,
    contactStyle
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
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "reassess the thread", kind: "thread-mutation" })) return;

  // Issue #382 / pilot R-0029. runReassessForThread opts both AI
  // calls into the cross-provider race because the operator is
  // staring at a spinner. PM scope: race ONLY this endpoint; do not
  // extend to predrafts, classifiers during scan, or background AI.
  // The orchestration lives in services/reassess-thread.ts so the
  // race wiring is testable without booting Express (see
  // tests/runner-reassess-thread-race.test.mjs).
  const outcome = await runReassessForThread(
    { prisma, aiService, resummarize: resummarizeThreadById, siblingThreadIds },
    threadId
  );
  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  if (outcome.kind === "ai_unavailable") {
    res.status(503).json({
      error: "AI is temporarily unavailable. Nothing was changed."
    });
    return;
  }
  res.json({
    ok: true,
    threadId: outcome.threadId,
    summary: outcome.summary,
    whatTheyWant: outcome.whatTheyWant,
    openLoops: outcome.openLoops,
    category: outcome.category
  });
}));

// Bulk "mark for reassess". Clears the AI output caches on every
// non-archived thread so they regenerate against the current prompts on
// next view / scan. Intended for one-shot use after a prompt change
// ships — the operator clicks this once to invalidate stale briefs and
// predrafts across the whole inbox without paying for an immediate
// fan-out of AI calls.
//
// See apps/runner/src/services/reassess-all.ts for the rationale on
// lazy vs eager invalidation. The dashboard will fall back to the
// synthesised brief for any thread until it's next reassessed/scanned.
app.post(
  "/control/threads/mark-all-for-reassess",
  asyncRoute(async (_req, res) => {
    // No single threadId — this wipes the cached AI brief + predraft on
    // EVERY active thread. The client interceptor only guards a fresh tab
    // that loaded it; a recovered tab (localStorage gone) skips it, so the
    // server is the real boundary. As a thread-mutation with no threadId
    // this is rejected by presenter-readonly (live) and demo-mode-foreign-
    // thread (sandbox), and passes through in normal use.
    if (await checkPresenterGuard(res, settingsStore, { action: "reset all threads for reassessment", kind: "thread-mutation" })) return;
    const { markAllThreadsForReassess } = await import(
      "./services/reassess-all.js"
    );
    const result = await markAllThreadsForReassess(prisma);
    res.json({ ok: true, ...result });
  })
);

app.get("/data/inbox", asyncRoute(async (req, res) => {
  const startedAt = performance.now();
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

  // Serve the last computed response while nothing has changed (see
  // inboxResponseCache above). Polls land every few seconds from multiple
  // components; between data changes they are byte-identical.
  const cacheKey = req.originalUrl;
  const cached = inboxResponseCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    sendCachedInboxResponse(req, res, cached, "hit", startedAt);
    return;
  }
  const versionAtStart = dataVersion;

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const [visibleRows, sentToday, scheduledSends] = await Promise.all([
    loadVisibleThreadRows(archivedView ? { archived: true } : undefined),
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

  const inboxRiskSettings = await settingsStore.getSettings();
  const riskThresholds = { amberHours: inboxRiskSettings.amberHours, redHours: inboxRiskSettings.redHours };
  const visibleCounts = personThreadCounts(visibleRows);
  const dedupedRows = visibleRows.map((row) => {
    const count = visibleCounts.get(personThreadCountKey(row.source.platform, row.source.personId)) ?? 1;
    const shaped = toInboxRow(row, count, riskThresholds);
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
    oldestPendingInboundAt: oldestPending?.lastInboundAt ?? null,
    messagesSentToday: sentToday
  };

  const body = { rows, summary };
  const response = createCompressedJsonCacheEntry(body, Date.now() + INBOX_CACHE_TTL_MS);
  // Only cache if no write/event landed while we were computing — otherwise
  // this response may already be missing that change.
  if (dataVersion === versionAtStart) {
    if (inboxResponseCache.size > 50) {
      inboxResponseCache.clear();
    }
    inboxResponseCache.set(cacheKey, response);
  }
  sendCachedInboxResponse(req, res, response, "miss", startedAt);
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
  if (!runnerConfig.availablePlatforms.includes(thread.platform as PlatformName)) {
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
  //
  // The AI analysis (reply brief, predraft, summary, what-they-want, open
  // loops, remember, category) is persisted per-row, and the FRESH state
  // lives on the sibling still receiving inbound — NOT necessarily the row
  // the operator opened. A dormant high-message-count phone thread can be
  // days behind the email thread the contact now uses, so reading AI fields
  // off the requested row surfaces a stale brief and a predraft answering the
  // old state. While messages merge across all siblings, the AI fields are
  // sourced from the CANONICAL sibling (most-recent inbound, see
  // pickCanonicalThread). Non-iMessage threads are their own canonical row.
  type AiSourceThread = {
    id: string;
    rollingSummary: string | null;
    whatTheyWant: string | null;
    openLoopsJson: string | null;
    toneNotesJson: string | null;
    rememberJson: string | null;
    replyBriefJson: string | null;
    suggestedRepliesJson: string | null;
    suggestedRepliesCacheKey: string | null;
    category: string | null;
  };
  let aiThread: AiSourceThread = thread;
  let siblingIds: string[] = [thread.id];
  if (thread.platform === "IMESSAGE") {
    const siblingRows = await prisma.thread.findMany({
      where: { platform: thread.platform, personId: thread.personId },
      select: {
        id: true,
        lastInboundAt: true,
        rollingSummary: true,
        whatTheyWant: true,
        openLoopsJson: true,
        toneNotesJson: true,
        rememberJson: true,
        replyBriefJson: true,
        suggestedRepliesJson: true,
        suggestedRepliesCacheKey: true,
        category: true,
        _count: { select: { messages: true } }
      }
    });
    siblingIds = siblingRows.map((row) => row.id);
    const canonical = pickCanonicalThread(
      siblingRows.map((row) => ({ ...row, messageCount: row._count?.messages ?? 0 }))
    );
    if (canonical) {
      aiThread = canonical;
    }
  }
  const messageThreadFilter = { threadId: { in: siblingIds } };
  // Style sample (issue #299) — newest messages on the thread for the
  // writing-style analysis. A dedicated fixed-size window so it stays
  // stable regardless of the messagesLimit / beforeMessageId pagination
  // params, which keeps the suggested-replies cache key consistent with
  // the /predraft pre-warm.
  const STYLE_SAMPLE_LIMIT = 40;
  const [messagesDescWithExtra, lastInbound, lastOutbound, styleSampleDesc] = await Promise.all([
    prisma.message.findMany({
      where: messageThreadFilter,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: messageLimit + 1,
      ...(beforeMessageId ? { cursor: { id: beforeMessageId }, skip: 1 } : {}),
      // Voice / audio attachments carry an optional transcript row. The
      // dashboard's IMessageMedia renders a quiet line under the audio
      // control when one exists; the AI context builders inject the
      // transcript into prompts via renderMessageBody.
      include: { audioTranscription: true }
    }),
    prisma.message.findFirst({
      where: { ...messageThreadFilter, direction: "IN" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }]
    }),
    prisma.message.findFirst({
      where: { ...messageThreadFilter, direction: "OUT" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }]
    }),
    prisma.message.findMany({
      where: messageThreadFilter,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: STYLE_SAMPLE_LIMIT,
      select: { direction: true, text: true }
    })
  ]);
  const hasOlderMessages = messagesDescWithExtra.length > messageLimit;
  const pageMessagesDesc = messagesDescWithExtra.slice(0, messageLimit);
  const pageMessages = [...pageMessagesDesc].reverse();
  const olderCursor = hasOlderMessages
    ? pageMessages[0]?.id ?? null
    : null;

  // Reply-parent snippet enrichment. The dashboard's per-message
  // reply-context line previously walked only the loaded window — so a
  // reply to a message from yesterday (or to a parent that lives in a
  // sibling iMessage thread) rendered as the literal "Replying to an
  // earlier message" stub. Resolve the parent server-side instead so
  // each row carries a usable snippet regardless of how far back the
  // parent sits or whether it's in the same Prisma thread.
  //
  // Batched on the in-flight pageMessages so this is one Prisma round
  // trip per /data/thread/:id, not one per bubble.
  const parentGuidsNeeded = new Set<string>();
  const parentIdsNeeded = new Set<string>();
  for (const m of pageMessages) {
    if (m.replyToMessageId) parentIdsNeeded.add(m.replyToMessageId);
    if (m.rawJson) {
      try {
        const raw = JSON.parse(m.rawJson) as { replyToGuid?: string };
        if (typeof raw?.replyToGuid === "string" && raw.replyToGuid.length > 0) {
          parentGuidsNeeded.add(raw.replyToGuid);
        }
      } catch {
        // ignore malformed rawJson
      }
    }
  }
  const siblingScope = messageThreadFilter;
  const [parentsById, parentsByKey] = await Promise.all([
    parentIdsNeeded.size > 0
      ? prisma.message.findMany({
          where: { id: { in: [...parentIdsNeeded] } },
          select: {
            id: true,
            direction: true,
            text: true,
            platformMessageKey: true,
            attachmentsJson: true,
            audioTranscription: { select: { transcript: true, status: true } }
          }
        })
      : Promise.resolve([] as const),
    parentGuidsNeeded.size > 0
      ? prisma.message.findMany({
          where: {
            ...siblingScope,
            platformMessageKey: { in: [...parentGuidsNeeded] }
          },
          select: {
            id: true,
            direction: true,
            text: true,
            platformMessageKey: true,
            attachmentsJson: true,
            audioTranscription: { select: { transcript: true, status: true } }
          }
        })
      : Promise.resolve([] as const)
  ]);
  const parentByMessageId = new Map<string, typeof parentsById[number]>();
  for (const p of parentsById) parentByMessageId.set(p.id, p);
  const parentByPlatformKey = new Map<string, typeof parentsByKey[number]>();
  for (const p of parentsByKey) {
    if (p.platformMessageKey) parentByPlatformKey.set(p.platformMessageKey, p);
  }

  function buildReplyToSnippet(
    parent:
      | (typeof parentsById)[number]
      | (typeof parentsByKey)[number]
      | undefined
  ): { messageId?: string; snippet: string; direction?: "IN" | "OUT" } | null {
    if (!parent) return null;
    const text = (parent.text ?? "").trim();
    const transcript =
      parent.audioTranscription?.status === "transcribed" &&
      parent.audioTranscription.transcript
        ? parent.audioTranscription.transcript.trim()
        : "";
    const SNIPPET_CAP = 120;
    let snippet = "";
    if (transcript) {
      // Prefer the transcript over a "[Voice note]" placeholder so the
      // dashboard sees the actual content the parent carried.
      snippet = transcript.length > SNIPPET_CAP ? `${transcript.slice(0, SNIPPET_CAP)}...` : transcript;
    } else if (text && text !== "[Voice note]" && text !== "[Video]") {
      snippet = text.length > SNIPPET_CAP ? `${text.slice(0, SNIPPET_CAP)}...` : text;
    } else if (parent.attachmentsJson) {
      try {
        const attachments = JSON.parse(parent.attachmentsJson) as Array<{ kind?: string }>;
        const kind = attachments[0]?.kind;
        snippet =
          kind === "voice_note" || kind === "audio"
            ? "Voice message"
            : kind === "video"
              ? "Video"
              : kind === "photo" || kind === "sticker"
                ? "Photo"
                : kind === "pdf"
                  ? "PDF"
                  : "Attachment";
      } catch {
        snippet = "Attachment";
      }
    }
    if (!snippet) snippet = "Earlier message";
    return {
      messageId: parent.id,
      snippet,
      direction: parent.direction as "IN" | "OUT"
    };
  }

  const replyToByChildId = new Map<
    string,
    { messageId?: string; snippet: string; direction?: "IN" | "OUT" } | null
  >();
  for (const m of pageMessages) {
    let parent:
      | (typeof parentsById)[number]
      | (typeof parentsByKey)[number]
      | undefined;
    if (m.replyToMessageId) parent = parentByMessageId.get(m.replyToMessageId);
    if (!parent && m.rawJson) {
      try {
        const raw = JSON.parse(m.rawJson) as { replyToGuid?: string };
        if (raw?.replyToGuid) parent = parentByPlatformKey.get(raw.replyToGuid);
      } catch {
        // ignore
      }
    }
    if (parent) {
      replyToByChildId.set(m.id, buildReplyToSnippet(parent));
      continue;
    }
    // The child cited a parent we couldn't find anywhere in the DB.
    // chat.db sometimes references guids that never landed (the
    // original was unsent, or stored on a device that hasn't synced).
    // Surface a "(deleted or unavailable)" stub so the UI still has
    // something better than the literal "Replying to an earlier
    // message" string.
    const hasReplyPointer =
      Boolean(m.replyToMessageId) ||
      (() => {
        if (!m.rawJson) return false;
        try {
          const raw = JSON.parse(m.rawJson) as { replyToGuid?: string };
          return typeof raw?.replyToGuid === "string" && raw.replyToGuid.length > 0;
        } catch {
          return false;
        }
      })();
    if (hasReplyPointer) {
      replyToByChildId.set(m.id, { snippet: "Earlier message no longer available" });
    }
  }

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
      timestamp: m.timestamp.toISOString(),
      // #753: group turns keep their sender's name in the prompt.
      senderName: m.senderName ?? null,
      audioTranscription: m.audioTranscription
        ? { status: m.audioTranscription.status, transcript: m.audioTranscription.transcript }
        : null
    }));
  // needsReply mirrors scan-queue's derivation: the contact's last message
  // is newer than the operator's. When false, generateSuggestedReplies
  // switches to "reopen mode" — conversation starters grounded in
  // transcript details, not replies to a pending ask.
  const aiNeedsReply = Boolean(
    lastInbound && (!lastOutbound || lastInbound.timestamp > lastOutbound.timestamp)
  );

  // Writing-style profiles (issue #299) measured from the stable style
  // sample — one per speaker direction. Fed into generateSuggestedReplies
  // so suggestions match how the operator and contact actually write.
  const operatorStyle = analyzeStyle(
    styleSampleDesc.filter((m) => m.direction === "OUT").map((m) => m.text)
  );
  const contactStyle = analyzeStyle(
    styleSampleDesc.filter((m) => m.direction === "IN").map((m) => m.text)
  );

  // Parse the persisted reply brief so suggested-replies generation can
  // hand the model the substance bullets (they_said) and obligation read
  // (on_you) the operator will see in the rail. Without this, replies on
  // multi-part inbound (e.g. an answer with several distinct beats —
  // recruiters, interviews, an offer, a constraint) reliably engaged with
  // one beat and ignored the rest, which is the regression this brief
  // expansion is fixing. Older rows have null replyBriefJson — the prompt
  // just omits the brief block in that case.
  const briefForReplies: ReturnType<typeof sanitizeReplyBrief> = (() => {
    if (!aiThread.replyBriefJson) return null;
    try {
      return sanitizeReplyBrief(JSON.parse(aiThread.replyBriefJson));
    } catch {
      return null;
    }
  })();

  const aiInputs = {
    displayName: thread.person.displayName,
    // #753: group framing for reply suggestions.
    isGroup: thread.isGroup,
    groupName: thread.groupName ?? null,
    summary: aiThread.rollingSummary ?? `Conversation with ${thread.person.displayName}.`,
    whatTheyWant: aiThread.whatTheyWant ?? "No clear ask yet.",
    openLoops: safeJsonParse<string[]>(aiThread.openLoopsJson, []),
    recentMessages,
    needsReply: aiNeedsReply,
    // Drives the voice tier (LinkedIn → formal; everything else → casual)
    // so the suggested-reply chips run on the right register, not just
    // the generic SYSTEM_PROMPT.
    platform: thread.platform as PlatformName,
    // Drives the "Polite decline" reply variant when the thread is outreach.
    category: (aiThread.category ?? null) as "outreach" | "genuine" | null,
    // Late-reply detection: when the last inbound is much older than the
    // most recent outbound (or there's no outbound yet) the prompt asks
    // the model to acknowledge the gap. Day-bucketed ISO is enough for
    // the cache key — minute-precision would invalidate replies every
    // few minutes for no reason.
    lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
    lastOutboundAt: lastOutbound?.timestamp.toISOString() ?? null,
    operatorProfile,
    contact: contactSnapshot,
    operatorStyle,
    contactStyle,
    replyBrief: briefForReplies
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
  // Brief signature folds in the substance bullets + obligation read +
  // required points the model now sees in the prompt. Downstream of
  // summary/whatTheyWant (regenerated by the same updateThreadSummary
  // call), so it only invalidates when brief content actually shifts —
  // typically when a new turn arrives. v5 bumped existing v4 rows once
  // so they pick up brief-aware replies; v6 bumps v5 rows so they pick
  // up the IDENTITY / NO FABRICATED REASONS predraft disciplines (the
  // prompt text itself is not part of the key, so prompt-rule changes
  // need a version bump to reach already-cached replies).
  const briefSignature = briefSignatureForCache(briefForReplies);
  const cacheKey = createHash("sha256")
    .update(`v6|${aiInputs.summary}|${aiInputs.whatTheyWant}|${aiInputs.openLoops.join("")}|${aiInputs.needsReply ? 1 : 0}|${recentSignature}|${aiInputs.category ?? "_"}|${lateBucket}|${operatorProfileFingerprint(operatorProfile)}|${contactSnapshotFingerprint(contactSnapshot)}|${thread.platform}|${styleFingerprint(operatorStyle, contactStyle)}|${briefSignature}`)
    .digest("hex");

  let suggested: SuggestedRepliesOutput | undefined;
  let suggestedRepliesStatus: "ready" | "generating" = "ready";
  // On a paginated (older-history) fetch, recentMessages is an older window,
  // so the recomputed cacheKey can never match the live one. Serve the
  // persisted replies as-is and never regenerate/persist — otherwise
  // scrolling up regenerates suggestions from stale context and clobbers the
  // live cache (wasted AI spend + flapping suggestions on the next fetch).
  const servePersistedOnly = Boolean(beforeMessageId);
  if ((servePersistedOnly || aiThread.suggestedRepliesCacheKey === cacheKey) && aiThread.suggestedRepliesJson) {
    try {
      suggested = JSON.parse(aiThread.suggestedRepliesJson);
    } catch {
      // Corrupt cache row — fall through and regenerate.
      suggested = undefined;
    }
  }
  if (!suggested) {
    const inFlightKey = `${thread.id}:${cacheKey}`;
    if (!servePersistedOnly && !suggestedRepliesInFlight.has(inFlightKey)) {
      const inFlight = withInFlightTimeout(
        aiService.generateSuggestedReplies(aiInputs),
        `generateSuggestedReplies(${thread.id})`
      )
        .then(async (generated) => {
          // Persist to the CANONICAL sibling (aiThread) so the next read —
          // from any sibling — finds these replies under the same cache key.
          // The SSE event still carries the REQUESTED thread.id so the view
          // the operator has open refetches.
          await prisma.thread.update({
            where: { id: aiThread.id },
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
              where: { id: aiThread.id },
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

  // Per-thread receipts via the indexed AuditLog.threadId column (mirrored
  // from details.threadId at write time). The old `detailsJson LIKE
  // '%threadId%'` arm had to walk the whole recent audit window per open -
  // on an active runner that's the entire table (~25k rows/day), so a
  // thread with sparse receipts cost up to ~800ms PER OPEN while a busy one
  // cost 10ms. Two separate fully-indexed reads merged in JS: a single
  // `timestamp >= ? AND (... OR ...)` query defeats SQLite's OR-by-union
  // optimisation, and ORDER BY+LIMIT biases the planner into an ordered
  // filter-scan of the whole recent window (measured ~800ms either way).
  // Rows written before the column existed don't match and quietly age out
  // of the drawer.
  const receiptsSince = new Date(Date.now() - RECEIPTS_LOOKBACK_MS);
  const RECEIPTS_LIMIT = 120;
  const [threadReceipts, selectorReceipts] = await Promise.all([
    prisma.auditLog.findMany({
      where: { threadId: thread.id, timestamp: { gte: receiptsSince } },
      orderBy: { timestamp: "desc" },
      take: RECEIPTS_LIMIT
    }),
    prisma.auditLog.findMany({
      where: {
        action: { in: ["SELECTOR_TEST", "SELECTOR_FAIL"] },
        platform: thread.platform,
        timestamp: { gte: receiptsSince }
      },
      orderBy: { timestamp: "desc" },
      take: RECEIPTS_LIMIT
    })
  ]);
  const receipts = [...threadReceipts, ...selectorReceipts]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, RECEIPTS_LIMIT);

  // Surfaced so the thread page can render scheduled sends as pinned pills
  // above the timeline without a second fetch. Only SCHEDULED rows leak
  // here — PENDING/SENT/FAILED already drive the live optimistic-UI flow.
  const scheduledSendRows = await prisma.sendRequest.findMany({
    where: { threadId: { in: siblingIds }, status: "SCHEDULED" },
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
    tags: safeJsonParse<string[]>(thread.person.tagsJson, [])
  };

  // Reply Brief surface. Persisted as JSON on the Thread row; older rows
  // (pre-feature) carry null. In that case, synthesise a safe fallback
  // from the legacy fields so the dashboard rail always has something
  // grounded to render. The real brief regenerates on next scan /
  // Reassess / stale-summary self-heal.
  const persistedOpenLoops: string[] = safeJsonParse<string[]>(aiThread.openLoopsJson, []);
  let parsedReplyBrief: ReturnType<typeof sanitizeReplyBrief> = null;
  if (aiThread.replyBriefJson) {
    try {
      parsedReplyBrief = sanitizeReplyBrief(JSON.parse(aiThread.replyBriefJson));
    } catch {
      parsedReplyBrief = null;
    }
  }
  const replyBriefResponse =
    parsedReplyBrief ??
    synthesiseFallbackBrief({
      rollingSummary: aiThread.rollingSummary ?? "",
      whatTheyWant: aiThread.whatTheyWant ?? "",
      openLoops: persistedOpenLoops,
      // Derived from the MERGED last inbound/outbound (aiNeedsReply), not the
      // requested row's stored flag, so a split iMessage thread's fallback
      // brief reflects the live conversation.
      needsReply: aiNeedsReply,
      latestInboundText: lastInbound?.text ?? null
    });

  // Recompute risk live from the thread's timestamps + current thresholds,
  // mirroring the inbox shaper, so the thread page's risk pill never disagrees
  // with the list (risk ages amber -> red with the clock; the persisted value
  // is frozen at the last scan).
  const threadRiskSettings = await settingsStore.getSettings();
  const liveThreadRisk = calculateRisk({
    // Use the MERGED last inbound/outbound across siblings (the same values
    // aiNeedsReply and the fallback brief derive from) rather than the
    // requested row's frozen columns, so the risk pill, the reopen framing,
    // and the suggested replies all agree on a split iMessage conversation.
    lastInboundAt: lastInbound?.timestamp ?? thread.lastInboundAt,
    lastOutboundAt: lastOutbound?.timestamp ?? thread.lastOutboundAt,
    amberHours: threadRiskSettings.amberHours,
    redHours: threadRiskSettings.redHours
  });

  res.json({
    id: thread.id,
    personId: thread.person.id,
    personName: thread.person.displayName,
    personAvatarUrl: thread.person.avatarUrl ?? null,
    // R-0066 / #483. Whether the operator has favourited this contact, so the
    // thread header can render (and toggle) the favourite star in the right
    // state on open.
    personFavourite: thread.person.favouritedAt != null,
    // Issue #412. Carry the contact's birthday into the thread page so
    // the rail can show a "🎂 birthday in N days" pill when it's
    // within the next month. The 14-day horizon constant is reused
    // from the inbox row; the thread page renders a wider 30-day
    // window because the operator opened this specific thread —
    // anything birthday-relevant in the next month is worth surfacing.
    personBirthday: thread.person.birthday ?? null,
    personBirthYear: thread.person.birthYear ?? null,
    // #753: authoritative group flag + name from the Thread row, so the
    // dashboard stops inferring group-ness from distinct sender names.
    isGroup: thread.isGroup,
    groupName: thread.groupName ?? null,
    platform: thread.platform,
    category: (thread.category as "outreach" | "genuine" | null) ?? null,
    // Sibling cohort for this Person (iMessage phone + email handle rows; a
    // single-element [thread.id] for everything else). The thread page matches
    // SSE THREAD_UPDATED / SUGGESTED_REPLIES_UPDATED / SCAN_THREAD_* events on
    // this cohort, so a new inbound that lands on the OTHER handle refetches
    // the open view even though its event carries the sibling's id.
    siblingIds,
    riskLevel: liveThreadRisk.level,
    riskReason: liveThreadRisk.riskReason,
    snoozedUntil: thread.snoozedUntil?.toISOString() ?? null,
    // #776: whether this thread is archived, so the header can offer
    // Unarchive instead of Archive when the operator opens an archived
    // conversation.
    archivedAt: thread.archivedAt?.toISOString() ?? null,
    // Issue #392. Operator-supplied "remind me to…" text. Surfaces as
    // a "Reminder: <text>" banner on the thread page so the operator
    // remembers WHY the thread was snoozed when it returns.
    reminderText: thread.reminderText ?? null,
    unreadCount: thread.unreadCount,
    needsReply: thread.needsReply,
    // AI-analysis fields come from the CANONICAL sibling (aiThread), so a
    // split iMessage conversation shows the live brief/summary/what-they-want
    // rather than a dormant sibling's stale state. dismissedOpenLoops stays on
    // the requested row (it pairs with the per-row dismiss write path).
    summary: aiThread.rollingSummary,
    whatTheyWant: aiThread.whatTheyWant,
    openLoops: filterDismissedOpenLoops(
      persistedOpenLoops,
      thread.dismissedOpenLoopsJson
    ),
    dismissedOpenLoops: safeJsonParse<string[]>(thread.dismissedOpenLoopsJson, []),
    toneNotes: safeJsonParse<string[]>(aiThread.toneNotesJson, []),
    remember: safeJsonParse<RememberItem[]>(aiThread.rememberJson, []),
    replyBrief: replyBriefResponse,
    draft: thread.drafts[0]?.text ?? "",
    draftUpdatedAt: thread.drafts[0]?.updatedAt.toISOString() ?? null,
    contextUpdatedAt: thread.updatedAt.toISOString(),
    relationshipMemory,
    messages: pageMessages
      // Hide iMessage "kept an audio message" system events from the
      // thread view entirely. The iMessage adapter drops these at
      // ingestion going forward; this filter takes care of any
      // historical rows already persisted.
      .filter((message) => !isNonContentIMessageSystemEvent(message.text))
      .map((message) => ({
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
      // safeJsonParse, not bare JSON.parse: this runs per-message inside the
      // .map, so one corrupt rawJson/attachmentsJson row would otherwise throw
      // and 500 the entire thread view (the most common read path).
      raw: safeJsonParse<unknown>(message.rawJson, null),
      attachments: safeJsonParse<unknown[]>(message.attachmentsJson, []),
      // Audio transcription status + text, when the runner ran one for
      // this message. Null when the message has no audio attachment or
      // transcription is disabled. The dashboard's IMessageMedia uses
      // this to render a quiet transcript line under the audio control.
      audioTranscription: message.audioTranscription
        ? {
            status: message.audioTranscription.status,
            transcript: message.audioTranscription.transcript,
            errorMessage: message.audioTranscription.errorMessage,
            // Progressive transcription bookkeeping. `selectedTier`
            // tells the UI which tier produced the visible text;
            // `refinementConfidence` drives the optional "Refined
            // from local transcript" tooltip when GPT-5-nano
            // refinement was applied.
            selectedTier:
              (message.audioTranscription as { selectedTier?: string | null }).selectedTier ?? null,
            refinementConfidence:
              (message.audioTranscription as { refinementConfidence?: string | null })
                .refinementConfidence ?? null,
            // Truth-based: only true when a higher-tier task is
            // ACTUALLY queued/running. Derived from the service's
            // in-memory `pendingTiersByMessage` map, not a time
            // heuristic — so the moment the queue finishes (or fast
            // fails and no upgrade was queued), the dashboard hides
            // the "Improving transcript..." line.
            isImproving: transcriptionService
              .getPendingTiers(message.id)
              .some((t) => t === "standard" || t === "max" || t === "refinement")
          }
        : null,
      // Server-resolved snippet of the parent this message replies to.
      // Resolves across sibling iMessage threads and outside the loaded
      // window, so the dashboard never falls back to the literal
      // "Replying to an earlier message" string for a parent that
      // actually exists in the DB. `null` when this message has no
      // reply pointer at all. See enrichment block above.
      replyTo: replyToByChildId.get(message.id) ?? null
    })),
    messagePage: {
      hasOlder: hasOlderMessages,
      olderCursor,
      limit: messageLimit
    },
    suggestedReplies: suggested,
    suggestedRepliesStatus,
    scheduledSends: scheduledSendRows.map((row) => ({
      attachments: safeJsonParse<Array<Record<string, unknown>>>(
        row.attachmentsJson,
        []
      ).flatMap((attachment) =>
        typeof attachment.displayName === "string"
          ? [{
              displayName: attachment.displayName,
              kind: typeof attachment.kind === "string" ? attachment.kind : null,
              mimeType:
                typeof attachment.mimeType === "string" ? attachment.mimeType : null
            }]
          : []
      ),
      clientSendId: row.clientSendId,
      replyToMessageId: row.replyToMessageId,
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
  const [platforms, settings] = await Promise.all([
    prisma.platform.findMany({ orderBy: { name: "asc" } }),
    settingsStore.getSettings()
  ]);
  const platformsForDisplay = runnerConfig.availablePlatforms;
  const failureActions = ["SCAN_FAIL", "SELECTOR_FAIL", "SCAN_AUTH_REQUIRED"] as const;
  const recoveryActions = ["SCAN_END", "SELECTOR_TEST", "POST_SCAN_END", "POST_PLATFORM_TEST_SELECTORS_END"] as const;

  const data = await Promise.all(
    platformsForDisplay.map(async (platform) => {
      const row = platforms.find((entry) => entry.name === platform);
      const supported = true;
      const profileDir = resolvePlatformSession(platform).profileDir;
      const browserProfileDetails = platformBrowserProfileDetails(platform, profileDir);
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
        status: effectivePlatformStatus(platform, row?.status, whatsappConnect.state),
        lastScanAt: row?.lastScanAt?.toISOString() ?? null,
        connectedAt: row?.connectedAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        enabled: isPlatformEnabled(settings.enabledPlatforms, platform),
        supported,
        unavailableReason:
          supported ? null : "iMessage is only available on macOS.",
        runnerProcess: platform === "IMESSAGE" ? runnerProcessInfo : undefined,
        profileDir,
        browserProfileMode: browserProfileDetails.profileMode,
        browserProfileSyncMode:
          browserProfileDetails.profileMode === "personal"
            ? browserProfileDetails.syncMode
            : null,
        browserProfileSourceUserDataDir: browserProfileDetails.sourceUserDataDir,
        browserProfileLaunchUserDataDir: browserProfileDetails.launchUserDataDir,
        browserProfileDirectory: browserProfileDetails.profileDirectory,
        browserProfileName: browserProfileDetails.profileName,
        browserProfileResolutionStrategy:
          browserProfileDetails.profileResolutionStrategy,
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
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 1000) : 200;
  const logs = await prisma.auditLog.findMany({
    where: { OR: [{ platform: null }, { platform: { in: runnerConfig.availablePlatforms } }] },
    orderBy: { timestamp: "desc" },
    take: limit
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
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "archive", kind: "thread-mutation" })) return;
  const archivedAt = new Date();
  const targetIds = await actionTargetThreadIds(threadId);
  await prisma.thread.updateMany({
    where: { id: { in: targetIds } },
    data: { archivedAt }
  });
  res.json({ ok: true, threadId, archivedAt: archivedAt.toISOString() });
}));

// Toggle whether an open-loop string is dismissed for a thread. The dashboard
// thread-pane renders an "Open loops" checklist; ticking persists the loop in
// dismissedOpenLoopsJson so it stays hidden even after the AI re-summarises
// the thread (which keeps emitting the same loop until it's actually closed
// in the conversation).
app.post("/control/thread/:threadId/open-loop", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "edit the reply checklist", kind: "thread-mutation" })) return;
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
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "unarchive", kind: "thread-mutation" })) return;
  const targetIds = await actionTargetThreadIds(threadId);
  await prisma.thread.updateMany({
    where: { id: { in: targetIds } },
    data: { archivedAt: null }
  });
  res.json({ ok: true, threadId });
}));

// Archived view counterpart to /data/inbox — same shape, only archived rows.
app.get("/data/archived", asyncRoute(async (_req, res) => {
  const archivedRows = await loadVisibleThreadRows({ archived: true });
  const archivedRiskSettings = await settingsStore.getSettings();
  const archivedRiskThresholds = { amberHours: archivedRiskSettings.amberHours, redHours: archivedRiskSettings.redHours };
  const archivedCounts = personThreadCounts(archivedRows);
  const rows = archivedRows
    .map((row) => toInboxRow(row, archivedCounts.get(personThreadCountKey(row.source.platform, row.source.personId)) ?? 1, archivedRiskThresholds))
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
      where: {
        status: "PENDING",
        source: { in: QUEUED_MESSAGE_SOURCES },
        thread: { platform: { in: runnerConfig.availablePlatforms } }
      },
      include: {
        thread: {
          include: { person: true }
        }
      },
      orderBy: { createdAt: "asc" }
    }),
    prisma.sendRequest.findMany({
      where: { status: "SCHEDULED", thread: { platform: { in: runnerConfig.availablePlatforms } } },
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
      where: {
        status: { in: ["SENT", "FAILED"] },
        source: { in: QUEUED_MESSAGE_SOURCES },
        thread: { platform: { in: runnerConfig.availablePlatforms } }
      },
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
      const failure = row.status === "FAILED" ? parsePersistedSendFailure(row.errorJson) : null;
      return {
        clientSendId: row.clientSendId,
        threadId: row.threadId,
        personName: row.thread.person.displayName,
        platform: row.thread.platform,
        status: row.status,
        draftConsumed: row.draftConsumed,
        completedAt: row.updatedAt.toISOString(),
        errorMessage: failure?.message,
        errorKind: failure?.errorKind,
        retrySafe: failure?.retrySafe,
        deliveryUncertain: failure?.deliveryUncertain
      };
    })
  });
}));

app.post("/control/message-sync-latency", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      metric: z.enum(MESSAGE_SYNC_METRICS),
      durationMs: z.number().finite().min(0).max(24 * 60 * 60 * 1_000),
      platform: z
        .enum(["LINKEDIN", "INSTAGRAM", "IMESSAGE", "WHATSAPP", "GOOGLE_MESSAGES"])
        .optional(),
      outcome: z.enum(["success", "failure"]).optional()
    })
    .parse(req.body) as {
      metric: MessageSyncMetric;
      durationMs: number;
      platform?: PlatformName;
      outcome?: "success" | "failure";
    };
  messageSyncLatency.record(payload);
  res.json({ status: "recorded" });
}));

app.get("/data/message-sync-latency", (_req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    summary: messageSyncLatency.summary()
  });
});

app.get("/data/send-status/:clientSendId", asyncRoute(async (req, res) => {
  const { clientSendId } = z.object({ clientSendId: z.string().uuid() }).parse(req.params);
  const row = await prisma.sendRequest.findUnique({
    where: { clientSendId },
    select: {
      clientSendId: true,
      threadId: true,
      status: true,
      draftConsumed: true,
      errorJson: true,
      updatedAt: true
    }
  });
  if (!row) {
    res.json({
      clientSendId,
      status: "NOT_FOUND",
      retrySafe: true,
      deliveryUncertain: false
    });
    return;
  }
  const failure =
    row.status === "FAILED" || row.status === "CANCELLED"
      ? parsePersistedSendFailure(row.errorJson)
      : null;
  res.json({
    clientSendId: row.clientSendId,
    threadId: row.threadId,
    status: row.status,
    draftConsumed: row.draftConsumed,
    updatedAt: row.updatedAt.toISOString(),
    errorMessage: failure?.message,
    errorKind: failure?.errorKind,
    retrySafe: failure?.retrySafe ?? false,
    deliveryUncertain: failure?.deliveryUncertain ?? false
  });
}));

app.get("/data/external-action-status/:clientId", asyncRoute(async (req, res) => {
  const { clientId } = z.object({ clientId: z.string().uuid() }).parse(req.params);
  let [sendRequest, actionRequest] = await Promise.all([
    prisma.sendRequest.findUnique({
      where: { clientSendId: clientId },
      select: { status: true, errorJson: true, source: true }
    }),
    prisma.externalActionRequest.findUnique({
      where: { clientActionId: clientId },
      select: { status: true, errorJson: true }
    })
  ]);

  if (sendRequest?.status === "SENT" && needsLocalReconciliation(sendRequest.errorJson)) {
    if (sendRequest.source === "manual_poll") {
      await pollSendService.reconcileSentProjections().catch(() => undefined);
    } else {
      await sendService.reconcileSentProjections().catch(() => undefined);
    }
  }
  if (
    actionRequest?.status === "SENT" &&
    actionRequest.errorJson?.includes("local_projection_required")
  ) {
    await durableExternalActionService.reconcileSentProjections().catch(() => undefined);
  }
  if (sendRequest || actionRequest) {
    [sendRequest, actionRequest] = await Promise.all([
      prisma.sendRequest.findUnique({
        where: { clientSendId: clientId },
        select: { status: true, errorJson: true, source: true }
      }),
      prisma.externalActionRequest.findUnique({
        where: { clientActionId: clientId },
        select: { status: true, errorJson: true }
      })
    ]);
  }

  const exactlyOneRecord = Boolean(sendRequest) !== Boolean(actionRequest);
  const record = sendRequest ?? actionRequest;
  res.json({
    clientId,
    status: record?.status ?? "NOT_FOUND",
    safeToReplace:
      exactlyOneRecord && record?.status === "SENT" && record.errorJson === null
  });
}));

app.get("/data/people", asyncRoute(async (_req, res) => {
  const [people, visibleThreadGroups, enrichments] = await Promise.all([
    prisma.person.findMany({
      where: { platform: { in: runnerConfig.availablePlatforms } },
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

  const peopleRiskSettings = await settingsStore.getSettings();
  const peopleRiskThresholds = { amberHours: peopleRiskSettings.amberHours, redHours: peopleRiskSettings.redHours };
  const peopleCounts = personThreadCounts(visibleThreadGroups);
  const groupedByPerson = new Map<string, ReturnType<typeof toInboxRow>[]>();
  for (const group of visibleThreadGroups) {
    const count = peopleCounts.get(personThreadCountKey(group.source.platform, group.source.personId)) ?? 1;
    const shaped = toInboxRow(group, count, peopleRiskThresholds);
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

app.get("/data/favourites", asyncRoute(async (_req, res) => {
  const MENU_FAVOURITE_LIMIT = 5;
  const [favouritePeople, visibleThreadGroups] = await Promise.all([
    prisma.person.findMany({
      where: { favouritedAt: { not: null } },
      orderBy: { favouritedAt: "desc" },
      take: MENU_FAVOURITE_LIMIT,
      select: { id: true, displayName: true, platform: true }
    }),
    loadVisibleThreadRows()
  ]);

  const favouriteRiskSettings = await settingsStore.getSettings();
  const favouriteThresholds = {
    amberHours: favouriteRiskSettings.amberHours,
    redHours: favouriteRiskSettings.redHours
  };
  const favouriteCounts = personThreadCounts(visibleThreadGroups);

  const latestThreadByPerson = new Map<string, { threadId: string; at: number }>();
  for (const group of visibleThreadGroups) {
    const count =
      favouriteCounts.get(personThreadCountKey(group.source.platform, group.source.personId)) ?? 1;
    const shaped = toInboxRow(group, count, favouriteThresholds);
    const at = shaped.lastMessageAt ? Date.parse(shaped.lastMessageAt) : 0;
    const existing = latestThreadByPerson.get(shaped.personId);
    if (!existing || at > existing.at) {
      latestThreadByPerson.set(shaped.personId, { threadId: shaped.id, at });
    }
  }

  res.json(
    favouritePeople.map((person) => ({
      id: person.id,
      name: person.displayName,
      platform: person.platform,
      threadId: latestThreadByPerson.get(person.id)?.threadId ?? null
    }))
  );
}));

app.get("/data/birthdays", asyncRoute(async (_req, res) => {
  // Contacts whose macOS Contacts card carries a birthday, surfaced as a
  // gentle "reach out" reminder. Each links to the person's most-recent
  // thread so the dashboard can open the conversation in one click.
  const people = await prisma.person.findMany({
    where: {
      platform: { in: runnerConfig.availablePlatforms },
      birthday: { not: null }
    },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      platform: true,
      birthday: true,
      birthYear: true,
      threads: {
        orderBy: { lastMessageAt: "desc" },
        take: 1,
        select: { id: true }
      }
    }
  });

  const upcoming = people
    .map((person) => {
      const daysUntil = daysUntilBirthday(person.birthday);
      if (daysUntil === null) return null;
      return {
        personId: person.id,
        personName: person.displayName,
        personAvatarUrl: person.avatarUrl ?? null,
        platform: person.platform,
        threadId: person.threads[0]?.id ?? null,
        monthDay: person.birthday,
        birthYear: person.birthYear,
        daysUntil
      };
    })
    .filter(
      (entry): entry is NonNullable<typeof entry> =>
        entry !== null && entry.daysUntil <= BIRTHDAY_HORIZON_DAYS
    )
    .sort((a, b) => a.daysUntil - b.daysUntil || a.personName.localeCompare(b.personName));

  res.json({ upcoming });
}));

// Drives the dashboard's "this Mac has no saved contacts" hint. Returns the
// latest iMessage name-sync health snapshot, or null until the first tick
// completes / on non-macOS hosts where the sync doesn't run.
app.get("/data/imessage-contact-health", asyncRoute(async (_req, res) => {
  res.json(runnerConfig.platformAvailability.IMESSAGE ? imessageNameSync?.getHealth() ?? null : null);
}));

app.post("/control/imessage/contacts/resync", asyncRoute(async (_req, res) => {
  if (!imessageNameSync) {
    res.status(409).json({
      ok: false,
      message: `Contacts are only available when ${resolveAppName()} is running on a Mac.`
    });
    return;
  }
  try {
    await platformSelectionCoordinator.withSelectedPlatform("IMESSAGE", () =>
      imessageNameSync.tick()
    );
  } catch (error) {
    if (!(error instanceof PlatformNotSelectedError)) throw error;
    res.status(409).json({
      ok: false,
      reason: "platform_not_selected",
      message: "Select iMessage in Settings before checking Contacts."
    });
    return;
  }
  res.json({ ok: true, health: imessageNameSync.getHealth() });
}));

app.get("/data/person/:personId", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  if (!runnerConfig.availablePlatforms.includes(person.platform as PlatformName)) {
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
      notes: person.notes,
      // R-0066 / #483. Drives the favourite star in the profile drawer.
      favourite: person.favouritedAt != null
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
// "confirm" is idempotent: a duplicate/stale confirm (already resolved) is a
// successful no-op, not an error. See decidePersonNameAction.
app.post("/control/person/:personId/rename", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "rename the contact", kind: "thread-mutation" })) return;
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
  const decision = decidePersonNameAction(person, payload);
  if (decision.write) {
    await prisma.person.update({ where: { id: personId }, data: decision.write });
  }
  res.status(decision.status).json(decision.body);
}));

// Toggle / set a contact as a favourite (R-0066 / #483). Favourited contacts
// float to the top of the Inbox section / Today bucket they already sit in and
// can be filtered to on the Inbox. The dashboard sends an explicit
// `{ favourite }` so an optimistic star stays in sync; a bare POST toggles.
app.post("/control/person/:personId/favourite", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "favourite the contact", kind: "thread-mutation" })) return;
  const payload = z
    .object({
      action: z.enum(["toggle", "set"]).optional(),
      favourite: z.boolean().optional()
    })
    .parse(req.body ?? {});
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  const decision = decidePersonFavouriteAction(person, payload);
  if (decision.write) {
    await prisma.person.update({ where: { id: personId }, data: decision.write });
  }
  res.status(decision.status).json(decision.body);
}));

app.post("/control/person/:personId/groups", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "save contact groups", kind: "thread-mutation" })) return;
  const payload = z.object({ groups: z.array(z.string()).optional() }).parse(req.body ?? {});
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  const groups = normalizePersonGroups(payload.groups ?? []);
  await prisma.person.update({
    where: { id: personId },
    data: { tagsJson: groups.length > 0 ? JSON.stringify(groups) : null }
  });
  res.json({ status: "ok", groups });
}));

app.post("/control/person/:personId/notes", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "save contact notes", kind: "thread-mutation" })) return;
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
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "enrich the contact", kind: "external-action" })) return;
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
// next enrichment run has a target.
app.post("/control/person/:personId/profile-url", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "set the contact profile URL", kind: "thread-mutation" })) return;
  const payload = z
    .object({ profileUrl: z.string().url() })
    .parse(req.body);
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  // The stored value is later navigated to in the runner's authenticated
  // Chrome (open-profile + the enrichment auto-visit), so a bare URL string
  // isn't safe to persist: file://, view-source:, data:, link-local hosts
  // and intranet hosts all parse as valid URLs. Pin it to https/http on the
  // platform's allowlisted host before it ever reaches the database.
  let safeProfileUrl: string;
  try {
    safeProfileUrl = parseAllowedProfileUrl(payload.profileUrl, person.platform);
  } catch (error) {
    if (error instanceof ProfileUrlPolicyError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  await prisma.person.update({
    where: { id: personId },
    data: {
      profileUrl: safeProfileUrl,
      profileUrlSource: "manual",
      enrichmentFailedReason: null
    }
  });
  res.json({ status: "ok", profileUrl: safeProfileUrl });
}));

// Bulk-enqueue every person with a known profile URL for re-enrichment.
// Returns the count of jobs enqueued. The queue handles its own pacing
// and concurrency, so we don't need to throttle here beyond the
// per-person coalescing inside `enqueue` (manual triggers always create
// a fresh row so a Scan-all click while another is in-flight will still
// produce visible progress).
app.post("/control/people/scan-all", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "scan all people", kind: "external-action" })) return;
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
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "summarise the friendship", kind: "thread-mutation" })) return;
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) {
    res.status(404).json({ error: "person not found" });
    return;
  }
  // Up to ~600 messages across all threads with this person. The summary
  // needs BOTH ends of a long history: the earliest messages (the
  // how-you-know-each-other section) and the latest (recent-topics). A
  // plain oldest-first take starved recent-topics on 600+ message
  // relationships (same window bug as pilot R-0084/R-0092 on the ask
  // endpoint), so pull the oldest 150 and newest 450 and stitch them.
  const messageSelect = {
    id: true,
    direction: true,
    text: true,
    timestamp: true,
    audioTranscription: { select: { status: true, transcript: true } }
  } as const;
  const [oldest, newestDesc] = await Promise.all([
    prisma.message.findMany({
      where: { thread: { personId } },
      orderBy: { timestamp: "asc" as const },
      take: 150,
      select: messageSelect
    }),
    prisma.message.findMany({
      where: { thread: { personId } },
      orderBy: { timestamp: "desc" as const },
      take: 450,
      select: messageSelect
    })
  ]);
  const seen = new Set(oldest.map((m) => m.id));
  const messages = [...oldest, ...newestDesc.reverse().filter((m) => !seen.has(m.id))];
  const result = await aiService.summarisePersonForFriendship({
    displayName: person.displayName,
    messages: messages.map(prismaMessageToPrompt).filter(isAiVisibleMessage)
  });
  res.json(result);
}));

// Free-form Q&A about a person (Q10). Same context pull as friendship
// summary - all messages across all threads with this person - plus the
// contact's enrichment snapshot + operator notes/tags. The AI prompt
// enforces "only answer from provided context, cite dates when relevant".
app.post("/control/person/:personId/ask", asyncRoute(async (req, res) => {
  const { personId } = z.object({ personId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { personId, action: "ask about the contact", kind: "thread-mutation" })) return;
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
  // The NEWEST 600 messages, restored to chronological order for the
  // prompt. This used to be `orderBy: asc` + take, which returns the OLDEST
  // 600 - so on a long-running relationship (pilot R-0084/R-0092: 681 and
  // 1627 messages on record) the ask never saw the recent conversation and
  // answered from years-old context ("the last thing said was ... 3
  // February 2024" while June 2026 messages sat on screen, and a padel
  // plan from this week came back "not recorded").
  const messagesDesc = await prisma.message.findMany({
    where: { thread: { personId } },
    orderBy: { timestamp: "desc" },
    take: 600,
    select: {
      direction: true,
      text: true,
      timestamp: true,
      // #753: group turns keep their sender's name in the ask transcript.
      senderName: true,
      audioTranscription: { select: { status: true, transcript: true } }
    }
  });
  const messages = messagesDesc.reverse();
  const transcriptTruncated = messagesDesc.length === 600;
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
    messages: messages.map(prismaMessageToPrompt).filter(isAiVisibleMessage),
    contact: contactSnapshot,
    notes: person.notes,
    tags,
    transcriptTruncated
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

// WhatsApp connect (#774). Off unless WHATSAPP_ENABLED=true. `/connect`
// kicks the whatsapp-web.js session; the QR arrives asynchronously via the
// adapter's onQr callback and is polled from `/status` as a data-URL PNG the
// operator scans in WhatsApp > Linked Devices. `/status` never blocks.
app.post("/control/whatsapp/connect", asyncRoute(async (_req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "connect WhatsApp", kind: "external-action" })) return;
  if (!runnerConfig.whatsapp.enabled) {
    res.status(409).json({ ok: false, reason: "disabled", message: "Set WHATSAPP_ENABLED=true and restart to use WhatsApp." });
    return;
  }
  const adapter = adapters.WHATSAPP;
  if (!adapter) {
    res.status(500).json({ ok: false, reason: "no_adapter" });
    return;
  }
  let ready = Promise.resolve();
  try {
    await platformSelectionCoordinator.withSelectedPlatform("WHATSAPP", async () => {
      if (whatsappConnect.state === "connected") {
        res.json({ ok: true, state: whatsappConnect.state });
        return;
      }
      if (whatsappConnect.state === "connecting" || whatsappConnect.state === "qr_ready") {
        res.status(202).json({ ok: true, state: whatsappConnect.state });
        return;
      }
      whatsappConnect.state = "connecting";
      whatsappConnect.updatedAt = new Date().toISOString();
      ready = adapter.ensureConnected();
      res.status(202).json({ ok: true, state: whatsappConnect.state });
    });
  } catch (error) {
    if (error instanceof PlatformNotSelectedError) {
      res.status(409).json({ ok: false, reason: "platform_not_selected" });
      return;
    }
    throw error;
  }
  void ready.catch((error) => {
    console.warn(`[whatsapp] connect failed: ${error instanceof Error ? error.message : String(error)}`);
    whatsappConnect.state = "disconnected";
    whatsappConnect.updatedAt = new Date().toISOString();
  });
}));

app.post("/control/whatsapp/refresh-qr", asyncRoute(async (_req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "refresh the WhatsApp QR code", kind: "external-action" })) return;
  if (!runnerConfig.whatsapp.enabled) {
    res.status(409).json({ ok: false, reason: "disabled", message: "Set WHATSAPP_ENABLED=true and restart to use WhatsApp." });
    return;
  }
  const adapter = adapters.WHATSAPP;
  if (!adapter) {
    res.status(500).json({ ok: false, reason: "no_adapter" });
    return;
  }
  let ready = Promise.resolve();
  try {
    await platformSelectionCoordinator.withSelectedPlatform("WHATSAPP", async () => {
      whatsappConnect.qr = null;
      whatsappConnect.qrDataUrl = null;
      whatsappConnect.state = "connecting";
      whatsappConnect.updatedAt = new Date().toISOString();
      await adapter.closeSession("refresh_qr");
      ready = adapter.ensureConnected();
    });
  } catch (error) {
    if (error instanceof PlatformNotSelectedError) {
      res.status(409).json({ ok: false, reason: "platform_not_selected" });
      return;
    }
    throw error;
  }
  void ready.catch((error) => {
    console.warn(`[whatsapp] QR refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    whatsappConnect.state = "disconnected";
    whatsappConnect.updatedAt = new Date().toISOString();
  });
  res.status(202).json({ ok: true, state: whatsappConnect.state });
}));

app.get("/data/whatsapp/status", asyncRoute(async (_req, res) => {
  res.json({
    enabled: runnerConfig.whatsapp.enabled,
    state: whatsappConnect.state,
    qrDataUrl: whatsappConnect.qrDataUrl,
    updatedAt: whatsappConnect.updatedAt,
    hasPersistedSession: hasPersistedWhatsAppSession(runnerConfig.profileDirs.WHATSAPP)
  });
}));

app.post("/control/whatsapp/reset", asyncRoute(async (_req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "reset WhatsApp", kind: "external-action" })) return;
  if (!runnerConfig.whatsapp.enabled) {
    res.status(409).json({
      ok: false,
      reason: "disabled",
      message: "Turn on WhatsApp in setup before resetting its connection."
    });
    return;
  }
  const adapter = adapters.WHATSAPP;
  if (!adapter) {
    res.status(500).json({ ok: false, reason: "no_adapter" });
    return;
  }

  await withWhatsAppSessionLocks(async () => {
    await adapter.closeSession("manual_reset");
    await clearPersistedWhatsAppSession(runnerConfig.profileDirs.WHATSAPP);
    whatsappConnect.qr = null;
    whatsappConnect.qrDataUrl = null;
    whatsappConnect.state = "disconnected";
    whatsappConnect.updatedAt = new Date().toISOString();
    await syncWhatsAppPlatformRow("disconnected");
    await auditService.log({
      platform: "WHATSAPP",
      stage: "Connect",
      action: "RESET_WHATSAPP_SESSION",
      status: "OK"
    });
  });
  res.json({ ok: true, state: "disconnected", hasPersistedSession: false });
}));

// #703 link previews. Unfurl a URL into title/description/image server-side
// (SSRF guard, HTML parse, TikTok oEmbed, caching) lives in
// services/link-preview.ts. Always returns a safe object.
app.get("/data/link-preview", asyncRoute(async (req, res) => {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  if (!raw.trim()) {
    res.status(400).json({ error: "url query parameter is required" });
    return;
  }
  res.json(await getLinkPreview(raw));
}));

app.post("/control/operator-profile", asyncRoute(async (req, res) => {
  const completeFocusPolicyMutation = beginUserTriggeredIntentOperation(res);
  try {
  if (await checkPresenterGuard(res, settingsStore, { action: "save your profile", kind: "operator-write" })) return;
  const payload = z
    .object({
      displayName: z.string().max(120).optional(),
      about: z.string().max(4000).optional(),
      interests: z.string().max(4000).optional(),
      commonPhrases: z.string().max(2000).optional(),
      avoidedPhrases: z.string().max(2000).optional(),
      preferredStyle: z
        .enum(["warm", "direct", "casual", "thoughtful", "concise", ""])
        .optional(),
      aiHelpLevel: z.enum(["memory_only", "writing_support", "full_drafts"]).optional(),
      setupCompletedAt: z.string().max(40).optional(),
      // Focus Reply Buffer state. Each top-level field is sent whole (the
      // dashboard never sends a partial sub-object), so strict object shapes
      // are safe; the store still coerces defensively on read.
      focusWindow: z
        .object({
          active: z.boolean(),
          startedAt: z.string().max(40),
          endsAt: z.string().max(40),
          reason: z.string().max(80),
          note: z.string().max(2000),
          // Older dashboard builds don't send it; default to "" (= fall
          // back to the saved professional template).
          professionalNote: z.string().max(2000).default(""),
          audience: z.enum(["favourites", "all_personal"]),
          windowId: z.string().max(80),
          ackedPersonIds: z.array(z.string().max(120)).max(5000),
          autoSendAcknowledgements: z.boolean().default(false),
          // Calendar auto-focus (#786). Older dashboard builds don't send
          // these; default so a hand-started window round-trips as "manual"
          // and a calendar window keeps its dismissal key through an edit/end.
          source: z.enum(["manual", "calendar"]).default("manual"),
          sourceEventKey: z.string().max(120).default("")
        })
        .optional(),
      ackTemplates: z
        .object({
          close: z.string().max(2000),
          professional: z.string().max(2000)
        })
        .optional(),
      focusSettings: z
        .object({
          reasonLabel: z.boolean(),
          oneNotePerPerson: z.boolean(),
          audience: z.enum(["favourites", "all_personal"])
        })
        .optional(),
      calendarSync: z
        .object({
          url: z.string().max(2000),
          additionalUrls: z.array(z.string().max(2000)).max(11).default([]),
          enabled: z.boolean(),
          keyword: z.string().max(120),
          audience: z.enum(["favourites", "all_personal"]),
          phraseWithAi: z.boolean().default(false)
        })
        .optional()
    })
    .parse(req.body);
  const updated = await settingsStore.updateOperatorProfile(payload);
  // When the calendar subscription changed, re-check the feed right away so a
  // just-enabled window opens without waiting for the next 60s tick.
  if (payload.calendarSync !== undefined) {
    void calendarFocusService.refresh().catch(() => undefined);
  }
  res.json(updated);
  } finally {
    completeFocusPolicyMutation();
  }
}));

// Calendar auto-focus (#786): the Settings "check calendar" button. Fetches
// the operator's iCal feed once (SSRF-guarded) and reports the live event and
// the next upcoming one so they can confirm the URL works. Always 200 with an
// { ok } flag so the dashboard shows a calm message, not a thrown error.
app.post("/control/calendar/preview", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "check your calendar", kind: "external-action" })) return;
  const { url, additionalUrls, keyword } = z
    .object({
      url: z.string().max(2000).default(""),
      additionalUrls: z.array(z.string().max(2000)).max(11).default([]),
      keyword: z.string().max(120).optional()
    })
    .parse(req.body);
  const urls = calendarUrls({
    url,
    additionalUrls,
    enabled: true,
    keyword: keyword ?? "",
    audience: "favourites",
    phraseWithAi: false
  });
  if (urls.length === 0) {
    res.json({ ok: false, error: "Add at least one calendar's secret iCal address first." });
    return;
  }
  try {
    const now = new Date();
    const summaries = await Promise.all(
      urls.map(async (calendarUrl) => {
        const { text } = await fetchIcsText(calendarUrl);
        return summarizeCalendar(text, { now, keyword: keyword ?? "" });
      })
    );
    const summary = mergeCalendarSummaries(summaries);
    res.json({ ok: true, active: summary.active, next: summary.next });
  } catch (error) {
    res.json({
      ok: false,
      error: error instanceof Error ? error.message : "Could not read that calendar."
    });
  }
}));

// Issue #438 (pilot R-0059). Opt-in: infer the operator's reply-style fields
// from a sample of their OWN recently sent messages so Settings can prefill
// the form. Reads only OUT messages, never saves — the dashboard reviews the
// suggestion and the operator saves it explicitly. Always 200; a thin
// { ok:false, reason } lets the dashboard show a calm message rather than
// catching an error.
app.post("/control/operator-profile/analyze-style", asyncRoute(async (_req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "analyse your writing style", kind: "external-action" })) return;
  const rows = await prisma.message.findMany({
    where: { direction: "OUT" },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: 600,
    select: { text: true, direction: true, sentVia: true }
  });
  const sampleTexts = selectStyleSampleTexts(rows);
  if (sampleTexts.length < STYLE_ANALYSIS_MIN_SAMPLE) {
    res.json({ ok: false, reason: "not_enough_messages", sampleCount: sampleTexts.length, suggestion: null });
    return;
  }
  const { suggestion, aiRan } = await aiService.inferReplyStyle({ sampleTexts });
  if (!aiRan) {
    res.json({ ok: false, reason: "ai_unavailable", sampleCount: sampleTexts.length, suggestion: null });
    return;
  }
  if (isInferredStyleEmpty(suggestion)) {
    res.json({ ok: false, reason: "low_confidence", sampleCount: sampleTexts.length, suggestion: null });
    return;
  }
  res.json({ ok: true, sampleCount: sampleTexts.length, suggestion });
}));

// "Help me phrase this" for the Focus setup sheet. The operator types what
// they're about to do; the AI phrases the two note tiers in their voice
// (tokens [Name]/[until] kept literal), suggests a reason label and, when an
// explicit end time was stated, the end time. Composes only — nothing is
// saved or sent here; the sheet shows the result for the operator to edit.
// Always 200; { ok:false, reason } lets the dashboard show a calm message.
app.post("/control/focus/compose-note", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "phrase your focus note", kind: "external-action" })) return;
  const payload = z
    .object({ activity: z.string().trim().min(1).max(400) })
    .parse(req.body);
  // A handful of the operator's own authentic sends calibrates the voice —
  // same selection rules as reply-style analysis (drops automation sends and
  // placeholder bubbles), much smaller sample.
  const rows = await prisma.message.findMany({
    where: { direction: "OUT" },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: 200,
    select: { text: true, direction: true, sentVia: true }
  });
  const voiceSampleTexts = selectStyleSampleTexts(rows, 8);
  const operatorProfile = await settingsStore.getOperatorProfile();
  const composed = await aiService.composeFocusNote({
    activity: payload.activity,
    operatorProfile,
    voiceSampleTexts
  });
  if (!composed) {
    res.json({ ok: false, reason: "ai_unavailable" });
    return;
  }
  res.json({
    ok: true,
    close: composed.close,
    professional: composed.professional,
    reasonLabel: composed.reason,
    untilTime: composed.untilTime
  });
}));

// Pilot feedback intake. The dashboard posts a tester's bug / feedback
// report here; the runner enriches it with server-side metadata, runs an
// optional AI triage, and forwards it to the configured Apps Script
// webhook. The shared secret never leaves the runner. Returns 400 only for
// a malformed request; delivery problems come back as { ok: false } with
// 200 so the dashboard can show its calm failure state.
app.post("/control/pilot-feedback", asyncRoute(async (req, res) => {
  const payload = z
    .object({
      type: z.enum(PILOT_REPORT_TYPES),
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(6000),
      expected: z.string().trim().max(4000).default(""),
      privacyAck: z.boolean().default(false),
      meta: z
        .object({
          route: z.string().max(80).default(""),
          pathname: z.string().max(300).default(""),
          threadId: z.string().max(120).nullable().default(null),
          appVersion: z.string().max(80).default(""),
          userAgent: z.string().max(500).default(""),
          timestamp: z.string().max(40).default(""),
          lastError: z.string().max(500).nullable().default(null)
        })
        .default({}),
      screenshots: z
        .array(z.object({ name: z.string().max(200), dataUrl: z.string().max(8_000_000) }))
        .max(MAX_SCREENSHOTS)
        .default([])
    })
    .parse(req.body);

  const screenshots: PilotScreenshot[] = [];
  if (payload.screenshots.length > 0) {
    if (!payload.privacyAck) {
      res.status(400).json({
        ok: false,
        error: "Please confirm the screenshot privacy note before submitting."
      });
      return;
    }
    for (const shot of payload.screenshots) {
      const parsed = parseScreenshotDataUrl(shot.name, shot.dataUrl);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      screenshots.push(parsed.screenshot);
    }
  }

  // Server-side metadata enrichment. The dashboard cannot see the browser
  // mode; the runner adds it here, along with the AI help level and the
  // thread's platform. None of this is message content.
  let platform: string | null = null;
  if (payload.meta.threadId) {
    const thread = await prisma.thread.findUnique({
      where: { id: payload.meta.threadId },
      select: { platform: true }
    });
    platform = thread?.platform ?? null;
  }
  const operatorProfile = await settingsStore.getOperatorProfile();
  // Authoritative build identity. The dashboard's meta.appVersion is a
  // build-time env fallback and was arriving as a misleading "0.1.0" with an
  // empty commit (R-0077 / #709), which made reports un-triageable. The runner
  // reads the real stamp from release.json (shipped builds) / package.json
  // (dev), so it owns version + commit here. See resolveReportBuildIdentity.
  const { appVersion, commit } = resolveReportBuildIdentity({
    build: readAppVersion(projectRoot),
    metaAppVersion: payload.meta.appVersion,
    envCommit: process.env.APP_COMMIT
  });
  const enrichedMeta = {
    ...payload.meta,
    appVersion,
    platform,
    browserMode: runnerConfig.browserProfile.mode,
    aiHelpLevel: operatorProfile.aiHelpLevel,
    commit,
    receivedAt: new Date().toISOString()
  };

  // Optional AI triage — best effort, typed report + metadata only, never
  // the screenshot. The raw report is forwarded whether or not this runs.
  let ai = null;
  try {
    ai = await aiService.summarisePilotReport({
      type: payload.type,
      title: payload.title,
      description: payload.description,
      expected: payload.expected,
      meta: enrichedMeta
    });
  } catch {
    ai = null;
  }

  const webhookUrl = runnerConfig.pilotFeedback.webhookUrl;
  if (!webhookUrl) {
    res.json({
      ok: false,
      configured: false,
      error: "Feedback delivery is not set up on this install."
    });
    return;
  }
  const result = await forwardPilotReport({
    webhookUrl,
    secret: runnerConfig.pilotFeedback.secret,
    report: {
      type: payload.type,
      title: payload.title,
      description: payload.description,
      expected: payload.expected,
      meta: enrichedMeta,
      ai: ai as Record<string, unknown> | null,
      screenshots
    }
  });

  // Screenshot-to-GitHub attachment now happens server-side in the Apps
  // Script (it has a secure token, already creates the issue, and already
  // holds the screenshot bytes), so it works for every pilot install — not
  // only machines with a local gh CLI / GITHUB_TOKEN. The old runner-side
  // attach is intentionally not invoked here: a pilot build has no token, and
  // a private repo's raw URLs don't render inline anyway. See
  // docs/pilot/apps-script.md (GITHUB_ATTACH_SCREENSHOTS). The unused
  // services/github-attachments.ts + gh-cli-token.ts are left for a separate
  // cleanup PR.

  res.json(result);
}));

// Recent-reports list for the dashboard "My reports" view. Proxies the
// configured status endpoint, which returns only safe columns.
app.get("/control/pilot-feedback/status", asyncRoute(async (_req, res) => {
  const statusUrl = runnerConfig.pilotFeedback.statusUrl;
  if (!statusUrl) {
    res.json({ ok: false, configured: false, reports: [] });
    return;
  }
  const result = await fetchPilotReportStatus({
    statusUrl,
    secret: runnerConfig.pilotFeedback.secret
  });
  res.json(result);
}));

app.post("/control/platform/open-browser", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "open the platform browser", kind: "external-action" })) return;
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "GOOGLE_MESSAGES"]) }).parse(req.body);
  await withPlatformControlLock(payload.platform, async () => {
    // The zod payload restricts platform to the three with adapters today,
    // but the adapters map is now Partial — narrow via requireAdapter to
    // keep the runtime contract explicit (and to surface a clean error if
    // someone removes an adapter without updating the zod enum).
    const adapter = requireAdapter(payload.platform);
    // "Open the platform browser" is the operator explicitly asking to SEE the
    // runner's Chrome (e.g. to log in). Mark the visible intent so a launch
    // isn't hidden, and reveal a warm-but-hidden window so it surfaces even
    // when ensureConnected reuses an existing background context (or throws
    // auth-required - the operator still needs the window).
    const platformSession = resolvePlatformSession(payload.platform);
    const releaseVisible = platformSession.sessionManager.markVisibleLaunch(payload.platform);
    try {
      await (adapter.connectInteractively?.() ?? adapter.ensureConnected());
    } finally {
      await platformSession.sessionManager
        .revealWindow(payload.platform, platformSession.personKey)
        .catch(() => undefined);
      releaseVisible();
    }
    res.json({ status: "ok" });
  });
}));

app.post("/control/platform/linkedin/smoke-unread", asyncRoute(async (_req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "run a LinkedIn smoke test", kind: "external-action" })) return;
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
  const shouldContinue = scanQueue.createContinueGate();

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
    const result = await platformSelectionCoordinator.withSelectedPlatform("LINKEDIN", async () => {
      const settings = await settingsStore.getSettings();
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
            messages: persistInput.messages,
            shouldContinue
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
    if (error instanceof PlatformNotSelectedError) {
      res.status(409).json({
        ok: false,
        requestId,
        logDir,
        reason: "platform_not_selected",
        error: "LinkedIn is not selected in Settings."
      });
      return;
    }
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
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "request an AI predraft", kind: "thread-mutation" })) return;

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { person: true }
  });
  if (!thread) {
    res.status(404).json({ error: "thread_not_found" });
    return;
  }

  // iMessage splits one Person across handle-specific sibling threads. /data/thread
  // sources its AI inputs from the CANONICAL sibling (most-recent inbound) and
  // builds its recent/style windows over the merged sibling cohort. The predraft
  // pre-warm MUST resolve the same canonical row and the same cohort, or it
  // computes a cacheKey the reader can never hit — the warm is wasted and the
  // operator opens to a "Generating suggestions…" spinner. Non-iMessage /
  // single-sibling threads are their own canonical row over [thread.id].
  let aiSource: typeof thread & {
    rollingSummary: string | null;
    whatTheyWant: string | null;
    openLoopsJson: string | null;
    replyBriefJson: string | null;
    category: string | null;
    suggestedRepliesJson: string | null;
    suggestedRepliesCacheKey: string | null;
  } = thread;
  let predraftSiblingIds: string[] = [thread.id];
  if (thread.platform === "IMESSAGE") {
    const siblingRows = await prisma.thread.findMany({
      where: { platform: thread.platform, personId: thread.personId },
      select: {
        id: true,
        lastInboundAt: true,
        rollingSummary: true,
        whatTheyWant: true,
        openLoopsJson: true,
        replyBriefJson: true,
        category: true,
        suggestedRepliesJson: true,
        suggestedRepliesCacheKey: true,
        _count: { select: { messages: true } }
      }
    });
    predraftSiblingIds = siblingRows.map((row) => row.id);
    const canonical = pickCanonicalThread(
      siblingRows.map((row) => ({ ...row, messageCount: row._count?.messages ?? 0 }))
    );
    if (canonical) aiSource = { ...thread, ...canonical };
  }
  const messageScope = { threadId: { in: predraftSiblingIds } };

  // Fetch the last ~6 turns to mirror the /data/thread call site. Pulling
  // the full recent window over the SAME sibling cohort means a predraft
  // pre-warm builds the same recentSignature, so the cacheKey matches and the
  // operator's next /data/thread fetch reuses the warmed cache row. The style
  // sample is fetched on the same fixed window as /data/thread so the style
  // part of the cacheKey matches too (issue #299). last-IN/last-OUT are the
  // MERGED-cohort values /data/thread folds into the late-reply bucket.
  const RECENT_TURN_WINDOW = 6;
  const STYLE_SAMPLE_LIMIT = 40;
  const [recentTurnsDesc, operatorProfile, contactSnapshot, styleSampleDesc, lastInbound, lastOutbound] = await Promise.all([
    prisma.message.findMany({
      where: messageScope,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: RECENT_TURN_WINDOW,
      select: { direction: true, text: true, timestamp: true, senderName: true }
    }),
    settingsStore.getOperatorProfile(),
    conversationStartersService.toContactSnapshot(thread.personId, thread.person.displayName),
    prisma.message.findMany({
      where: messageScope,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: STYLE_SAMPLE_LIMIT,
      select: { direction: true, text: true }
    }),
    prisma.message.findFirst({
      where: { ...messageScope, direction: "IN" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      select: { timestamp: true }
    }),
    prisma.message.findFirst({
      where: { ...messageScope, direction: "OUT" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      select: { timestamp: true }
    })
  ]);
  const operatorStyle = analyzeStyle(
    styleSampleDesc.filter((m) => m.direction === "OUT").map((m) => m.text)
  );
  const contactStyle = analyzeStyle(
    styleSampleDesc.filter((m) => m.direction === "IN").map((m) => m.text)
  );
  const recentMessages = [...recentTurnsDesc].reverse().map((m) => ({
    direction: m.direction as "IN" | "OUT",
    text: m.text,
    timestamp: m.timestamp.toISOString(),
    // #753: group turns keep their sender's name in the prompt.
    senderName: m.senderName ?? null
  }));
  const aiNeedsReply = Boolean(
    lastInbound && (!lastOutbound || lastInbound.timestamp > lastOutbound.timestamp)
  );

  // Parse the persisted brief the same way /data/thread does — from the
  // CANONICAL sibling — so the predraft prompt and the subsequent /data/thread
  // fetch hit the same cache row. Older rows with no brief pass null unchanged.
  const briefForReplies: ReturnType<typeof sanitizeReplyBrief> = (() => {
    if (!aiSource.replyBriefJson) return null;
    try {
      return sanitizeReplyBrief(JSON.parse(aiSource.replyBriefJson));
    } catch {
      return null;
    }
  })();

  const aiInputs = {
    displayName: thread.person.displayName,
    // #753: group framing for reply suggestions.
    isGroup: thread.isGroup,
    groupName: thread.groupName ?? null,
    summary: aiSource.rollingSummary ?? "",
    whatTheyWant: aiSource.whatTheyWant ?? "",
    openLoops: aiSource.openLoopsJson ? (JSON.parse(aiSource.openLoopsJson) as string[]) : [],
    recentMessages,
    needsReply: aiNeedsReply,
    platform: thread.platform as PlatformName,
    category: (aiSource.category as "outreach" | "genuine" | null) ?? null,
    lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
    lastOutboundAt: lastOutbound?.timestamp.toISOString() ?? null,
    operatorProfile,
    contact: contactSnapshot,
    operatorStyle,
    contactStyle,
    replyBrief: briefForReplies
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
  // is folded in so a voice-tier change also invalidates. v5 includes
  // briefSignature so brief-aware replies invalidate when a new turn
  // refreshes the brief.
  const recentSignature = aiInputs.recentMessages
    .map((m) => `${m.direction}:${m.timestamp}:${m.text}`)
    .join("|");
  const briefSignature = briefSignatureForCache(briefForReplies);
  const cacheKey = createHash("sha256")
    .update(`v6|${aiInputs.summary}|${aiInputs.whatTheyWant}|${aiInputs.openLoops.join("")}|${aiInputs.needsReply ? 1 : 0}|${recentSignature}|${aiInputs.category ?? "_"}|${lateBucket}|${operatorProfileFingerprint(operatorProfile)}|${contactSnapshotFingerprint(contactSnapshot)}|${thread.platform}|${styleFingerprint(operatorStyle, contactStyle)}|${briefSignature}`)
    .digest("hex");

  if (aiSource.suggestedRepliesCacheKey === cacheKey && aiSource.suggestedRepliesJson) {
    res.json({ status: "cached", cacheKey });
    return;
  }

  // Fire and forget — the operator's next /data/thread fetch picks
  // up the cache once the AI call resolves. Persist to the CANONICAL sibling
  // (aiSource.id) so the reader finds it under the same cache key; the SSE
  // event keeps the requested threadId so the open view refetches.
  void aiService
    .generateSuggestedReplies(aiInputs)
    .then(async (generated) => {
      await prisma.thread.update({
        where: { id: aiSource.id },
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
          where: { id: aiSource.id },
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
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "voice-rewrite a draft", kind: "thread-mutation" })) return;
  const payload = z.object({ draft: z.string().min(1).max(5000) }).parse(req.body);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      // Most RECENT 80, made chronological by the reverse below. An asc
      // + take would calibrate voice off the OLDEST 80 messages and miss
      // how the operator currently writes to this contact. Includes the
      // audio transcript so a voice-note last message reaches composeInVoice
      // as its transcribed text, not the bare "[Voice note]" placeholder.
      messages: {
        orderBy: { timestamp: "desc" },
        take: 80,
        include: { audioTranscription: { select: { status: true, transcript: true } } }
      }
    }
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const orderedMessages = [...thread.messages].reverse();
  const voiceSamples = orderedMessages
    .filter((m) => m.direction === "OUT")
    .map((m) => m.text);

  // Writing-style profiles (issue #299) — keep the in-place rewrite true
  // to how the operator and contact actually write to each other.
  const operatorStyle = analyzeStyle(voiceSamples);
  const contactStyle = analyzeStyle(
    orderedMessages.filter((m) => m.direction === "IN").map((m) => m.text)
  );

  const [rewriteOperatorProfile, rewriteContactSnapshot] = await Promise.all([
    settingsStore.getOperatorProfile(),
    conversationStartersService.toContactSnapshot(thread.personId, thread.person.displayName)
  ]);

  const text = await aiService.composeInVoice({
    intent: `Rewrite the message below in my voice, preserving the meaning. Keep it about the same length. Message: ${payload.draft}`,
    platform: thread.platform as PlatformName,
    displayName: thread.person.displayName,
    // #753: group framing for the rewrite register.
    isGroup: thread.isGroup,
    groupName: thread.groupName ?? null,
    voiceSamples,
    threadMessages: orderedMessages.map(prismaMessageToPrompt),
    operatorProfile: rewriteOperatorProfile,
    contact: rewriteContactSnapshot,
    operatorStyle,
    contactStyle
  });

  res.json({ text });
}));

app.post("/control/thread/:threadId/draft", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "save a draft", kind: "thread-mutation" })) return;
  const payload = z.object({ text: z.string().max(5000) }).parse(req.body);

  const draft = await prisma.draft.upsert({
    where: { threadId },
    update: { text: payload.text },
    create: {
      threadId,
      text: payload.text
    },
    select: { text: true, updatedAt: true }
  });

  res.json({
    status: "ok",
    draft: { text: draft.text, updatedAt: draft.updatedAt.toISOString() }
  });
}));

app.post("/control/thread/:threadId/delete-draft", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "delete a draft", kind: "thread-mutation" })) return;
  const payload = z.object({
    draft: z.object({
      text: z.string().max(5000),
      updatedAt: z.string().datetime()
    })
  }).parse(req.body);

  const deleted = await deleteDraftRevision(prisma, threadId, payload.draft);

  res.json({ status: "ok", deleted });
}));

app.post("/control/thread/:threadId/mark-done", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "mark the thread handled", kind: "thread-mutation" })) return;
  const targetIds = await actionTargetThreadIds(threadId);
  await prisma.thread.updateMany({
    where: { id: { in: targetIds } },
    data: {
      needsReply: false,
      unreadCount: 0,
      riskLevel: "GREEN",
      riskReason: "Marked done manually",
      slaDueAt: null,
      handledAt: new Date()
    }
  });

  await auditService.log({
    action: "MARK_DONE",
    stage: "Send",
    status: "OK",
    details: { threadId, propagatedTo: targetIds.length }
  });

  res.json({ status: "ok" });
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
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "snooze", kind: "thread-mutation" })) return;
  const payload = z.object({ hours: z.number().int().min(1).max(72) }).parse(req.body);
  const due = new Date(Date.now() + payload.hours * 60 * 60 * 1000);

  const targetIds = await actionTargetThreadIds(threadId);
  await prisma.thread.updateMany({
    where: { id: { in: targetIds } },
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
    details: { threadId, hours: payload.hours, propagatedTo: targetIds.length }
  });

  res.json({ status: "ok", dueAt: due.toISOString(), snoozedUntil: due.toISOString() });
}));

// Issue #392. Natural-language reminder endpoint. Operator types
// "remind me to follow up with him next Tuesday" (or similar); we
// parse via parseReminderRequest, snooze the thread until the
// resolved time, and stash the reminder text on Thread.reminderText
// so the dashboard surfaces "Reminder: <text>" when the thread
// returns. Confidence: "low" responses skip the snooze and tell the
// caller to re-prompt the operator for a clearer time hint.
app.post("/control/thread/:threadId/remind", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "set a reminder", kind: "thread-mutation" })) return;
  const payload = z.object({ intent: z.string().min(1).max(600) }).parse(req.body);

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { person: true }
  });
  if (!thread) {
    res.status(404).json({ ok: false, error: "Thread not found" });
    return;
  }

  const parsed = await aiService.parseReminderRequest({
    intent: payload.intent,
    referenceTimeIso: new Date().toISOString(),
    displayName: thread.person.displayName
  });

  if (parsed.confidence === "low" || !parsed.remindAtIso) {
    res.json({
      ok: false,
      needsClarification: true,
      reminderText: parsed.reminderText,
      reason: parsed.reason ?? "Couldn't parse the time. Try rewriting with a specific date or duration."
    });
    return;
  }

  const due = new Date(parsed.remindAtIso);
  const targetIds = await actionTargetThreadIds(threadId);
  await prisma.thread.updateMany({
    where: { id: { in: targetIds } },
    data: {
      slaDueAt: due,
      snoozedUntil: due,
      reminderText: parsed.reminderText,
      riskReason: "Reminder set for " + due.toISOString()
    }
  });

  await auditService.log({
    action: "REMIND",
    stage: "Scan",
    status: "OK",
    details: {
      threadId,
      remindAt: due.toISOString(),
      reminderText: parsed.reminderText,
      propagatedTo: targetIds.length
    }
  });

  res.json({
    ok: true,
    remindAt: due.toISOString(),
    reminderText: parsed.reminderText
  });
}));

app.post("/control/thread/:threadId/unsnooze", asyncRoute(async (req, res) => {
  const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
  if (await checkPresenterGuard(res, settingsStore, { threadId, action: "unsnooze", kind: "thread-mutation" })) return;

  const targetIds = await actionTargetThreadIds(threadId);
  await prisma.thread.updateMany({
    where: { id: { in: targetIds } },
    data: {
      snoozedUntil: null,
      reminderText: null,
      riskReason: null
    }
  });

  await auditService.log({
    action: "UNSNOOZE",
    stage: "Scan",
    status: "OK",
    details: { threadId, propagatedTo: targetIds.length }
  });

  res.json({ status: "ok", threadId });
}));

const platformSessionResetCoordinator = createPlatformSessionResetCoordinator({
  platforms: allPlatforms,
  requestAbort: (reason) => scanQueue.requestAbort(reason),
  clearAbort: () => scanQueue.clearAbort(),
  clearInFlight: () => {
    connectInFlight.clear();
    suggestedRepliesInFlight.clear();
    threadSummaryRefreshInFlight.clear();
  },
  withGlobalResetLock,
  withExternalActionLock,
  withPlatformLock: withPlatformControlLock,
  resetSharedSession: async () => {
    await sessionManager.resetPersonSession({
      personKey: defaultPersonKey,
      reason: "manual_reset",
      clearProfileDir: true
    });
  },
  resetInstagramSession: async () => {
    const route = resolvePlatformSession("INSTAGRAM");
    await route.sessionManager.resetPersonSession({
      personKey: route.personKey,
      reason: "manual_reset",
      clearProfileDir: true
    });
  },
  persistStatus: async (platform) => {
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
  },
  auditLog: (input) => auditService.log(input)
});

app.post("/control/platform/reset-session", asyncRoute(async (req, res) => {
  if (await checkPresenterGuard(res, settingsStore, { action: "reset the platform session", kind: "external-action" })) return;
  const payload = z.object({ platform: z.enum(["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "GOOGLE_MESSAGES"]).optional() }).parse(req.body ?? {});

  const resetPlan = await platformSessionResetCoordinator.reset(payload.platform);
  res.json({
    status: "ok",
    resetScope: resetPlan.resetScope,
    affectedPlatforms: resetPlan.statusPlatforms
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

app.use((_req, res, next) => {
  abandonUnstartedUserTriggeredIntent(res);
  next();
});

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  abandonUnstartedUserTriggeredIntent(res);
  const path = normalizeControlPath(req.path);
  const trace = getControlTrace(res);
  const statusCode = error instanceof z.ZodError
    ? 400
    : error instanceof SendPolicyError
      ? 409
      : error instanceof PlatformNotSelectedError
        ? 409
      : 500;
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
  res.status(statusCode).json({
    error: message,
    ...(error instanceof SendPolicyError
      ? { reasonCode: error.reasonCode, ...error.details }
      : error instanceof PlatformNotSelectedError
        ? { reasonCode: "platform_not_selected" }
      : {})
  });
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
  const startupSettings = await settingsStore.getSettings();
  const envWritePath = resolveEnvWritePath();
  const recoveredGeminiKey = recoverEnvFileValueForStartup(
    envWritePath,
    "GEMINI_API_KEY",
    startupSettings.setupGeminiKeyTransactionId
  );
  if (recoveredGeminiKey) process.env.GEMINI_API_KEY = recoveredGeminiKey;
  else delete process.env.GEMINI_API_KEY;
  runnerConfig.geminiApiKey = recoveredGeminiKey;
  sweepTranscriptionDownloadOrphans(runnerConfig.audioTranscription.transformers.modelDir);
  await sweepOutgoingAttachmentOrphansOnce();
  const outgoingAttachmentSweepTimer = setInterval(
    () => void sweepOutgoingAttachmentOrphansOnce(),
    OUTGOING_ATTACHMENT_ORPHAN_GRACE_MS
  );
  outgoingAttachmentSweepTimer.unref();
  const startupSetupPreferences = await getSetupPreferences();
  if (
    startupSetupPreferences.revision > 0 ||
    startupSetupPreferences.startedAt ||
    startupSetupPreferences.completedAt
  ) {
    transcriptionSetup.restore(startupSetupPreferences.transcriptionMode);
  }
  scanQueue.startScheduler();

  await reconcileIMessageSelection(startupSettings.enabledPlatforms.includes("IMESSAGE"));

  const linkedInPlatform = await prisma.platform.findUnique({ where: { name: "LINKEDIN" } });
  if (shouldStartLinkedInRealtimeWatcher({
    available: runnerConfig.platformAvailability.LINKEDIN,
    selected: startupSettings.enabledPlatforms.includes("LINKEDIN"),
    connectedAt: linkedInPlatform?.connectedAt
  })) {
    startLinkedInRealtimeWatcher();
  }

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(runnerConfig.port, runnerConfig.bindHost, () => {
      // eslint-disable-next-line no-console
      console.log(`Runner listening on http://${runnerConfig.bindHost}:${runnerConfig.port}`);
      resolve();
    });
    server.on("error", (error) => reject(error));
  });
  automaticUpdateScheduler.start();
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
