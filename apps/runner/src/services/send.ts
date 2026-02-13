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

export function createSendService(deps: SendServiceDeps) {
  async function sendMessage(input: {
    threadId: string;
    text: string;
    clientSendId: string;
  }): Promise<SendResult> {
    const thread = await prisma.thread.findUnique({
      where: { id: input.threadId },
      include: { person: true }
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
          ...parseReceipt(existing.receiptJson),
          replayed: true
        };
      }

      if (existing.status === "FAILED") {
        throw new Error(parseFailedSendMessage(existing.errorJson));
      }

      return waitForSendRequestResolution({
        clientSendId: input.clientSendId,
        threadId: input.threadId
      });
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

      return waitForSendRequestResolution({
        clientSendId: input.clientSendId,
        threadId: input.threadId
      });
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
          timestamp: new Date(receipt.sentAt)
        },
        create: {
          threadId: thread.id,
          platformMessageKey: stableHash(`${thread.id}|${receipt.sentAt}|OUT|${input.text}`),
          direction: "OUT",
          timestamp: new Date(receipt.sentAt),
          text: input.text
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
          unreadCount: 0
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
        platform: thread.platform as PlatformName
      });

      return {
        ...receipt,
        replayed: false
      };
    } catch (error) {
      const adapterError = error instanceof AdapterFailure ? error : undefined;

      const logId = await deps.auditLog({
        platform: thread.platform as PlatformName,
        stage: "Send",
        action: "MESSAGE_SEND_FAILED",
        status: "FAIL",
        details: {
          threadId: thread.id,
          message: error instanceof Error ? error.message : String(error)
        },
        screenshotFile: adapterError?.screenshotFile,
        domDumpFile: adapterError?.domDumpFile
      });

      await prisma.sendRequest.update({
        where: { clientSendId: input.clientSendId },
        data: {
          status: "FAILED",
          errorJson: JSON.stringify({
            message: error instanceof Error ? error.message : "Unknown send error",
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
        logId
      });

      throw error;
    }
  }

  return {
    sendMessage
  };
}
