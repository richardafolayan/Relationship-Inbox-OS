import type { PlatformName } from "@inbox-os/core";
import { Prisma, type PrismaClient } from "@prisma/client";

const ACTION_CLAIM_MARKER = "__external_action_claimed__";
const LOCAL_RECONCILIATION_REQUIRED = "local_projection_required";

type ActionType = "message_reaction" | "message_edit" | "poll_vote";

export type DurableExternalActionProjection = {
  id: string;
  clientActionId: string;
  threadId: string;
  targetMessageId: string;
  actionType: string;
  payloadJson: string;
};

export class DurableExternalActionError extends Error {
  constructor(
    message: string,
    readonly reason: "action_in_progress" | "delivery_uncertain" | "action_conflict",
    readonly originalError?: unknown
  ) {
    super(message);
    this.name = "DurableExternalActionError";
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function canonicalPayload(payload: unknown): string {
  if (Array.isArray(payload)) {
    return `[${payload.map((entry) => canonicalPayload(entry)).join(",")}]`;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPayload(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(payload);
}

interface DurableExternalActionDeps {
  prisma: PrismaClient;
  project(row: DurableExternalActionProjection): Promise<void>;
  withExternalActionLock<T>(platform: PlatformName, work: () => Promise<T>): Promise<T>;
  withPlatformLock<T>(platform: PlatformName, work: () => Promise<T>): Promise<T>;
}

export function createDurableExternalActionService(deps: DurableExternalActionDeps) {
  async function projectionIsSuperseded(row: DurableExternalActionProjection): Promise<boolean> {
    if (row.actionType !== "message_edit") return false;
    const latest = await deps.prisma.externalActionRequest.findFirst({
      where: {
        threadId: row.threadId,
        targetMessageId: row.targetMessageId,
        actionType: row.actionType,
        status: "SENT"
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true }
    });
    return Boolean(latest && latest.id !== row.id);
  }

  async function repairProjection(row: DurableExternalActionProjection): Promise<void> {
    if (!(await projectionIsSuperseded(row))) {
      await deps.project(row);
    }
    await deps.prisma.externalActionRequest.update({
      where: { id: row.id },
      data: { errorJson: null }
    });
  }

  async function execute(input: {
    clientActionId: string;
    threadId: string;
    targetMessageId: string;
    actionType: ActionType;
    payload: unknown;
    dispatch(): Promise<void>;
    auditSuccess(): Promise<unknown>;
    auditFailure(error: unknown): Promise<unknown>;
  }): Promise<{ status: "ok"; replayed: boolean }> {
    const payloadJson = canonicalPayload(input.payload);
    const clientActionId = input.clientActionId;

    const assertIntent = (row: {
      threadId: string;
      targetMessageId: string;
      actionType: string;
      payloadJson: string;
    }) => {
      if (
        row.threadId !== input.threadId ||
        row.targetMessageId !== input.targetMessageId ||
        row.actionType !== input.actionType ||
        row.payloadJson !== payloadJson
      ) {
        throw new DurableExternalActionError(
          "The external action identifier is linked to different intent",
          "action_conflict"
        );
      }
    };

    let row = await deps.prisma.externalActionRequest.findUnique({
      where: { clientActionId }
    });
    if (!row) {
      try {
        row = await deps.prisma.externalActionRequest.create({
          data: {
            clientActionId,
            threadId: input.threadId,
            targetMessageId: input.targetMessageId,
            actionType: input.actionType,
            payloadJson,
            status: "PENDING"
          }
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        row = await deps.prisma.externalActionRequest.findUnique({
          where: { clientActionId }
        });
        if (!row) {
          throw new DurableExternalActionError(
            "The external action could not be reconciled safely",
            "action_conflict"
          );
        }
      }
    }
    assertIntent(row);

    if (row.status === "SENT") {
      if (row.errorJson?.includes(LOCAL_RECONCILIATION_REQUIRED)) {
        try {
          await repairProjection(row);
        } catch {
          // SENT remains authoritative and the durable repair marker remains.
        }
      }
      return { status: "ok", replayed: true };
    }
    if (row.status === "FAILED" || row.receiptJson === ACTION_CLAIM_MARKER) {
      throw new DurableExternalActionError(
        "This action may already have reached the conversation. Check it before trying again.",
        "delivery_uncertain"
      );
    }

    const claim = await deps.prisma.externalActionRequest.updateMany({
      where: { id: row.id, status: "PENDING", receiptJson: null },
      data: { receiptJson: ACTION_CLAIM_MARKER }
    });
    if (claim.count !== 1) {
      throw new DurableExternalActionError(
        "This action is already in progress. Check the conversation before trying again.",
        "action_in_progress"
      );
    }

    try {
      await input.dispatch();
    } catch (error) {
      await deps.prisma.externalActionRequest
        .update({
          where: { id: row.id },
          data: {
            status: "FAILED",
            errorJson: JSON.stringify({ reason: "delivery_uncertain" })
          }
        })
        .catch(() => undefined);
      await input.auditFailure(error).catch(() => undefined);
      throw new DurableExternalActionError(
        "This action may already have reached the conversation. Check it before trying again.",
        "delivery_uncertain",
        error
      );
    }

    await deps.prisma.externalActionRequest.update({
      where: { id: row.id },
      data: {
        status: "SENT",
        receiptJson: JSON.stringify({ completedAt: new Date().toISOString() }),
        errorJson: JSON.stringify({ reconciliationRequired: true, reason: LOCAL_RECONCILIATION_REQUIRED })
      }
    });
    try {
      await deps.project(row);
      await deps.prisma.externalActionRequest.update({
        where: { id: row.id },
        data: { errorJson: null }
      });
    } catch {
      // The SENT row and repair marker prevent repeat dispatch and preserve repair work.
    }
    await input.auditSuccess().catch(() => undefined);
    return { status: "ok", replayed: false };
  }

  async function reconcileSentProjections(): Promise<number> {
    const pending = await deps.prisma.externalActionRequest.findMany({
      where: {
        status: "SENT",
        errorJson: { contains: LOCAL_RECONCILIATION_REQUIRED }
      }
    });
    let repaired = 0;
    for (const discovered of pending) {
      const thread = await deps.prisma.thread.findUnique({
        where: { id: discovered.threadId },
        select: { platform: true }
      });
      if (!thread) continue;
      try {
        await deps.withExternalActionLock(thread.platform, () =>
          deps.withPlatformLock(thread.platform, async () => {
            const row = await deps.prisma.externalActionRequest.findUnique({
              where: { id: discovered.id }
            });
            if (
              !row ||
              row.status !== "SENT" ||
              !row.errorJson?.includes(LOCAL_RECONCILIATION_REQUIRED)
            ) {
              return;
            }
            await repairProjection(row);
            repaired += 1;
          })
        );
      } catch (error) {
        console.warn(
          `[external-action] local reconciliation remains pending for ${discovered.clientActionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return repaired;
  }

  return { execute, reconcileSentProjections };
}
