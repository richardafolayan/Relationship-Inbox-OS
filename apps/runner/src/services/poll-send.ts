import type {
  PlatformName,
  SendReceipt
} from "@inbox-os/core";
import { calculateRisk, stableHash } from "@inbox-os/core";
import type { PrismaClient } from "@prisma/client";
import type { EventBus, SettingsStore } from "../types/runtime";
import { SEND_CLAIM_MARKER } from "./send";
import {
  consumerSendFailure,
  parsePersistedSendFailure,
  type ConsumerSendFailure
} from "./send-failure";

export const POLL_SEND_SOURCE = "manual_poll";

interface PollSendDeps {
  prisma: PrismaClient;
  settingsStore: Pick<SettingsStore, "getSettings">;
  auditLog(input: {
    platform?: PlatformName;
    stage?: string;
    action: string;
    status: "OK" | "FAIL";
    details?: Record<string, unknown>;
  }): Promise<string>;
  eventBus: Pick<EventBus, "emit">;
}

interface PollSendInput {
  clientSendId: string;
  thread: {
    id: string;
    platform: PlatformName;
    lastInboundAt: Date | null;
  };
  question: string;
  options: string[];
  allowMultipleAnswers: boolean;
  dispatch(): Promise<SendReceipt>;
}

export type PollSendResult =
  | {
      status: "pending";
      clientSendId: string;
      replayed: true;
    }
  | {
      status: "ok";
      clientSendId: string;
      replayed: boolean;
      messageId?: string;
      platformMessageKey: string;
      sentAt: string;
    };

export class PollSendError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly failure?: ConsumerSendFailure
  ) {
    super(message);
    this.name = "PollSendError";
  }
}

