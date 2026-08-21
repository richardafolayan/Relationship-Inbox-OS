import type { OutboundPoll, PlatformAdapter, PlatformName, SendReceipt, ThreadStub } from "@inbox-os/core";
import { calculateRisk, stableHash } from "@inbox-os/core";
import { Prisma, type PrismaClient } from "@prisma/client";
import { v4 as uuid, v5 as uuidv5 } from "uuid";
import { prisma as defaultPrisma } from "../db";
import type { EventBus, SettingsStore } from "../types/runtime";
import { AdapterFailure } from "../platforms/utils";
import { buildDemoSendReceipt } from "./demo-send";
import {
  classifySendFailureKind,
  consumerSendFailure,
  parsePersistedSendFailure
} from "./send-failure";

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
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
  );
}

type StagedAttachment = {
  absolutePath: string;
  displayName: string;
  mimeType?: string;
  kind?: string;
};

type SendRequestKind = "MESSAGE" | "POLL";

interface PendingRequestInput {
  threadId: string;
  text: string;
  clientSendId: string;
  requestKind: SendRequestKind;
  requestPayloadJson: string | null;
  attachmentsJson: string | null;
  replyToMessageId: string | null;
  retryOfClientSendId: string | null;
}

interface PersistedRequestShape {
  clientSendId: string;
  threadId: string;
  status: string;
  requestText: string;
  requestKind?: string | null;
  requestPayloadJson?: string | null;
  retryOfClientSendId?: string | null;
  receiptJson?: string | null;
  errorJson?: string | null;
  attachmentsJson?: string | null;
  replyToMessageId?: string | null;
}

function canonicalJson(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function assertCanonicalRequest(existing: PersistedRequestShape, expected: PendingRequestInput): void {
  const mismatches: string[] = [];
  if (existing.clientSendId !== expected.clientSendId) mismatches.push("clientSendId");
  if (existing.threadId !== expected.threadId) mismatches.push("threadId");
  if (existing.requestText !== expected.text) mismatches.push("text");
  if ((existing.requestKind ?? "MESSAGE") !== expected.requestKind) mismatches.push("requestKind");
  if (canonicalJson(existing.requestPayloadJson) !== canonicalJson(expected.requestPayloadJson)) {
    mismatches.push("requestPayload");
  }
  if (canonicalJson(existing.attachmentsJson) !== canonicalJson(expected.attachmentsJson)) {
    mismatches.push("attachments");
  }
  if ((existing.replyToMessageId ?? null) !== expected.replyToMessageId) {
    mismatches.push("replyToMessageId");
  }
  if ((existing.retryOfClientSendId ?? null) !== expected.retryOfClientSendId) {
    mismatches.push("retryOfClientSendId");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `clientSendId ${expected.clientSendId} payload does not match persisted request (${mismatches.join(", ")})`
    );
  }
}

