import type { PlatformAdapter, PlatformName, SendReceipt, ThreadStub } from "@inbox-os/core";
import { calculateRisk, stableHash } from "@inbox-os/core";
import { Prisma, type PrismaClient, type SendRequest as SendRequestRow } from "@prisma/client";
import { v4 as uuid } from "uuid";
import { prisma as defaultPrisma } from "../db";
import type { EventBus, SettingsStore } from "../types/runtime";
import { AdapterFailure } from "../platforms/utils";
import { buildDemoSendReceipt } from "./demo-send";
import { classifySendFailureKind, consumerSendFailure } from "./send-failure";
import {
  focusAutoAckDispatchEligible,
  type FocusAutoAckThread
} from "./focus-auto-ack";

interface SendServiceDeps {
  // Partial: not every PlatformName has an adapter on main today. The
  // worker checks `if (!adapter)` before dispatching (see
  // processSendRequest); the route guards earlier via requireAdapter.
  adapters: Partial<Record<PlatformName, PlatformAdapter>>;
  eventBus: EventBus;
  settingsStore: SettingsStore;
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
   * Serializes the page-driving send against scans. Must wrap work in the
   * SAME per-platform mutex key the scan queue uses (`<personKey>:<platform>`)
   * so a send can't drive the shared managed Playwright page while a scan is
   * mid-flight on it. The platform "lease" only counts active holders; it is
   * NOT mutually exclusive, so without this a send and a scan interleave
   * navigations/DOM reads on one page.
   */
  withPlatformLock: <T>(platform: PlatformName, work: () => Promise<T>) => Promise<T>;
  /**
   * Fences every externally visible action against an administrative reset.
   * The fixed lock order is external action first, then the page/platform lock.
   */
  withExternalActionLock: <T>(
    platform: PlatformName,
    work: () => Promise<T>
  ) => Promise<T>;
  /** Override the Prisma client. Defaults to the runner's singleton; tests inject a fake. */
  prisma?: PrismaClient;
  onPlatformResult?: (input: {
    clientSendId: string;
    platform: PlatformName;
    outcome: "success" | "failure";
    finishedAt: string;
  }) => void;
}

interface SendResult {
  sentAt: string;
  screenshotFile?: string;
  verifiedBy: SendReceipt["verifiedBy"];
  replayed: boolean;
}

function parseFailedSendMessage(errorJson?: string | null): string {
  try {
    const errorPayload = errorJson ? JSON.parse(errorJson) : { message: "Previous send failed" };
    return typeof errorPayload.message === "string" ? errorPayload.message : "Previous send failed";
  } catch {
    return "Previous send failed";
  }
}

// The LinkedIn adapter wraps the original Playwright/network failure with
// a generic "Failed to send LinkedIn message for {name}" string and stashes
// the real cause on `error.cause`. Without unwrapping, the dashboard's
// "Failed to send" banner gives the operator nothing to act on. Walk the
// cause chain so the most specific message we have wins.
function describeSendError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message) {
      messages.push(current.message);
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  // Deepest cause is usually the most specific (Playwright timeout / nav
  // failure). Surface it first, then the wrapper for context.
  const ordered = messages.reverse();
  const seenLines = new Set<string>();
  const deduped = ordered.filter((line) => {
    const key = line.trim();
    if (!key || seenLines.has(key)) return false;
    seenLines.add(key);
    return true;
  });
  return deduped.join(" — ") || error.message || "Send failed";
}

