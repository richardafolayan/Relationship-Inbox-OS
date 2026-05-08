import type { PlatformAdapter, PlatformName, ThreadStub } from "@inbox-os/core";
import { calculateRisk, stableHash } from "@inbox-os/core";
import { Prisma } from "@prisma/client";
import { v4 as uuid } from "uuid";
import { prisma } from "../db";
import type { EventBus, SettingsStore } from "../types/runtime";
import { AdapterFailure } from "../platforms/utils";

interface SendServiceDeps {
  adapters: Record<PlatformName, PlatformAdapter>;
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

async function waitForSendRequestResolution(input: {
  clientSendId: string;
  threadId: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  const deadline = Date.now() + (input.timeoutMs ?? 30000);

  while (Date.now() < deadline) {
    const existing = await prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });

    if (!existing) {
      throw new Error("Previous send request was not found");
    }

    if (existing.threadId !== input.threadId) {
      throw new Error("clientSendId is already linked to another thread");
    }

    if (existing.status === "SENT" && existing.receiptJson) {
      return {
        ...parseReceipt(existing.receiptJson),
        replayed: true
      };
    }

    if (existing.status === "FAILED") {
      throw new Error(parseFailedSendMessage(existing.errorJson));
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Send request is already in progress. Retry in a moment.");
}

export interface EnqueueSendResult {
  clientSendId: string;
  status: "PENDING" | "SENT" | "FAILED";
  replayed: boolean;
  result?: SendResult;
  errorMessage?: string;
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
          status: "PENDING"
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

    const adapter = deps.adapters[thread.platform as PlatformName];
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

      const receipt = await adapter.sendMessage(threadStub, input.text);

      await prisma.message.upsert({
        where: {
          threadId_platformMessageKey: {
            threadId: thread.id,
            platformMessageKey: stableHash(`${thread.id}|${receipt.sentAt}|OUT|${input.text}`)
          }
        },
        update: {
          text: input.text,
          direction: "OUT",
          timestamp: new Date(receipt.sentAt),
          sentVia: "automation"
        },
        create: {
          threadId: thread.id,
          platformMessageKey: stableHash(`${thread.id}|${receipt.sentAt}|OUT|${input.text}`),
          direction: "OUT",
          timestamp: new Date(receipt.sentAt),
          text: input.text,
          sentVia: "automation"
        }
      });

      const settings = await deps.settingsStore.getSettings();
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
          lastOutboundAt: new Date(receipt.sentAt),
          lastMessageAt: new Date(receipt.sentAt),
          unreadCount: 0,
          // Phase 2: keep the inbox-row preview in sync with whoever sent the
          // most recent message. Without these, the row preview stayed pinned
          // to the last INBOUND even after Richard replied.
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

  return {
    enqueueSend,
    processSendRequest
  };
}

export type SendService = ReturnType<typeof createSendService>;
