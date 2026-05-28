import type { PlatformAdapter, PlatformName, SendReceipt, ThreadStub } from "@inbox-os/core";
import { calculateRisk, stableHash } from "@inbox-os/core";
import { Prisma } from "@prisma/client";
import { v4 as uuid } from "uuid";
import { prisma } from "../db";
import type { EventBus, SettingsStore } from "../types/runtime";
import { AdapterFailure } from "../platforms/utils";
import { buildDemoSendReceipt } from "./demo-send";

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
}

interface SendResult {
  sentAt: string;
  screenshotFile?: string;
  verifiedBy: "bubble_detected" | "timestamp_advanced" | "best_effort";
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

export function createSendService(deps: SendServiceDeps) {
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
    attachments?: Array<{ absolutePath: string; displayName: string; mimeType?: string; kind?: string }>;
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

    const existing = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (existing) {
      if (existing.threadId !== input.threadId) {
        throw new Error("clientSendId is already linked to another thread");
      }
      if (existing.status === "SENT" && existing.receiptJson) {
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
      return { clientSendId: input.clientSendId, status: "PENDING", replayed: true };
    }

    try {
      await prisma.sendRequest.create({
        data: {
          clientSendId: input.clientSendId,
          threadId: input.threadId,
          requestText: input.text,
          status: "PENDING",
          attachmentsJson: input.attachments && input.attachments.length > 0
            ? JSON.stringify(input.attachments)
            : null,
          replyToMessageId: input.replyToMessageId ?? null
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      // Concurrent insert beat us; treat as replay of the existing row.
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
      if (inSandbox) {
        const manifest = await deps.settingsStore.getDemoSeedManifest();
        if (!manifest || !manifest.threadIds.includes(thread.id)) {
          throw new Error(
            "demo-mode-foreign-thread: sandbox demo refuses to send to a thread outside the seeded demo manifest"
          );
        }
        receipt = buildDemoSendReceipt();
      } else {
        if (!adapter) {
          throw new Error(
            `Platform ${thread.platform} is not supported by this runner. Supported platforms: ${Object.keys(deps.adapters).join(", ")}.`
          );
        }
        receipt = await adapter.sendMessage(
          threadStub,
          input.text,
          stagedAttachments.map((a) => ({
            absolutePath: a.absolutePath,
            displayName: a.displayName,
            mimeType: a.mimeType,
            kind: (a.kind as "voice_note" | "photo" | "video" | "audio" | "pdf" | "unknown" | undefined) ?? undefined
          }))
        );
      }

      // Persist platform-side attachments on the OUT row when the adapter
      // captured them post-send (iMessage adapter looks them up from
      // chat.db). Without this, voice notes / photos / videos sent from
      // the composer only show as a text bubble in the dashboard — the
      // attachment guid the IMessageMedia component needs is missing.
      const attachmentsJson =
        receipt.attachments && receipt.attachments.length > 0
          ? JSON.stringify(receipt.attachments)
          : null;
      // App-level threading: when the operator hit "Reply" in the
      // focused-thread view, the SendRequest row carries the parent
      // Message.id. Copy it onto the resulting outbound row so the
      // dashboard renders the new bubble inline under its parent on the
      // next refresh. The send itself goes out as a normal text bubble
      // — the recipient on Messages.app sees no threading at all.
      const replyToMessageId = sendRequest.replyToMessageId ?? null;
      // Prefer the platform-side stable id when the adapter could
      // recover it (iMessage polls chat.db post-send for the row's
      // guid). Falling back to a synthetic stableHash for adapters
      // that can't observe the real id (LinkedIn web UI, group chats
      // without a delivery-status path). Aligning the key with what a
      // later scan writes is how we avoid the same outbound message
      // showing up twice in the timeline.
      const platformMessageKey =
        receipt.platformMessageKey ??
        stableHash(`${thread.id}|${receipt.sentAt}|OUT|${input.text}`);
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
          // Operator replied — the thread no longer needs to be hidden.
          // Clearing snoozedUntil keeps the active inbox honest about
          // whether the conversation is still in deferred state.
          snoozedUntil: null,
          lastOutboundAt: new Date(receipt.sentAt),
          lastMessageAt: new Date(receipt.sentAt),
          unreadCount: 0,
          // Phase 2: keep the inbox-row preview in sync with whoever sent the
          // most recent message. Without these, the row preview stayed pinned
          // to the last INBOUND even after the operator replied.
          lastMessageDirection: "OUT",
          lastMessageText: input.text
        }
      });

      await prisma.sendRequest.update({
        where: { clientSendId: input.clientSendId },
        data: {
          status: "SENT",
          receiptJson: JSON.stringify(receipt)
        }
      });

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
      });

      deps.eventBus.emit({
        type: "MESSAGE_SENT",
        jobId,
        threadId: thread.id,
        platform: thread.platform as PlatformName,
        clientSendId: input.clientSendId
      });
    } catch (error) {
      const adapterError = error instanceof AdapterFailure ? error : undefined;
      const errorMessage = describeSendError(error);

      // Map the (often opaque) error to a coarse kind the dashboard can
      // turn into a one-tap recovery action ("Open browser to sign in",
      // "Run selector tests", "Reset session", "Retry now").
      const errorKind: "AUTH_REQUIRED" | "SELECTOR_FAIL" | "PROFILE_LOCKED" | "TRANSIENT" | "UNKNOWN" =
        adapterError?.kind === "AUTH_REQUIRED"
          ? "AUTH_REQUIRED"
          : adapterError?.kind === "SELECTOR_MISMATCH"
            ? "SELECTOR_FAIL"
            : /profile.*lock|already in use|singleton/i.test(errorMessage)
              ? "PROFILE_LOCKED"
              : /timeout|temporarily|ECONN|navigation/i.test(errorMessage)
                ? "TRANSIENT"
                : "UNKNOWN";

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
          errorJson: JSON.stringify({
            message: errorMessage,
            errorKind,
            screenshotFile: adapterError?.screenshotFile,
            domDumpFile: adapterError?.domDumpFile,
            logId
          })
        }
      });

      deps.eventBus.emit({
        type: "MESSAGE_SEND_FAILED",
        jobId,
        threadId: thread.id,
        platform: thread.platform as PlatformName,
        logId,
        clientSendId: input.clientSendId,
        errorMessage,
        errorKind
      });

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
    attachments?: Array<{ absolutePath: string; displayName: string; mimeType?: string; kind?: string }>;
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

    const existing = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (existing) {
      if (existing.threadId !== input.threadId) {
        throw new Error("clientSendId is already linked to another thread");
      }
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
          scheduledFor: input.scheduledFor,
          attachmentsJson: input.attachments && input.attachments.length > 0
            ? JSON.stringify(input.attachments)
            : null
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      // Concurrent insert beat us; treat as replay.
      return {
        clientSendId: input.clientSendId,
        status: "SCHEDULED",
        scheduledFor: input.scheduledFor.toISOString(),
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

    await prisma.sendRequest.update({
      where: { clientSendId: input.clientSendId },
      data: { status: "CANCELLED" }
    });

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

    await prisma.sendRequest.update({
      where: { clientSendId: input.clientSendId },
      data: { requestText: nextText, scheduledFor: nextScheduledFor }
    });

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

  return {
    enqueueSend,
    enqueueScheduledSend,
    cancelScheduledSend,
    updateScheduledSend,
    processSendRequest
  };
}

export type SendService = ReturnType<typeof createSendService>;