function parseReceipt(receiptJson: string): Omit<SendResult, "replayed"> {
  return JSON.parse(receiptJson) as Omit<SendResult, "replayed">;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// Marker written into `receiptJson` the instant a worker claims a PENDING row,
// BEFORE the (non-idempotent) adapter send. Two things hang off it:
//
//   1. Atomic claim. The claim is an `updateMany` guarded on
//      `{ status: PENDING, receiptJson: null }`; only the worker whose write
//      returns `count === 1` proceeds to the adapter. A second worker (a
//      concurrent kick, or a resume() after restart) sees `receiptJson` already
//      set, gets `count === 0`, and bails — so the recipient can't be messaged
//      twice.
//   2. Crash reconciliation. If the process dies between the physical send and
//      the terminal SENT write, the row is left PENDING with this exact marker
//      in `receiptJson`. On boot that's an *in-doubt* row: a send may or may not
//      have physically gone out, so resume() must NOT blindly re-dispatch it.
//      `reconcileInterruptedSends` flips these to FAILED for operator review.
//
// Safe to overload `receiptJson` because it is only ever parsed when
// `status === "SENT"` (see enqueueSend's replay branch); on a PENDING/FAILED
// row it is never read. The SENT write overwrites this marker with the real
// receipt JSON.
export const SEND_CLAIM_MARKER = "__claimed__";
export const LOCAL_RECONCILIATION_REQUIRED = "local_projection_required";

/** True when a PENDING row carries the in-flight claim marker (vs. a real receipt). */
export function isClaimMarker(receiptJson: string | null | undefined): boolean {
  return receiptJson === SEND_CLAIM_MARKER;
}

export function localReconciliationMarker(): string {
  return JSON.stringify({
    reconciliationRequired: true,
    reason: LOCAL_RECONCILIATION_REQUIRED
  });
}

export function needsLocalReconciliation(errorJson: string | null | undefined): boolean {
  if (!errorJson) return false;
  try {
    const payload = JSON.parse(errorJson) as Record<string, unknown>;
    return (
      payload.reconciliationRequired === true &&
      payload.reason === LOCAL_RECONCILIATION_REQUIRED
    );
  } catch {
    return false;
  }
}

export interface EnqueueSendResult {
  clientSendId: string;
  status: "PENDING" | "SENT" | "FAILED";
  replayed: boolean;
  result?: SendResult;
  errorMessage?: string;
}

export interface ScheduleSendResult {
  clientSendId: string;
  status: "SCHEDULED";
  scheduledFor: string;
  replayed: boolean;
}

export type SendSource = "manual" | "focus_ack" | "focus_auto_ack";

type SendAttachment = {
  absolutePath: string;
  displayName: string;
  mimeType?: string;
  kind?: string;
  contentDigest?: string;
};

type PersistedSendIntent = {
  threadId: string;
  requestText: string;
  source: string;
  attachmentsJson: string | null;
  replyToMessageId: string | null;
  scheduledFor: Date | null;
};

function normalizedAttachmentsJson(attachments?: SendAttachment[]): string | null {
  if (!attachments || attachments.length === 0) return null;
  return JSON.stringify(
    attachments.map((attachment) => ({
      absolutePath: attachment.absolutePath,
      displayName: attachment.displayName,
      mimeType: attachment.mimeType ?? null,
      kind: attachment.kind ?? null,
      contentDigest: attachment.contentDigest ?? null
    }))
  );
}

function attachmentIntentJson(attachments?: SendAttachment[]): string | null {
  if (!attachments || attachments.length === 0) return null;
  return JSON.stringify(
    attachments.map((attachment) => ({
      displayName: attachment.displayName,
      mimeType: attachment.mimeType ?? null,
      kind: attachment.kind ?? null,
      contentDigest: attachment.contentDigest ?? null,
      legacyAbsolutePath: attachment.contentDigest ? null : attachment.absolutePath
    }))
  );
}

function normalizePersistedAttachmentsJson(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return attachmentIntentJson(
      parsed.map((attachment) => {
        if (!attachment || typeof attachment !== "object") {
          throw new Error("invalid attachment");
        }
        const candidate = attachment as Record<string, unknown>;
        if (
          typeof candidate.absolutePath !== "string" ||
          typeof candidate.displayName !== "string"
        ) {
          throw new Error("invalid attachment");
        }
        return {
          absolutePath: candidate.absolutePath,
          displayName: candidate.displayName,
          mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined,
          kind: typeof candidate.kind === "string" ? candidate.kind : undefined,
          contentDigest:
            typeof candidate.contentDigest === "string" ? candidate.contentDigest : undefined
        };
      })
    );
  } catch {
    return "__invalid__";
  }
}

function assertExistingSendIntent(
  existing: PersistedSendIntent,
  expected: {
    threadId: string;
    text: string;
    source: SendSource;
    attachments?: SendAttachment[];
    replyToMessageId?: string;
    scheduledFor?: Date;
  }
): void {
  const existingScheduledFor = existing.scheduledFor?.getTime() ?? null;
  const expectedScheduledFor = expected.scheduledFor?.getTime() ?? null;
  if (
    existing.threadId !== expected.threadId ||
    existing.requestText !== expected.text ||
    existing.source !== expected.source ||
    normalizePersistedAttachmentsJson(existing.attachmentsJson) !==
      attachmentIntentJson(expected.attachments) ||
    (existing.replyToMessageId ?? null) !== (expected.replyToMessageId ?? null) ||
    existingScheduledFor !== expectedScheduledFor
  ) {
    throw new Error("clientSendId is already linked to a different send intent");
  }
}

class SendPolicyError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string
  ) {
    super(message);
    this.name = "SendPolicyError";
  }
}

export function parsePersistedSendSource(value: unknown): SendSource | null {
  return value === "manual" || value === "focus_ack" || value === "focus_auto_ack"
    ? value
    : null;
}

export function assertInstagramManualTextSend(input: {
  platform: PlatformName;
  scheduled?: boolean;
  attachmentCount?: number;
  source?: SendSource;
}): void {
  if (input.platform !== "INSTAGRAM") {
    return;
  }
  if (input.scheduled || (input.source !== undefined && input.source !== "manual")) {
    throw new Error("Instagram supports user-triggered sends only. Send this message now instead.");
  }
  if ((input.attachmentCount ?? 0) > 0) {
    throw new Error("Instagram currently supports text messages only.");
  }
}