function parsePersistedPollPayload(value: string | null | undefined): OutboundPoll {
  const parsed = value ? (JSON.parse(value) as Partial<OutboundPoll>) : null;
  if (
    !parsed ||
    typeof parsed.question !== "string" ||
    !Array.isArray(parsed.options) ||
    parsed.options.length < 2 ||
    parsed.options.some((option) => typeof option !== "string")
  ) {
    throw new Error("Persisted poll payload is invalid");
  }
  return {
    question: parsed.question,
    options: parsed.options,
    allowMultipleAnswers: Boolean(parsed.allowMultipleAnswers)
  };
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

/** True when a PENDING row carries the in-flight claim marker (vs. a real receipt). */
export function isClaimMarker(receiptJson: string | null | undefined): boolean {
  return receiptJson === SEND_CLAIM_MARKER;
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

export type RetryReservationResult =
  | { accepted: false; reason: string }
  | { accepted: true; result: EnqueueSendResult };

export function createSendService(deps: SendServiceDeps) {
  // Default to the runner's singleton; tests inject a fake to exercise the
  // scheduled-send race guards without a real database.
  const prisma = deps.prisma ?? defaultPrisma;

  function resultFromExistingRequest(
    existing: PersistedRequestShape,
    expected: PendingRequestInput
  ): EnqueueSendResult {
    assertCanonicalRequest(existing, expected);
    if (existing.status === "SENT") {
      return {
        clientSendId: expected.clientSendId,
        status: "SENT",
        replayed: true,
        result: existing.receiptJson
          ? { ...parseReceipt(existing.receiptJson), replayed: true }
          : undefined
      };
    }
    if (existing.status === "FAILED") {
      return {
        clientSendId: expected.clientSendId,
        status: "FAILED",
        replayed: true,
        errorMessage: parseFailedSendMessage(existing.errorJson)
      };
    }
    if (existing.status === "PENDING") {
      return { clientSendId: expected.clientSendId, status: "PENDING", replayed: true };
    }
    throw new Error(
      `Send request ${expected.clientSendId} already exists in status ${existing.status}`
    );
  }

  async function enqueuePendingRequest(input: PendingRequestInput): Promise<EnqueueSendResult> {
    const thread = await prisma.thread.findUnique({ where: { id: input.threadId } });
    if (!thread) throw new Error("Thread not found");

    const existing = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (existing) return resultFromExistingRequest(existing, input);

    try {
      await prisma.sendRequest.create({
        data: {
          clientSendId: input.clientSendId,
          threadId: input.threadId,
          requestText: input.text,
          requestKind: input.requestKind,
          requestPayloadJson: input.requestPayloadJson,
          retryOfClientSendId: input.retryOfClientSendId,
          status: "PENDING",
          attachmentsJson: input.attachmentsJson,
          replyToMessageId: input.replyToMessageId
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      let winner = await prisma.sendRequest.findUnique({
        where: { clientSendId: input.clientSendId }
      });
      if (!winner && input.retryOfClientSendId) {
        winner = await prisma.sendRequest.findUnique({
          where: { retryOfClientSendId: input.retryOfClientSendId }
        });
      }
      if (!winner) {
        throw new Error(
          `clientSendId ${input.clientSendId} lost an insert race but no winning request was readable`
        );
      }
      return resultFromExistingRequest(winner, input);
    }

    return { clientSendId: input.clientSendId, status: "PENDING", replayed: false };
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
    attachments?: StagedAttachment[];
    /**
     * App-level threading: when set, the resulting Message row links back
     * to the parent (a Message.id cuid in the same thread). The send still
     * goes out as a normal text bubble — the threading is rendered purely
     * by the dashboard.
     */
    replyToMessageId?: string;
  }): Promise<EnqueueSendResult> {
    return enqueuePendingRequest({
      threadId: input.threadId,
      text: input.text,
      clientSendId: input.clientSendId,
      requestKind: "MESSAGE",
      requestPayloadJson: null,
      retryOfClientSendId: null,
      attachmentsJson:
        input.attachments && input.attachments.length > 0
          ? JSON.stringify(input.attachments)
          : null,
      replyToMessageId: input.replyToMessageId ?? null
    });
  }

  async function enqueuePoll(input: {
    threadId: string;
    text: string;
    clientSendId: string;
    poll: OutboundPoll;
  }): Promise<EnqueueSendResult> {
    return enqueuePendingRequest({
      threadId: input.threadId,
      text: input.text,
      clientSendId: input.clientSendId,
      requestKind: "POLL",
      requestPayloadJson: JSON.stringify({
        question: input.poll.question,
        options: input.poll.options,
        allowMultipleAnswers: Boolean(input.poll.allowMultipleAnswers)
      }),
      retryOfClientSendId: null,
      attachmentsJson: null,
      replyToMessageId: null
    });
  }

  /**
   * Drive a single PENDING SendRequest through the adapter call to its
   * terminal SENT or FAILED state. Called by the send-queue worker, never
   * the API handler directly. Updates the SendRequest row, persists the
   * outbound message, updates thread risk state, and emits the
   * MESSAGE_SENT / MESSAGE_SEND_FAILED event so the dashboard's optimistic
   * UI can match by clientSendId.
   *
   * Throws only on programmer-error situations (missing thread row); adapter
   * errors are caught and recorded as FAILED on the SendRequest.
   */
  async function processSendRequest(sendRequestId: string): Promise<void> {
    const sendRequest = await prisma.sendRequest.findUnique({
      where: { id: sendRequestId }
    });
    if (!sendRequest) {
      throw new Error(`SendRequest ${sendRequestId} not found`);
    }
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

    // Atomically claim the row BEFORE the (non-idempotent) adapter send. Only
    // the worker whose guarded write wins (count === 1) proceeds; a concurrent
    // kick or a post-restart resume() sees `receiptJson` already set and bails.
    // Without this, a crash between the physical send and the SENT write at the
    // bottom of this function leaves the row PENDING, and resume() re-dispatches
    // it — sending the message twice.
    const claim = await prisma.sendRequest.updateMany({
      where: { id: sendRequestId, status: "PENDING", receiptJson: null },
      data: { receiptJson: SEND_CLAIM_MARKER }
    });
    if (claim.count !== 1) {
      // Lost the race — another worker already claimed (or terminalised) this
      // row. Do nothing; the winner owns the send.
      return;
    }

    const thread = await prisma.thread.findUnique({
      where: { id: sendRequest.threadId },
      include: { person: true }
    });
    if (!thread) {
      throw new Error(`Thread ${sendRequest.threadId} not found for SendRequest ${sendRequestId}`);
    }

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
      lastMessagePreview: "",
      threadUrl: thread.threadUrl ?? undefined,
      lastMessageAt: thread.lastMessageAt?.toISOString()
    };

    const jobId = uuid();
    const input = { threadId: thread.id, text: sendRequest.requestText, clientSendId: sendRequest.clientSendId };
    const requestKind = (sendRequest.requestKind ?? "MESSAGE") as SendRequestKind;
    let settings: Awaited<ReturnType<SettingsStore["getSettings"]>>;
    let receipt: SendReceipt | null = null;
    const persistReceipt = (received: SendReceipt) =>
      prisma.sendRequest.update({
        where: { clientSendId: input.clientSendId },
        data: {
          status: "SENT",
          receiptJson: JSON.stringify(received),
          errorJson: null
        }
      });

    try {
      await deps.auditLog({
        platform: thread.platform as PlatformName,
        stage: "Send",
        action: "SEND_START",
        status: "OK",
        details: { threadId: thread.id, clientSendId: input.clientSendId, requestKind }
      });

      settings = await deps.settingsStore.getSettings();
      const inSandbox = settings.presenterDemoMode === "sandbox";
      if (inSandbox) {
        const manifest = await deps.settingsStore.getDemoSeedManifest();
        if (!manifest || !manifest.threadIds.includes(thread.id)) {
          throw new Error(
            "demo-mode-foreign-thread: sandbox demo refuses to send to a thread outside the seeded demo manifest"
          );
        }
        receipt = buildDemoSendReceipt();
        await persistReceipt(receipt);
      } else {
        if (!adapter) {
          throw new Error(
            `Platform ${thread.platform} is not supported by this runner. Supported platforms: ${Object.keys(deps.adapters).join(", ")}.`
          );
        }
        receipt = await deps.withPlatformLock(thread.platform as PlatformName, async () => {
          let received: SendReceipt;
          if (requestKind === "POLL") {
            if (!adapter.sendPoll) {
              throw new Error(`Platform ${thread.platform} does not support sending polls`);
            }
            received = await adapter.sendPoll(
              threadStub,
              parsePersistedPollPayload(sendRequest.requestPayloadJson)
            );
          } else {
            if (requestKind !== "MESSAGE") {
              throw new Error(`Unsupported persisted send request kind: ${requestKind}`);
            }
            const stagedAttachments = sendRequest.attachmentsJson
              ? (JSON.parse(sendRequest.attachmentsJson) as StagedAttachment[])
              : [];
            received = await adapter.sendMessage(
              threadStub,
              input.text,
              stagedAttachments.map((attachment) => ({
                absolutePath: attachment.absolutePath,
                displayName: attachment.displayName,
                mimeType: attachment.mimeType,
                kind:
                  (attachment.kind as
                    | "voice_note"
                    | "photo"
                    | "video"
                    | "audio"
                    | "pdf"
                    | "sticker"
                    | "gif"
                    | "unknown"
                    | undefined) ?? undefined
              }))
            );
          }
          // Keep the platform mutex until the receipt is terminal. Admin reset
          // and scans cannot interleave in the delivery-to-durable-state gap.
          receipt = received;
          await persistReceipt(received);
          return received;
        });
      }
    } catch (error) {
      if (receipt) {
        await deps
          .auditLog({
            platform: thread.platform as PlatformName,
            stage: "Send",
            action: "SEND_RECEIPT_PERSIST_FAILED",
            status: "FAIL",
            details: {
              threadId: thread.id,
              clientSendId: input.clientSendId,
              message: describeSendError(error)
            }
          })
          .catch(() => undefined);
        return;
      }
      const adapterError = error instanceof AdapterFailure ? error : undefined;
      const errorMessage = describeSendError(error);

      // Map the (often opaque) error to a coarse kind the dashboard can
      // turn into a one-tap recovery action ("Open browser to sign in",
      // "Run selector tests", "Reset session", "Retry now").
      const errorKind = classifySendFailureKind({
        message: errorMessage,
        adapterKind: adapterError?.kind
      });
      const consumerFailure = consumerSendFailure(errorKind);

      const logId = await deps.auditLog({
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

      await prisma.sendRequest.update({
        where: { clientSendId: input.clientSendId },
        data: {
          status: "FAILED",
          receiptJson: null,
          errorJson: JSON.stringify({
            message: errorMessage,
            errorKind,
            screenshotFile: adapterError?.screenshotFile,
            domDumpFile: adapterError?.domDumpFile,
            logId
          })
        }
      });

      const platformResultAt = new Date().toISOString();
      try {
        deps.onPlatformResult?.({
          clientSendId: input.clientSendId,
          platform: thread.platform as PlatformName,
          outcome: "failure",
          finishedAt: platformResultAt
        });
      } catch {
        // SendRequest is already terminal; metrics must not change delivery state.
      }
      try {
        deps.eventBus.emit({
          type: "MESSAGE_SEND_FAILED",
          jobId,
          threadId: thread.id,
          platform: thread.platform as PlatformName,
          logId,
          clientSendId: input.clientSendId,
          errorMessage: consumerFailure.message,
          errorKind,
          platformResultAt
        });
      } catch {
        // SendRequest remains the durable read model if notification fails.
      }

      // Don't rethrow — the worker already logged FAILED state. Rethrowing
      // would crash the worker loop; we want it to pick up the next pending
      // row. The dashboard learns about the failure via the event +
      // SendRequest row, not via an exception.
      return;
    }

    if (!receipt) {
      throw new Error(`SendRequest ${sendRequestId} completed without a receipt`);
    }

    try {
      const attachmentsJson =
        receipt.attachments && receipt.attachments.length > 0
          ? JSON.stringify(receipt.attachments)
          : null;
      const rawJson = receipt.raw ? JSON.stringify(receipt.raw) : null;
      const replyToMessageId = sendRequest.replyToMessageId ?? null;
      const platformMessageKey =
        receipt.platformMessageKey ??
        stableHash(
          `${thread.id}|${receipt.sentAt}|OUT|${input.text}${requestKind === "POLL" ? "|poll" : ""}`
        );
      await prisma.message.upsert({
        where: {
          threadId_platformMessageKey: {
            threadId: thread.id,
            platformMessageKey
          }
        },
        update: {
          text: input.text,
          direction: "OUT",
          timestamp: new Date(receipt.sentAt),
          sentVia: "automation",
          attachmentsJson,
          rawJson,
          replyToMessageId
        },
        create: {
          threadId: thread.id,
          platformMessageKey,
          direction: "OUT",
          timestamp: new Date(receipt.sentAt),
          text: input.text,
          sentVia: "automation",
          attachmentsJson,
          rawJson,
          replyToMessageId
        }
      });

      const risk = calculateRisk({
        lastInboundAt: thread.lastInboundAt,
        lastOutboundAt: new Date(receipt.sentAt),
        amberHours: settings.amberHours,
        redHours: settings.redHours
      });
      await prisma.thread.update({
        where: { id: thread.id },
        data: {
          needsReply: risk.needsReply,
          riskLevel: risk.level,
          riskReason: risk.riskReason,
          slaDueAt: risk.slaDueAt,
          snoozedUntil: null,
          lastOutboundAt: new Date(receipt.sentAt),
          lastMessageAt: new Date(receipt.sentAt),
          unreadCount: 0,
          lastMessageDirection: "OUT",
          lastMessageText: input.text
        }
      });
    } catch (error) {
      await deps
        .auditLog({
          platform: thread.platform as PlatformName,
          stage: "Verify",
          action: "SEND_PROJECTION_FAILED",
          status: "FAIL",
          details: {
            threadId: thread.id,
            clientSendId: input.clientSendId,
            message: describeSendError(error)
          }
        })
        .catch(() => undefined);
    }

    await deps
      .auditLog({
        platform: thread.platform as PlatformName,
        stage: "Verify",
        action: "MESSAGE_SENT",
        status: "OK",
        details: {
          threadId: thread.id,
          verifiedBy: receipt.verifiedBy,
          requestKind
        },
        screenshotFile: receipt.screenshotFile
      })
      .catch(() => undefined);

    const platformResultAt = receipt.platformResultAt ?? new Date().toISOString();
    try {
      deps.onPlatformResult?.({
        clientSendId: input.clientSendId,
        platform: thread.platform as PlatformName,
        outcome: "success",
        finishedAt: platformResultAt
      });
    } catch {
      // Delivery is already durably terminal; metrics are best-effort.
    }
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
      await deps
        .auditLog({
          platform: thread.platform as PlatformName,
          stage: "Verify",
          action: "SEND_NOTIFICATION_FAILED",
          status: "FAIL",
          details: {
            threadId: thread.id,
            clientSendId: input.clientSendId,
            message: describeSendError(error)
          }
        })
        .catch(() => undefined);
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
    attachments?: StagedAttachment[];
    replyToMessageId?: string;
  }): Promise<ScheduleSendResult> {
    const thread = await prisma.thread.findUnique({
      where: { id: input.threadId }
    });
    if (!thread) {
      throw new Error("Thread not found");
    }

    if (Number.isNaN(input.scheduledFor.getTime())) {
      throw new Error("scheduledFor must be a valid date");
    }
    if (input.scheduledFor.getTime() <= Date.now()) {
      throw new Error("scheduledFor must be in the future");
    }

    const expected: PendingRequestInput = {
      threadId: input.threadId,
      text: input.text,
      clientSendId: input.clientSendId,
      requestKind: "MESSAGE",
      requestPayloadJson: null,
      retryOfClientSendId: null,
      attachmentsJson:
        input.attachments && input.attachments.length > 0
          ? JSON.stringify(input.attachments)
          : null,
      replyToMessageId: input.replyToMessageId ?? null
    };
    const existing = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (existing) {
      assertCanonicalRequest(existing, expected);
      if (existing.status === "SCHEDULED" && existing.scheduledFor) {
        if (existing.scheduledFor.getTime() !== input.scheduledFor.getTime()) {
          throw new Error(
            `clientSendId ${input.clientSendId} scheduledFor does not match persisted request`
          );
        }
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
          requestKind: "MESSAGE",
          requestPayloadJson: null,
          retryOfClientSendId: null,
          status: "SCHEDULED",
          scheduledFor: input.scheduledFor,
          replyToMessageId: input.replyToMessageId ?? null,
          attachmentsJson: input.attachments && input.attachments.length > 0
            ? JSON.stringify(input.attachments)
            : null
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const winner = await prisma.sendRequest.findUnique({
        where: { clientSendId: input.clientSendId }
      });
      if (!winner) {
        throw new Error(
          `clientSendId ${input.clientSendId} lost an insert race but no winning request was readable`
        );
      }
      assertCanonicalRequest(winner, expected);
      if (winner.status !== "SCHEDULED" || !winner.scheduledFor) {
        throw new Error(
          `Send request ${input.clientSendId} already exists in status ${winner.status}`
        );
      }
      if (winner.scheduledFor.getTime() !== input.scheduledFor.getTime()) {
        throw new Error(
          `clientSendId ${input.clientSendId} scheduledFor does not match persisted request`
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

  async function reserveRetry(input: {
    clientSendId: string;
    threadId: string;
  }): Promise<RetryReservationResult> {
    const original = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (!original) return { accepted: false, reason: "not_found" };
    if (original.threadId !== input.threadId) {
      return { accepted: false, reason: "thread_mismatch" };
    }
    if (original.status !== "FAILED") {
      return { accepted: false, reason: `not_failed:${original.status}` };
    }
    if (original.retryOfClientSendId) {
      return { accepted: false, reason: "recovery_attempt_not_retryable" };
    }
    if (!parsePersistedSendFailure(original.errorJson).retrySafe) {
      return { accepted: false, reason: "retry_not_safe" };
    }

    const requestKind = (original.requestKind ?? "MESSAGE") as SendRequestKind;
    if (requestKind !== "MESSAGE" && requestKind !== "POLL") {
      return { accepted: false, reason: "unsupported_request_kind" };
    }
    const retryClientSendId = uuidv5(`retry:${original.clientSendId}`, uuidv5.URL);
    const result = await enqueuePendingRequest({
      threadId: original.threadId,
      text: original.requestText,
      clientSendId: retryClientSendId,
      requestKind,
      requestPayloadJson: original.requestPayloadJson ?? null,
      attachmentsJson: original.attachmentsJson ?? null,
      replyToMessageId: original.replyToMessageId ?? null,
      retryOfClientSendId: original.clientSendId
    });
    return { accepted: true, result };
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
    enqueuePoll,
    enqueueScheduledSend,
    cancelScheduledSend,
    updateScheduledSend,
    reserveRetry,
    processSendRequest,
    reconcileInterruptedSends
  };
}

export type SendService = ReturnType<typeof createSendService>;