export function renderWhatsAppPollText(input: {
  question: string;
  options: string[];
  allowMultipleAnswers?: boolean;
}): string {
  const header = input.allowMultipleAnswers ? "📊 Poll (multi-select)" : "📊 Poll";
  const body = input.question.trim() ? `${header}: ${input.question.trim()}` : header;
  const options = input.options.map((option) => `• ${option.trim()}`).join("\n");
  return options ? `${body}\n${options}` : body;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function parseReceipt(value: string | null): SendReceipt | null {
  if (!value || value === SEND_CLAIM_MARKER) return null;
  try {
    const parsed = JSON.parse(value) as SendReceipt;
    return typeof parsed.sentAt === "string" && typeof parsed.verifiedBy === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function createPollSendService(deps: PollSendDeps) {
  async function send(input: PollSendInput): Promise<PollSendResult> {
    const payloadJson = JSON.stringify({
      kind: "poll",
      question: input.question,
      options: input.options,
      allowMultipleAnswers: input.allowMultipleAnswers
    });
    const requestText = renderWhatsAppPollText(input);
    const settings = await deps.settingsStore.getSettings();

    async function replayExisting(): Promise<PollSendResult> {
      const existing = await deps.prisma.sendRequest.findUnique({
        where: { clientSendId: input.clientSendId }
      });
      if (!existing) {
        throw new PollSendError("Poll reservation disappeared", 409);
      }
      if (
        existing.threadId !== input.thread.id ||
        existing.source !== POLL_SEND_SOURCE ||
        existing.attachmentsJson !== payloadJson
      ) {
        throw new PollSendError(
          "clientSendId is already linked to a different external action",
          409
        );
      }
      if (existing.status === "PENDING") {
        return {
          status: "pending",
          clientSendId: input.clientSendId,
          replayed: true
        };
      }
      if (existing.status === "SENT") {
        const receipt = parseReceipt(existing.receiptJson);
        if (!receipt) {
          throw new PollSendError("Stored poll receipt is invalid", 409);
        }
        return {
          status: "ok",
          clientSendId: input.clientSendId,
          replayed: true,
          platformMessageKey:
            receipt.platformMessageKey ??
            stableHash(`${input.thread.id}|${receipt.sentAt}|OUT|${requestText}|poll`),
          sentAt: receipt.sentAt
        };
      }
      if (existing.status === "FAILED") {
        const failure = parsePersistedSendFailure(existing.errorJson);
        throw new PollSendError(failure.message, 409, failure);
      }
      throw new PollSendError(
        `Poll request already exists in status ${existing.status}`,
        409
      );
    }

    const existing = await deps.prisma.sendRequest.findUnique({
      where: { clientSendId: input.clientSendId }
    });
    if (existing) return replayExisting();

    try {
      await deps.prisma.sendRequest.create({
        data: {
          clientSendId: input.clientSendId,
          threadId: input.thread.id,
          status: "PENDING",
          requestText,
          source: POLL_SEND_SOURCE,
          attachmentsJson: payloadJson,
          receiptJson: SEND_CLAIM_MARKER
        }
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return replayExisting();
    }

    let dispatchStarted = false;
    let receipt: SendReceipt | null = null;
    let sentStatePersisted = false;

    function emitSuccess(delivered: SendReceipt): void {
      try {
        deps.eventBus.emit({
          type: "MESSAGE_SENT",
          jobId: "poll-send",
          threadId: input.thread.id,
          platform: input.thread.platform,
          clientSendId: input.clientSendId,
          verifiedBy: delivered.verifiedBy,
          acknowledgedAt: delivered.acknowledgedAt,
          platformResultAt:
            delivered.platformResultAt ?? new Date().toISOString()
        });
      } catch (error) {
        console.warn(
          `[poll-send] success event failed for ${input.clientSendId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    try {
      dispatchStarted = true;
      receipt = await input.dispatch();
      await deps.prisma.sendRequest.update({
        where: { clientSendId: input.clientSendId },
        data: {
          status: "SENT",
          receiptJson: JSON.stringify(receipt),
          errorJson: null
        }
      });
      sentStatePersisted = true;

      const sentAt = new Date(receipt.sentAt);
      const platformMessageKey =
        receipt.platformMessageKey ??
        stableHash(`${input.thread.id}|${receipt.sentAt}|OUT|${requestText}|poll`);
      const attachmentsJson =
        receipt.attachments && receipt.attachments.length > 0
          ? JSON.stringify(receipt.attachments)
          : null;
      const rawJson = receipt.raw ? JSON.stringify(receipt.raw) : null;
      const message = await deps.prisma.message.upsert({
        where: {
          threadId_platformMessageKey: {
            threadId: input.thread.id,
            platformMessageKey
          }
        },
        update: {
          text: requestText,
          direction: "OUT",
          timestamp: sentAt,
          sentVia: "automation",
          attachmentsJson,
          rawJson
        },
        create: {
          threadId: input.thread.id,
          platformMessageKey,
          direction: "OUT",
          timestamp: sentAt,
          text: requestText,
          sentVia: "automation",
          attachmentsJson,
          rawJson
        }
      });
      const risk = calculateRisk({
        lastInboundAt: input.thread.lastInboundAt,
        lastOutboundAt: sentAt,
        amberHours: settings.amberHours,
        redHours: settings.redHours
      });
      await deps.prisma.thread.update({
        where: { id: input.thread.id },
        data: {
          needsReply: risk.needsReply,
          riskLevel: risk.level,
          riskReason: risk.riskReason,
          slaDueAt: risk.slaDueAt,
          snoozedUntil: null,
          lastOutboundAt: sentAt,
          lastMessageAt: sentAt,
          unreadCount: 0,
          lastMessageDirection: "OUT",
          lastMessageText: requestText
        }
      });
      await deps
        .auditLog({
          platform: input.thread.platform,
          stage: "Send",
          action: "POLL_SEND",
          status: "OK",
          details: {
            threadId: input.thread.id,
            clientSendId: input.clientSendId,
            optionCount: input.options.length,
            allowMultipleAnswers: input.allowMultipleAnswers
          }
        })
        .catch((error) => {
          console.warn(
            `[poll-send] success audit failed for ${input.clientSendId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      emitSuccess(receipt);
      return {
        status: "ok",
        clientSendId: input.clientSendId,
        replayed: false,
        messageId: message.id,
        platformMessageKey,
        sentAt: receipt.sentAt
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sentStatePersisted && receipt) {
        await deps
          .auditLog({
            platform: input.thread.platform,
            stage: "Verify",
            action: "POLL_SENT_LOCAL_RECONCILIATION_FAILED",
            status: "FAIL",
            details: {
              threadId: input.thread.id,
              clientSendId: input.clientSendId,
              message
            }
          })
          .catch(() => undefined);
        emitSuccess(receipt);
        return {
          status: "ok",
          clientSendId: input.clientSendId,
          replayed: false,
          platformMessageKey:
            receipt.platformMessageKey ??
            stableHash(`${input.thread.id}|${receipt.sentAt}|OUT|${requestText}|poll`),
          sentAt: receipt.sentAt
        };
      }

      const failure = consumerSendFailure("DELIVERY_UNCERTAIN");
      let logId = "audit-unavailable";
      try {
        logId = await deps.auditLog({
          platform: input.thread.platform,
          stage: "Send",
          action: "POLL_SEND_FAIL",
          status: "FAIL",
          details: {
            threadId: input.thread.id,
            clientSendId: input.clientSendId,
            errorKind: failure.errorKind,
            message,
            dispatchStarted
          }
        });
      } catch {
        // The claimed request remains the durable safety boundary even when
        // observability is temporarily unavailable.
      }
      await deps.prisma.sendRequest
        .update({
          where: { clientSendId: input.clientSendId },
          data: {
            status: "FAILED",
            receiptJson: receipt ? JSON.stringify(receipt) : SEND_CLAIM_MARKER,
            errorJson: JSON.stringify({
              message: failure.message,
              errorKind: failure.errorKind,
              logId
            })
          }
        })
        .catch(() => undefined);
      try {
        deps.eventBus.emit({
          type: "MESSAGE_SEND_FAILED",
          jobId: "poll-send",
          threadId: input.thread.id,
          platform: input.thread.platform,
          logId,
          clientSendId: input.clientSendId,
          errorMessage: failure.message,
          errorKind: failure.errorKind,
          platformResultAt: new Date().toISOString()
        });
      } catch {
        // The durable FAILED/claimed state remains authoritative.
      }
      throw new PollSendError(failure.message, 409, failure);
    }
  }

  return { send };
}