export function createSendService(deps: SendServiceDeps) {
  // Default to the runner's singleton; tests inject a fake to exercise the
  // scheduled-send race guards without a real database.
  const prisma = deps.prisma ?? defaultPrisma;
  const userTriggeredIntentCounts = new Map<string, number>();

  function registerUserTriggeredIntent(threadId: string): () => void {
    userTriggeredIntentCounts.set(
      threadId,
      (userTriggeredIntentCounts.get(threadId) ?? 0) + 1
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (userTriggeredIntentCounts.get(threadId) ?? 1) - 1;
      if (remaining > 0) {
        userTriggeredIntentCounts.set(threadId, remaining);
      } else {
        userTriggeredIntentCounts.delete(threadId);
      }
    };
  }

  async function withUserTriggeredIntent<T>(
    threadId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const release = registerUserTriggeredIntent(threadId);
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function projectSentRequest(
    sendRequest: SendRequestRow,
    receipt: SendReceipt
  ): Promise<void> {
    const thread = await prisma.thread.findUnique({
      where: { id: sendRequest.threadId }
    });
    if (!thread) throw new Error("Thread not found while reconciling a sent message");

    const settings = await deps.settingsStore.getSettings();
    const sentAt = new Date(receipt.sentAt);
    if (Number.isNaN(sentAt.getTime())) {
      throw new Error("Send receipt has an invalid sentAt timestamp");
    }
    const attachmentsJson =
      receipt.attachments && receipt.attachments.length > 0
        ? JSON.stringify(receipt.attachments)
        : null;
    const rawJson = receipt.raw ? JSON.stringify(receipt.raw) : null;
    const platformMessageKey =
      receipt.platformMessageKey ??
      stableHash(`${thread.id}|${receipt.sentAt}|OUT|${sendRequest.requestText}`);

    await prisma.message.upsert({
      where: {
        threadId_platformMessageKey: {
          threadId: thread.id,
          platformMessageKey
        }
      },
      update: {
        direction: "OUT"
      },
      create: {
        threadId: thread.id,
        platformMessageKey,
        direction: "OUT",
        timestamp: sentAt,
        text: sendRequest.requestText,
        sentVia: "automation",
        attachmentsJson,
        rawJson,
        replyToMessageId: sendRequest.replyToMessageId ?? null
      }
    });

    const lastOutboundAt =
      thread.lastOutboundAt && thread.lastOutboundAt > sentAt
        ? thread.lastOutboundAt
        : sentAt;
    const risk = calculateRisk({
      lastInboundAt: thread.lastInboundAt,
      lastOutboundAt,
      amberHours: settings.amberHours,
      redHours: settings.redHours
    });
    const sendIsLatest = !thread.lastMessageAt || sentAt >= thread.lastMessageAt;
    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        needsReply: risk.needsReply,
        riskLevel: risk.level,
        riskReason: risk.riskReason,
        slaDueAt: risk.slaDueAt,
        lastOutboundAt,
        ...(sendIsLatest
          ? {
              snoozedUntil: null,
              lastMessageAt: sentAt,
              unreadCount: 0,
              lastMessageDirection: "OUT" as const,
              lastMessageText: sendRequest.requestText
            }
          : {})
      }
    });
  }

  async function reconcileSentProjectionRow(sendRequest: SendRequestRow): Promise<boolean> {
    if (
      sendRequest.source === "manual_poll" ||
      sendRequest.status !== "SENT" ||
      !sendRequest.receiptJson ||
      !needsLocalReconciliation(sendRequest.errorJson)
    ) {
      return false;
    }
    let receipt: SendReceipt;
    try {
      receipt = JSON.parse(sendRequest.receiptJson) as SendReceipt;
    } catch {
      return false;
    }
    const thread = await prisma.thread.findUnique({
      where: { id: sendRequest.threadId },
      select: { platform: true }
    });
    if (!thread) return false;
    await deps.withExternalActionLock(thread.platform as PlatformName, () =>
      deps.withPlatformLock(thread.platform as PlatformName, async () => {
        const authoritative = await prisma.sendRequest.findUnique({
          where: { id: sendRequest.id }
        });
        if (
          !authoritative ||
          authoritative.status !== "SENT" ||
          !authoritative.receiptJson ||
          !needsLocalReconciliation(authoritative.errorJson)
        ) {
          return;
        }
        await projectSentRequest(authoritative, JSON.parse(authoritative.receiptJson));
        await prisma.sendRequest.update({
          where: { id: authoritative.id },
          data: { errorJson: null }
        });
      })
    );
    return true;
  }

  async function reconcileSentProjections(): Promise<number> {
    const pendingRepairs = await prisma.sendRequest.findMany({
      where: {
        status: "SENT",
        source: { not: "manual_poll" },
        errorJson: { contains: LOCAL_RECONCILIATION_REQUIRED }
      }
    });
    let repaired = 0;
    for (const sendRequest of pendingRepairs) {
      try {
        if (await reconcileSentProjectionRow(sendRequest)) repaired += 1;
      } catch (error) {
        console.warn(
          `[send] local reconciliation remains pending for ${sendRequest.clientSendId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return repaired;
  }

  /**
   * Insert a SendRequest in PENDING state and return immediately. The actual
   * adapter call happens in the background, driven by the send-queue worker
   * which calls processSendRequest below. This decouples the dashboard's
   * fetch (which times out after 30s on Next.js's rewrite proxy) from the
   * runner's send (which can take 30s+ when an auto-login is needed first).
   *
   * Idempotent on `clientSendId` — repeated calls return the existing row's
   * current state instead of failing.
   */
  async function enqueueSend(input: {
    threadId: string;
    text: string;
    clientSendId: string;
    attachments?: SendAttachment[];
    source?: SendSource;
    /**
     * App-level threading: when set, the resulting Message row links back
     * to the parent (a Message.id cuid in the same thread). The send still
     * goes out as a normal text bubble — the threading is rendered purely
     * by the dashboard.
     */
    replyToMessageId?: string;
  }): Promise<EnqueueSendResult> {
    const thread = await prisma.thread.findUnique({
      where: { id: input.threadId }
    });
    if (!thread) {
      throw new Error("Thread not found");
    }
    assertInstagramManualTextSend({
      platform: thread.platform as PlatformName,
      attachmentCount: input.attachments?.length ?? 0,
      source: input.source ?? "manual"
    });

    const existing = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (existing) {
      assertExistingSendIntent(existing, {
        ...input,
        source: input.source ?? "manual"
      });
      if (existing.status === "SENT" && existing.receiptJson) {
        await reconcileSentProjectionRow(existing).catch(() => false);
        return {
          clientSendId: input.clientSendId,
          status: "SENT",
          replayed: true,
          result: { ...parseReceipt(existing.receiptJson), replayed: true }
        };
      }
      if (existing.status === "FAILED") {
        return {
          clientSendId: input.clientSendId,
          status: "FAILED",
          replayed: true,
          errorMessage: parseFailedSendMessage(existing.errorJson)
        };
      }
      if (existing.status === "PENDING") {
        return { clientSendId: input.clientSendId, status: "PENDING", replayed: true };
      }
      // SCHEDULED / CANCELLED: the immediate-send path can't replay these. A
      // SCHEDULED row is drained by the scheduled-send promoter, not the
      // PENDING worker, and a CANCELLED row is intentionally dead. Returning
      // "PENDING" here would tell the dashboard the send is queued while
      // nothing ever sends. Surface the real state (mirrors
      // enqueueScheduledSend's conflict throw).
      throw new Error(`Send request ${input.clientSendId} already exists in status ${existing.status}`);
    }

    try {
      await prisma.sendRequest.create({
        data: {
          clientSendId: input.clientSendId,
          threadId: input.threadId,
          requestText: input.text,
          status: "PENDING",
          source: input.source ?? "manual",
          attachmentsJson: normalizedAttachmentsJson(input.attachments),
          replyToMessageId: input.replyToMessageId ?? null
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const winner = await prisma.sendRequest.findUnique({
        where: { clientSendId: input.clientSendId }
      });
      if (!winner) throw new Error("clientSendId conflict could not be reconciled");
      assertExistingSendIntent(winner, {
        ...input,
        source: input.source ?? "manual"
      });
      if (winner.status === "SENT" && winner.receiptJson) {
        await reconcileSentProjectionRow(winner).catch(() => false);
        return {
          clientSendId: input.clientSendId,
          status: "SENT",
          replayed: true,
          result: { ...parseReceipt(winner.receiptJson), replayed: true }
        };
      }
      if (winner.status === "FAILED") {
        return {
          clientSendId: input.clientSendId,
          status: "FAILED",
          replayed: true,
          errorMessage: parseFailedSendMessage(winner.errorJson)
        };
      }
      if (winner.status !== "PENDING") {
        throw new Error(
          `Send request ${input.clientSendId} already exists in status ${winner.status}`
        );
      }
      return { clientSendId: input.clientSendId, status: "PENDING", replayed: true };
    }

    return { clientSendId: input.clientSendId, status: "PENDING", replayed: false };
  }

  /**
   * Drive a single PENDING SendRequest through the adapter call to its
   * terminal SENT or FAILED state. Called by the send-queue worker, never
   * the API handler directly. Updates the SendRequest row, persists the
   * outbound message, updates thread risk state, and emits the
   * MESSAGE_SENT / MESSAGE_SEND_FAILED event so the dashboard's optimistic
   * UI can match by clientSendId.
   *
   * Rows removed by an administrative reset are safe no-ops. Adapter errors
   * are caught and recorded as FAILED on the SendRequest.
   */
  async function processSendRequest(sendRequestId: string): Promise<void> {
    const discoveredRequest = await prisma.sendRequest.findUnique({
      where: { id: sendRequestId }
    });
    if (
      !discoveredRequest ||
      discoveredRequest.status !== "PENDING" ||
      isClaimMarker(discoveredRequest.receiptJson)
    ) {
      return;
    }
    const discoveredThread = await prisma.thread.findUnique({
      where: { id: discoveredRequest.threadId },
      select: { platform: true }
    });
    if (!discoveredThread) return;
    const platform = discoveredThread.platform as PlatformName;

    await deps.withExternalActionLock(platform, () =>
      processSendRequestWithExternalLock(sendRequestId, platform)
    );
  }

  async function processSendRequestWithExternalLock(
    sendRequestId: string,
    expectedPlatform: PlatformName
  ): Promise<void> {
    const sendRequest = await prisma.sendRequest.findUnique({
      where: { id: sendRequestId }
    });
    if (!sendRequest) return;
    const claimedSendRequest = sendRequest;
    if (sendRequest.status !== "PENDING") {
      // Already processed — nothing to do. Defensive against double-kicks.
      return;
    }
    // An in-doubt row left behind by a crash mid-send (PENDING + claim marker)
    // must NOT be re-dispatched — the adapter send is not idempotent, so a
    // blind retry would re-message the recipient. resume() reconciles these to
    // FAILED before draining; if one slips through (a kick raced the
    // reconcile), refuse it here too.
    if (isClaimMarker(sendRequest.receiptJson)) {
      return;
    }

    const thread = await prisma.thread.findUnique({
      where: { id: sendRequest.threadId },
      include: { person: true }
    });
    if (!thread || thread.platform !== expectedPlatform) return;

    // Claim only after the external-action fence and authoritative graph read.
    // A reset that entered the fence first can delete the graph, leaving this
    // worker with nothing to claim or dispatch. The guarded write still keeps
    // concurrent workers and crash recovery idempotent.
    const claim = await prisma.sendRequest.updateMany({
      where: { id: sendRequestId, status: "PENDING", receiptJson: null },
      data: { receiptJson: SEND_CLAIM_MARKER }
    });
    if (claim.count !== 1) return;

    // The threads table can hold rows whose `platform` column has values
    // the typed `PlatformAdapter` registry doesn't cover (e.g. iMessage
    // threads ingested via a separate path). The route-level guard at
    // `/control/thread/:threadId/send` rejects those before they queue,
    // but defensive belt-and-braces here means a stray PENDING row from
    // some other path (manual SQL, future code path) fails with a
    // readable error rather than "Cannot read properties of undefined
    // (reading 'sendMessage')". The existing try/catch below records the
    // thrown message into the SendRequest's errorJson.
    const adapter = (deps.adapters as Record<string, PlatformAdapter | undefined>)[thread.platform];
    const threadStub: ThreadStub = {
      platformThreadId: thread.platformThreadId,
      displayName: thread.person.displayName,
      recipientVerificationLabel: thread.recipientVerificationLabel ?? undefined,
      lastMessagePreview: "",
      threadUrl: thread.threadUrl ?? undefined,
      lastMessageAt: thread.lastMessageAt?.toISOString()
    };

    const jobId = uuid();
    const input = { threadId: thread.id, text: sendRequest.requestText, clientSendId: sendRequest.clientSendId };
    let dispatchStarted = false;
    let deliveredReceipt: SendReceipt | null = null;
    let sentStatePersisted = false;

    function notifyPlatformResult(
      outcome: "success" | "failure",
      finishedAt: string
    ): void {
      try {
        deps.onPlatformResult?.({
          clientSendId: input.clientSendId,
          platform: expectedPlatform,
          outcome,
          finishedAt
        });
      } catch (error) {
        console.warn(
          `[send] platform-result observer failed for ${input.clientSendId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    async function persistDeliveredReceipt(receipt: SendReceipt): Promise<void> {
      deliveredReceipt = receipt;
      await prisma.sendRequest.update({
        where: { clientSendId: input.clientSendId },
        data: {
          status: "SENT",
          receiptJson: JSON.stringify(receipt),
          errorJson: localReconciliationMarker()
        }
      });
      sentStatePersisted = true;
      await projectSentRequest(claimedSendRequest, receipt);
      await prisma.sendRequest.update({
        where: { clientSendId: input.clientSendId },
        data: { errorJson: null }
      });
    }

    try {
      await deps.auditLog({
        platform: thread.platform as PlatformName,
        stage: "Send",
        action: "SEND_START",
        status: "OK",
        details: { threadId: thread.id, clientSendId: input.clientSendId }
      });

      // Presenter sandbox safety branch — ALWAYS evaluated before adapter
      // selection. When the runner is in sandbox demo mode and the target
      // thread is in the seeded demo manifest, route through
      // buildDemoSendReceipt() and skip the platform adapter entirely.
      // The routing branch — not a downstream manifest check — is the
      // safety boundary for adapter-touching operations. If the thread is
      // not in the manifest while sandbox is on, refuse to send.
      const settings = await deps.settingsStore.getSettings();
      const inSandbox = settings.presenterDemoMode === "sandbox";
      let receipt: SendReceipt;
      const stagedAttachments = sendRequest.attachmentsJson
        ? (JSON.parse(sendRequest.attachmentsJson) as Array<{ absolutePath: string; displayName: string; mimeType?: string; kind?: string }>)
        : [];
      const source = parsePersistedSendSource(sendRequest.source);
      if (!source) {
        throw new Error("Unknown persisted send source");
      }
      assertInstagramManualTextSend({
        platform: thread.platform,
        scheduled: Boolean(sendRequest.scheduledFor),
        attachmentCount: stagedAttachments.length,
        source
      });
      if (inSandbox) {
        const manifest = await deps.settingsStore.getDemoSeedManifest();
        if (!manifest || !manifest.threadIds.includes(thread.id)) {
          throw new Error(
            "demo-mode-foreign-thread: sandbox demo refuses to send to a thread outside the seeded demo manifest"
          );
        }
        receipt = buildDemoSendReceipt();
        await persistDeliveredReceipt(receipt);
      } else {
        if (!adapter) {
          throw new Error(
            `Platform ${thread.platform} is not supported by this runner. Supported platforms: ${Object.keys(deps.adapters).join(", ")}.`
          );
        }
        // Serialize the page-driving send against scans on the shared managed
        // page. The demo branch above drives no page, so it stays unlocked.
        receipt = await deps.withPlatformLock(thread.platform as PlatformName, async () => {
          if (source === "focus_auto_ack") {
            const findSupersedingUserRequest = () => prisma.sendRequest.findFirst({
              where: {
                threadId: thread.id,
                source: { in: ["manual", "focus_ack", "manual_poll"] },
                status: { in: ["PENDING", "SENT", "FAILED", "SCHEDULED"] },
                createdAt: { gte: sendRequest.createdAt },
                NOT: { id: sendRequest.id }
              },
              select: { id: true }
            });
            const supersedingUserRequest = await findSupersedingUserRequest();
            if (supersedingUserRequest) {
              throw new SendPolicyError(
                "focus_auto_ack_superseded",
                "Automatic focus acknowledgement was superseded by a user-triggered reply"
              );
            }
            const authoritativeThread = await prisma.thread.findUnique({
              where: { id: thread.id },
              select: {
                id: true,
                platform: true,
                category: true,
                isGroup: true,
                lastInboundAt: true,
                lastOutboundAt: true,
                person: {
                  select: {
                    id: true,
                    displayName: true,
                    birthday: true,
                    favouritedAt: true
                  }
                }
              }
            });
            const profile = await deps.settingsStore.getOperatorProfile();
            const autoAckThread: FocusAutoAckThread | null = authoritativeThread
              ? {
                  threadId: authoritativeThread.id,
                  platform: authoritativeThread.platform as PlatformName,
                  isGroup: authoritativeThread.isGroup,
                  category:
                    authoritativeThread.category === "genuine" ||
                    authoritativeThread.category === "outreach"
                      ? authoritativeThread.category
                      : null,
                  person: authoritativeThread.person,
                  latestInboundAt: authoritativeThread.lastInboundAt,
                  latestOutboundAt: authoritativeThread.lastOutboundAt
                }
              : null;
            if (
              !autoAckThread ||
              !focusAutoAckDispatchEligible(
                autoAckThread,
                profile,
                sendRequest.clientSendId,
                new Date(),
                sendRequest.requestText
              )
            ) {
              throw new SendPolicyError(
                "focus_auto_ack_not_eligible",
                "Automatic focus acknowledgement is no longer eligible for this conversation"
              );
            }
            const finalSupersedingUserRequest = await findSupersedingUserRequest();
            const finalProfile = await deps.settingsStore.getOperatorProfile();
            if (
              !focusAutoAckDispatchEligible(
                autoAckThread,
                finalProfile,
                sendRequest.clientSendId,
                new Date(),
                sendRequest.requestText
              )
            ) {
              throw new SendPolicyError(
                "focus_auto_ack_not_eligible",
                "Automatic focus acknowledgement is no longer eligible for this conversation"
              );
            }
            if (
              finalSupersedingUserRequest ||
              (userTriggeredIntentCounts.get(thread.id) ?? 0) > 0
            ) {
              throw new SendPolicyError(
                "focus_auto_ack_superseded",
                "Automatic focus acknowledgement was superseded by a user-triggered reply"
              );
            }
          }
          dispatchStarted = true;
          const delivered = await adapter.sendMessage(
            threadStub,
            input.text,
            stagedAttachments.map((a) => ({
              absolutePath: a.absolutePath,
              displayName: a.displayName,
              mimeType: a.mimeType,
              kind: (a.kind as "voice_note" | "photo" | "video" | "audio" | "pdf" | "sticker" | "gif" | "unknown" | undefined) ?? undefined
            }))
          );
          await persistDeliveredReceipt(delivered);
          return delivered;
        });
      }

      await deps.auditLog({
        platform: thread.platform as PlatformName,
        stage: "Verify",
        action: "MESSAGE_SENT",
        status: "OK",
        details: {
          threadId: thread.id,
          verifiedBy: receipt.verifiedBy
        },
        screenshotFile: receipt.screenshotFile
      }).catch((error) => {
        console.warn(
          `[send] verification audit failed for ${input.clientSendId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });

      const platformResultAt = receipt.platformResultAt ?? new Date().toISOString();
      notifyPlatformResult("success", platformResultAt);
      try {
        deps.eventBus.emit({
          type: "MESSAGE_SENT",
          jobId,
          threadId: thread.id,
          platform: thread.platform as PlatformName,
          clientSendId: input.clientSendId,
          verifiedBy: receipt.verifiedBy,
          acknowledgedAt: receipt.acknowledgedAt,
          platformResultAt
        });
      } catch (error) {
        console.warn(
          `[send] success event failed for ${input.clientSendId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } catch (error) {
      const adapterError = error instanceof AdapterFailure ? error : undefined;
      const errorMessage = describeSendError(error);

      if (sentStatePersisted && (deliveredReceipt as SendReceipt | null)) {
        const reconciledReceipt = deliveredReceipt as unknown as SendReceipt;
        await deps
          .auditLog({
            platform: thread.platform as PlatformName,
            stage: "Verify",
            action: "MESSAGE_SENT_LOCAL_RECONCILIATION_FAILED",
            status: "FAIL",
            details: {
              threadId: thread.id,
              clientSendId: input.clientSendId,
              message: errorMessage
            }
          })
          .catch((auditError) => {
            console.warn(
              `[send] reconciliation audit failed for ${input.clientSendId}: ${
                auditError instanceof Error ? auditError.message : String(auditError)
              }`
            );
          });
        const platformResultAt =
          reconciledReceipt.platformResultAt ?? new Date().toISOString();
        notifyPlatformResult("success", platformResultAt);
        try {
          deps.eventBus.emit({
            type: "MESSAGE_SENT",
            jobId,
            threadId: thread.id,
            platform: thread.platform as PlatformName,
            clientSendId: input.clientSendId,
            verifiedBy: reconciledReceipt.verifiedBy,
            acknowledgedAt: reconciledReceipt.acknowledgedAt,
            platformResultAt
          });
        } catch (eventError) {
          console.warn(
            `[send] reconciliation event failed for ${input.clientSendId}: ${
              eventError instanceof Error ? eventError.message : String(eventError)
            }`
          );
        }
        return;
      }

      // Map the (often opaque) error to a coarse kind the dashboard can
      // turn into a one-tap recovery action ("Open browser to sign in",
      // "Run selector tests", "Reset session", "Retry now").
      const errorKind = dispatchStarted
        ? "DELIVERY_UNCERTAIN"
        : classifySendFailureKind({
            message: errorMessage,
            adapterKind: adapterError?.kind
          });
      const consumerFailure = consumerSendFailure(errorKind);
      const persistedErrorMessage =
        thread.platform === "INSTAGRAM" ? consumerFailure.message : errorMessage;
      const reasonCode =
        error instanceof SendPolicyError
          ? error.reasonCode
          : thread.platform === "INSTAGRAM"
          ? (typeof adapterError?.details?.reason === "string" &&
              /^[a-z][a-z0-9_]{0,80}$/.test(adapterError.details.reason)
              ? adapterError.details.reason
              : undefined) ??
            (/user-triggered sends only/i.test(errorMessage)
              ? "instagram_send_policy_rejected"
              : undefined)
          : undefined;

      let logId: string | undefined;
      try {
        logId = await deps.auditLog({
          platform: thread.platform as PlatformName,
          stage: "Send",
          action: "MESSAGE_SEND_FAILED",
          status: "FAIL",
          details: {
            threadId: thread.id,
            message: errorMessage,
            errorKind
          },
          screenshotFile: adapterError?.screenshotFile,
          domDumpFile: adapterError?.domDumpFile
        });
      } catch (auditError) {
        console.warn(
          `[send] failure audit failed for ${input.clientSendId}: ${
            auditError instanceof Error ? auditError.message : String(auditError)
          }`
        );
      }

      await prisma.sendRequest
        .update({
          where: { clientSendId: input.clientSendId },
          data: {
            status: "FAILED",
            receiptJson: deliveredReceipt
              ? JSON.stringify(deliveredReceipt)
              : sendRequest.receiptJson,
            errorJson: JSON.stringify({
              message: persistedErrorMessage,
              errorKind,
              reasonCode,
              screenshotFile:
                thread.platform === "INSTAGRAM" ? undefined : adapterError?.screenshotFile,
              domDumpFile:
                thread.platform === "INSTAGRAM" ? undefined : adapterError?.domDumpFile,
              logId
            })
          }
        })
        .catch((writeError) => {
          console.warn(
            `[send] terminal failure write failed for ${input.clientSendId}; durable claim retained: ${
              writeError instanceof Error ? writeError.message : String(writeError)
            }`
          );
        });

      const platformResultAt = new Date().toISOString();
      notifyPlatformResult("failure", platformResultAt);
      try {
        deps.eventBus.emit({
          type: "MESSAGE_SEND_FAILED",
          jobId,
          threadId: thread.id,
          platform: thread.platform as PlatformName,
          logId: logId ?? "audit-unavailable",
          clientSendId: input.clientSendId,
          errorMessage: consumerFailure.message,
          errorKind,
          platformResultAt
        });
      } catch (eventError) {
        console.warn(
          `[send] failure event failed for ${input.clientSendId}: ${
            eventError instanceof Error ? eventError.message : String(eventError)
          }`
        );
      }

      // Don't rethrow — the worker already logged FAILED state. Rethrowing
      // would crash the worker loop; we want it to pick up the next pending
      // row. The dashboard learns about the failure via the event +
      // SendRequest row, not via an exception.
    }
  }

  /**
   * Persist a SendRequest in SCHEDULED state with a future scheduledFor
   * timestamp. The scheduled-send promoter ticks periodically and flips
   * SCHEDULED rows whose `scheduledFor <= now()` to PENDING, at which
   * point the existing send-queue worker drains them through the same
   * `processSendRequest` path as immediate sends.
   *
   * Idempotent on `clientSendId` — repeat calls return the existing row's
   * scheduled timestamp instead of failing or double-scheduling.
   */
  async function enqueueScheduledSend(input: {
    threadId: string;
    text: string;
    clientSendId: string;
    scheduledFor: Date;
    attachments?: SendAttachment[];
    replyToMessageId?: string;
  }): Promise<ScheduleSendResult> {
    const thread = await prisma.thread.findUnique({
      where: { id: input.threadId }
    });
    if (!thread) {
      throw new Error("Thread not found");
    }
    assertInstagramManualTextSend({
      platform: thread.platform as PlatformName,
      scheduled: true,
      attachmentCount: input.attachments?.length ?? 0
    });

    if (Number.isNaN(input.scheduledFor.getTime())) {
      throw new Error("scheduledFor must be a valid date");
    }
    if (input.scheduledFor.getTime() <= Date.now()) {
      throw new Error("scheduledFor must be in the future");
    }

    const existing = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (existing) {
      assertExistingSendIntent(existing, {
        ...input,
        source: "manual"
      });
      if (existing.status === "SCHEDULED" && existing.scheduledFor) {
        return {
          clientSendId: input.clientSendId,
          status: "SCHEDULED",
          scheduledFor: existing.scheduledFor.toISOString(),
          replayed: true
        };
      }
      throw new Error(`Send request ${input.clientSendId} already exists in status ${existing.status}`);
    }

    try {
      await prisma.sendRequest.create({
        data: {
          clientSendId: input.clientSendId,
          threadId: input.threadId,
          requestText: input.text,
          status: "SCHEDULED",
          source: "manual",
          scheduledFor: input.scheduledFor,
          replyToMessageId: input.replyToMessageId ?? null,
          attachmentsJson: normalizedAttachmentsJson(input.attachments)
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const winner = await prisma.sendRequest.findUnique({
        where: { clientSendId: input.clientSendId }
      });
      if (!winner) throw new Error("clientSendId conflict could not be reconciled");
      assertExistingSendIntent(winner, {
        ...input,
        source: "manual"
      });
      if (winner.status !== "SCHEDULED" || !winner.scheduledFor) {
        throw new Error(
          `Send request ${input.clientSendId} already exists in status ${winner.status}`
        );
      }
      return {
        clientSendId: input.clientSendId,
        status: "SCHEDULED",
        scheduledFor: winner.scheduledFor.toISOString(),
        replayed: true
      };
    }

    await deps.auditLog({
      platform: thread.platform as PlatformName,
      stage: "Send",
      action: "SEND_SCHEDULED",
      status: "OK",
      details: {
        threadId: input.threadId,
        clientSendId: input.clientSendId,
        scheduledFor: input.scheduledFor.toISOString()
      }
    });

    return {
      clientSendId: input.clientSendId,
      status: "SCHEDULED",
      scheduledFor: input.scheduledFor.toISOString(),
      replayed: false
    };
  }

  /**
   * Cancel a SCHEDULED send before its `scheduledFor` fires. Refuses to
   * touch rows in any other status (PENDING/SENT/FAILED/CANCELLED) so the
   * operator can't accidentally undo a row mid-flight or re-cancel one
   * that's already been processed.
   */
  async function cancelScheduledSend(input: {
    clientSendId: string;
    threadId: string;
  }): Promise<{ cancelled: boolean; reason?: string }> {
    const row = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (!row) {
      return { cancelled: false, reason: "not_found" };
    }
    if (row.threadId !== input.threadId) {
      return { cancelled: false, reason: "thread_mismatch" };
    }
    if (row.status !== "SCHEDULED") {
      return { cancelled: false, reason: `not_scheduled:${row.status}` };
    }

    // Atomic, status-guarded cancel. The scheduled-send promoter runs on its
    // own interval and can flip this row SCHEDULED -> PENDING in the window
    // between the read above and this write; the worker then dispatches it.
    // A plain `update` keyed only on clientSendId would stomp that PENDING/SENT
    // row to CANCELLED — recording a delivered message as cancelled. By
    // guarding on `status: "SCHEDULED"`, we only cancel a row that is *still*
    // scheduled; count === 0 means we lost the race and must not report it
    // cancelled.
    const { count } = await prisma.sendRequest.updateMany({
      where: { clientSendId: input.clientSendId, status: "SCHEDULED" },
      data: { status: "CANCELLED" }
    });
    if (count === 0) {
      return { cancelled: false, reason: "no_longer_scheduled" };
    }

    const thread = await prisma.thread.findUnique({
      where: { id: input.threadId }
    });
    if (thread) {
      await deps.auditLog({
        platform: thread.platform as PlatformName,
        stage: "Send",
        action: "SEND_CANCELLED",
        status: "OK",
        details: {
          threadId: input.threadId,
          clientSendId: input.clientSendId,
          scheduledFor: row.scheduledFor?.toISOString()
        }
      });
    }

    return { cancelled: true };
  }

  /**
   * Update a still-SCHEDULED send's text and/or scheduledFor. Operators
   * commonly schedule a draft, then re-read it, and want to tweak the
   * wording before it goes out — without having to cancel + rewrite +
   * re-schedule from scratch. Validates that the row is still SCHEDULED
   * (PENDING/SENT/FAILED/CANCELLED rows refuse the update so a send
   * that's already in flight can't be rewritten under the worker's
   * feet). Returns the updated text + scheduledFor on success.
   */
  async function updateScheduledSend(input: {
    clientSendId: string;
    threadId: string;
    text?: string;
    scheduledFor?: Date;
  }): Promise<
    | { updated: true; text: string; scheduledFor: string }
    | { updated: false; reason: string }
  > {
    const row = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (!row) return { updated: false, reason: "not_found" };
    if (row.threadId !== input.threadId) return { updated: false, reason: "thread_mismatch" };
    if (row.status !== "SCHEDULED") return { updated: false, reason: `not_scheduled:${row.status}` };

    const nextText = typeof input.text === "string" ? input.text : row.requestText;
    if (nextText.length === 0) return { updated: false, reason: "empty_text" };
    const nextScheduledFor = input.scheduledFor ?? row.scheduledFor;
    if (!nextScheduledFor) return { updated: false, reason: "no_scheduled_for" };
    if (Number.isNaN(nextScheduledFor.getTime())) return { updated: false, reason: "invalid_scheduled_for" };
    if (input.scheduledFor && input.scheduledFor.getTime() <= Date.now()) {
      return { updated: false, reason: "scheduled_for_must_be_future" };
    }

    // Atomic, status-guarded update — same race as cancel: the promoter can
    // promote this row to PENDING between the read above and this write. Guard
    // on `status: "SCHEDULED"` so we never rewrite the text/time of a send the
    // worker has already picked up; count === 0 means it's no longer ours.
    const { count } = await prisma.sendRequest.updateMany({
      where: { clientSendId: input.clientSendId, status: "SCHEDULED" },
      data: { requestText: nextText, scheduledFor: nextScheduledFor }
    });
    if (count === 0) {
      return { updated: false, reason: "no_longer_scheduled" };
    }

    const thread = await prisma.thread.findUnique({ where: { id: input.threadId } });
    if (thread) {
      await deps.auditLog({
        platform: thread.platform as PlatformName,
        stage: "Send",
        action: "SEND_SCHEDULE_UPDATED",
        status: "OK",
        details: {
          threadId: input.threadId,
          clientSendId: input.clientSendId,
          textChanged: typeof input.text === "string" && input.text !== row.requestText,
          scheduledForChanged:
            !!input.scheduledFor && row.scheduledFor?.getTime() !== input.scheduledFor.getTime(),
          scheduledFor: nextScheduledFor.toISOString()
        }
      });
    }

    return {
      updated: true,
      text: nextText,
      scheduledFor: nextScheduledFor.toISOString()
    };
  }

  /**
   * Reconcile send requests left in-doubt by a crash. A row that is still
   * PENDING but already carries the {@link SEND_CLAIM_MARKER} was claimed by a
   * previous process that died before writing the terminal SENT — the adapter
   * send may or may not have physically gone out. Re-dispatching is unsafe
   * (the adapter is not idempotent, no clientSendId on the wire), so these rows
   * are flipped to FAILED with an INTERRUPTED kind and surfaced for the
   * operator to verify and resend by hand. Returns the number reconciled.
   *
   * Called by the send-queue on boot, BEFORE the normal PENDING drain, so an
   * in-doubt row is never picked up by the worker loop.
   */
  async function reconcileInterruptedSends(): Promise<number> {
    const { count } = await prisma.sendRequest.updateMany({
      where: { status: "PENDING", receiptJson: SEND_CLAIM_MARKER },
      data: {
        status: "FAILED",
        errorJson: JSON.stringify({
          message:
            "Send interrupted by a runner restart — the message may or may not have been delivered. Verify in the conversation before resending.",
          errorKind: "INTERRUPTED"
        })
      }
    });
    return count;
  }

  return {
    enqueueSend,
    enqueueScheduledSend,
    cancelScheduledSend,
    updateScheduledSend,
    processSendRequest,
    reconcileInterruptedSends,
    reconcileSentProjections,
    withUserTriggeredIntent,
    registerUserTriggeredIntent
  };
}

export type SendService = ReturnType<typeof createSendService>;
