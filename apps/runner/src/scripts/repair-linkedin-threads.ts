import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isTemporaryLinkedInId, normalizeCanonicalLinkedInThreadId } from "../linkedin/linkedinIdentity.js";
import type { PrismaClient } from "@prisma/client";

let prismaRef: PrismaClient | null = null;

async function getPrisma(): Promise<PrismaClient> {
  if (prismaRef) {
    return prismaRef;
  }
  const dbModule = await import("../db.js");
  prismaRef = dbModule.prisma;
  return prismaRef;
}

export interface RepairThreadRecord {
  id: string;
  platformThreadId: string;
  threadUrl: string | null;
  personId: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export interface RepairMergeAction {
  canonicalId: string;
  keepThreadId: string;
  mergeThreadId: string;
  mergeMessageCount: number;
}

export interface RepairDeleteAction {
  threadId: string;
  reason: "zero_message_unresolved";
}

export interface RepairUnresolvedRecord {
  threadId: string;
  platformThreadId: string;
  threadUrl: string | null;
  messageCount: number;
  reason: "unresolved_canonical_id";
}

export interface RepairPlan {
  merges: RepairMergeAction[];
  deletes: RepairDeleteAction[];
  unresolved: RepairUnresolvedRecord[];
  summary: {
    totalLinkedInThreads: number;
    canonicalGroups: number;
    mergeCandidates: number;
    unresolvedCount: number;
    deleteCandidates: number;
  };
}

export interface RepairBuildOptions {
  deleteZeroMessageUnresolved?: boolean;
}

export interface RepairApplyResult {
  messagesRepointed: number;
  threadsDeleted: number;
  threadsUpdated: number;
  draftsRepointed: number;
  draftsDropped: number;
  sendRequestsRepointed: number;
}

/**
 * Decide what to do with a merge duplicate's Draft and SendRequest rows
 * BEFORE its Thread row is deleted. Both relations cascade-delete on
 * `prisma.thread.delete` (schema: Draft.thread / SendRequest.thread carry
 * `onDelete: Cascade`), so without re-pointing them first a queued or
 * scheduled send — and any saved reply draft — is silently dropped when two
 * LinkedIn threads for the same canonical conversation are merged.
 *
 * Rules:
 * - SendRequest rows always move to the keeper. `clientSendId` is globally
 *   unique so re-pointing never collides; PENDING/SCHEDULED rows are live
 *   queued/scheduled sends that must never vanish, and SENT/FAILED rows are
 *   receipts worth keeping with the surviving thread.
 * - The duplicate's Draft moves to the keeper only when the keeper has no
 *   draft of its own. The keeper is the higher-priority thread (more
 *   messages / more recent), so when it already holds a draft we keep that
 *   one and drop the duplicate's rather than leaving two competing drafts on
 *   one thread (the dashboard save path uses findFirst and would otherwise
 *   surface a non-deterministic pick).
 */
export function planThreadMergeRelinkage(input: {
  keepThreadId: string;
  mergeThreadId: string;
  keeperHasDraft: boolean;
}): { relinkSendRequests: boolean; relinkDraft: boolean; dropDuplicateDraft: boolean } {
  return {
    relinkSendRequests: true,
    relinkDraft: !input.keeperHasDraft,
    dropDuplicateDraft: input.keeperHasDraft
  };
}

/**
 * Resolve the `replyToMessageId` a merged-in message should carry once it has
 * been re-pointed onto the keeper thread.
 *
 * `replyToMessageId` references a parent Message by its cuid `id`. When the
 * duplicate thread's messages are re-created on the keeper they receive brand
 * new cuids (the upsert `create` does not carry the original `id`), so the
 * original parent id is stale the moment the duplicate thread is
 * cascade-deleted. Copying it verbatim would leave a dangling reference.
 *
 * Rules, in order:
 * - No original link → null.
 * - Parent was part of this same merge batch (its old id is in the
 *   old→new map) → point at the parent's new cuid on the keeper.
 * - Parent was NOT in the batch but still resolves to a live Message
 *   (e.g. a cross-thread reply whose parent already lives on the keeper) →
 *   keep the original id.
 * - Otherwise the parent is gone → drop the link (null) rather than dangle.
 */
export function resolveRemappedReplyToMessageId(input: {
  originalReplyToMessageId: string | null;
  oldToNewMessageId: Map<string, string>;
  parentSurvivesOutsideMerge: boolean;
}): string | null {
  const original = input.originalReplyToMessageId;
  if (!original) {
    return null;
  }
  const remapped = input.oldToNewMessageId.get(original);
  if (remapped) {
    return remapped;
  }
  return input.parentSurvivesOutsideMerge ? original : null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function byKeeperPriority(left: RepairThreadRecord, right: RepairThreadRecord): number {
  if (left.messageCount !== right.messageCount) {
    return right.messageCount - left.messageCount;
  }
  const updatedDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return right.id.localeCompare(left.id);
}

export function canonicalizeLinkedInThreadRecord(record: RepairThreadRecord): string | null {
  const canonical = normalizeCanonicalLinkedInThreadId({
    platformThreadId: record.platformThreadId,
    threadUrl: record.threadUrl ?? undefined
  });
  if (!canonical || isTemporaryLinkedInId(canonical)) {
    return null;
  }
  return canonical;
}

export function buildLinkedInRepairPlan(records: RepairThreadRecord[], options: RepairBuildOptions = {}): RepairPlan {
  const canonicalGroups = new Map<string, RepairThreadRecord[]>();
  const unresolved: RepairUnresolvedRecord[] = [];

  for (const record of records) {
    const canonical = canonicalizeLinkedInThreadRecord(record);
    if (!canonical) {
      unresolved.push({
        threadId: record.id,
        platformThreadId: record.platformThreadId,
        threadUrl: record.threadUrl,
        messageCount: record.messageCount,
        reason: "unresolved_canonical_id"
      });
      continue;
    }
    const group = canonicalGroups.get(canonical) ?? [];
    group.push(record);
    canonicalGroups.set(canonical, group);
  }

  const merges: RepairMergeAction[] = [];
  for (const [canonicalId, group] of canonicalGroups.entries()) {
    if (group.length <= 1) {
      continue;
    }
    const sorted = [...group].sort(byKeeperPriority);
    const keeper = sorted[0];
    if (!keeper) {
      continue;
    }
    for (const duplicate of sorted.slice(1)) {
      merges.push({
        canonicalId,
        keepThreadId: keeper.id,
        mergeThreadId: duplicate.id,
        mergeMessageCount: duplicate.messageCount
      });
    }
  }

  const deletes =
    options.deleteZeroMessageUnresolved === true
      ? unresolved
          .filter((entry) => entry.messageCount <= 0)
          .map((entry) => ({
            threadId: entry.threadId,
            reason: "zero_message_unresolved" as const
          }))
      : [];

  return {
    merges,
    deletes,
    unresolved,
    summary: {
      totalLinkedInThreads: records.length,
      canonicalGroups: canonicalGroups.size,
      mergeCandidates: merges.length,
      unresolvedCount: unresolved.length,
      deleteCandidates: deletes.length
    }
  };
}

async function recomputeThreadTemporalFields(prisma: PrismaClient, threadId: string): Promise<boolean> {
  const [any, inbound, outbound] = await Promise.all([
    prisma.message.aggregate({
      where: { threadId },
      _max: { timestamp: true }
    }),
    prisma.message.aggregate({
      where: { threadId, direction: "IN" },
      _max: { timestamp: true }
    }),
    prisma.message.aggregate({
      where: { threadId, direction: "OUT" },
      _max: { timestamp: true }
    })
  ]);

  const lastInboundAt = inbound._max.timestamp ?? null;
  const lastOutboundAt = outbound._max.timestamp ?? null;
  const needsReply = Boolean(lastInboundAt && (!lastOutboundAt || lastInboundAt > lastOutboundAt));

  await prisma.thread.update({
    where: { id: threadId },
    data: {
      lastMessageAt: any._max.timestamp ?? null,
      lastInboundAt,
      lastOutboundAt,
      needsReply
    }
  });

  return true;
}

export async function applyLinkedInRepairPlan(plan: RepairPlan): Promise<RepairApplyResult> {
  const prisma = await getPrisma();
  let messagesRepointed = 0;
  let threadsDeleted = 0;
  let draftsRepointed = 0;
  let draftsDropped = 0;
  let sendRequestsRepointed = 0;

  for (const merge of plan.merges) {
    const sourceMessages = await prisma.message.findMany({
      where: {
        threadId: merge.mergeThreadId
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    // Re-point the duplicate's messages onto the keeper. We record each
    // message's old id -> new (keeper) id so a second pass can remap
    // `replyToMessageId` (which references a Message by cuid) instead of
    // copying the stale id verbatim, which would dangle once the duplicate
    // thread is cascade-deleted below.
    const oldToNewMessageId = new Map<string, string>();
    const pendingReplyLinks: Array<{ newMessageId: string; originalReplyToMessageId: string }> = [];

    for (const message of sourceMessages) {
      let key = message.platformMessageKey;
      const existingOnTarget = await prisma.message.findUnique({
        where: {
          threadId_platformMessageKey: {
            threadId: merge.keepThreadId,
            platformMessageKey: key
          }
        }
      });

      if (
        existingOnTarget &&
        (existingOnTarget.timestamp.getTime() !== message.timestamp.getTime() || existingOnTarget.text !== message.text)
      ) {
        key = `${message.platformMessageKey}:merged:${merge.mergeThreadId.slice(0, 8)}`;
      }

      const upserted = await prisma.message.upsert({
        where: {
          threadId_platformMessageKey: {
            threadId: merge.keepThreadId,
            platformMessageKey: key
          }
        },
        update: {
          direction: message.direction,
          timestamp: message.timestamp,
          text: message.text,
          senderName: message.senderName,
          rawJson: message.rawJson,
          attachmentsJson: message.attachmentsJson,
          sentVia: message.sentVia
        },
        create: {
          threadId: merge.keepThreadId,
          platformMessageKey: key,
          direction: message.direction,
          timestamp: message.timestamp,
          text: message.text,
          senderName: message.senderName,
          rawJson: message.rawJson,
          attachmentsJson: message.attachmentsJson,
          sentVia: message.sentVia
        },
        select: { id: true }
      });
      oldToNewMessageId.set(message.id, upserted.id);
      if (message.replyToMessageId) {
        pendingReplyLinks.push({
          newMessageId: upserted.id,
          originalReplyToMessageId: message.replyToMessageId
        });
      }
      messagesRepointed += 1;
    }

    // Second pass: now that every merged-in message has its new keeper id,
    // remap reply linkage. A parent that was part of this batch points at its
    // new cuid; a parent that still resolves to a live Message (e.g. already
    // on the keeper) is kept; anything else is dropped so we never leave a
    // dangling reference to a message that is about to be cascade-deleted.
    for (const link of pendingReplyLinks) {
      const parentSurvivesOutsideMerge =
        !oldToNewMessageId.has(link.originalReplyToMessageId) &&
        (await prisma.message.findUnique({
          where: { id: link.originalReplyToMessageId },
          select: { id: true }
        })) !== null;
      const resolved = resolveRemappedReplyToMessageId({
        originalReplyToMessageId: link.originalReplyToMessageId,
        oldToNewMessageId,
        parentSurvivesOutsideMerge
      });
      if (resolved !== null) {
        await prisma.message.update({
          where: { id: link.newMessageId },
          data: { replyToMessageId: resolved }
        });
      }
    }

    // Preserve the duplicate's Draft and SendRequest rows before deleting its
    // Thread. Both relations cascade-delete on prisma.thread.delete, so a
    // queued/scheduled send or a saved reply draft would otherwise be lost.
    const keeperDraft = await prisma.draft.findFirst({
      where: { threadId: merge.keepThreadId },
      select: { id: true }
    });
    const relinkage = planThreadMergeRelinkage({
      keepThreadId: merge.keepThreadId,
      mergeThreadId: merge.mergeThreadId,
      keeperHasDraft: keeperDraft !== null
    });

    if (relinkage.relinkSendRequests) {
      const moved = await prisma.sendRequest.updateMany({
        where: { threadId: merge.mergeThreadId },
        data: { threadId: merge.keepThreadId }
      });
      sendRequestsRepointed += moved.count;
    }

    if (relinkage.relinkDraft) {
      const moved = await prisma.draft.updateMany({
        where: { threadId: merge.mergeThreadId },
        data: { threadId: merge.keepThreadId }
      });
      draftsRepointed += moved.count;
    } else if (relinkage.dropDuplicateDraft) {
      const dropped = await prisma.draft.deleteMany({
        where: { threadId: merge.mergeThreadId }
      });
      draftsDropped += dropped.count;
    }

    await prisma.thread.delete({
      where: {
        id: merge.mergeThreadId
      }
    });
    threadsDeleted += 1;
  }

  for (const deletion of plan.deletes) {
    await prisma.thread.delete({
      where: {
        id: deletion.threadId
      }
    });
    threadsDeleted += 1;
  }

  const linkedInThreadIds = await prisma.thread.findMany({
    where: {
      platform: "LINKEDIN"
    },
    select: {
      id: true
    }
  });

  let threadsUpdated = 0;
  for (const thread of linkedInThreadIds) {
    const updated = await recomputeThreadTemporalFields(prisma, thread.id);
    if (updated) {
      threadsUpdated += 1;
    }
  }

  return {
    messagesRepointed,
    threadsDeleted,
    threadsUpdated,
    draftsRepointed,
    draftsDropped,
    sendRequestsRepointed
  };
}

interface CliOptions {
  apply: boolean;
  deleteZeroMessageUnresolved: boolean;
  reportPath?: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    deleteZeroMessageUnresolved: false,
    reportPath: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--delete-zero-message-unresolved") {
      options.deleteZeroMessageUnresolved = true;
      continue;
    }
    if (arg === "--report") {
      options.reportPath = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
}

async function writeRepairReport(path: string, plan: RepairPlan): Promise<void> {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const lines: string[] = [];

  for (const unresolved of plan.unresolved) {
    lines.push(
      JSON.stringify({
        type: "unresolved",
        ...unresolved
      })
    );
  }

  for (const merge of plan.merges) {
    lines.push(
      JSON.stringify({
        type: "merge",
        ...merge
      })
    );
  }

  for (const deletion of plan.deletes) {
    lines.push(
      JSON.stringify({
        type: "delete",
        ...deletion
      })
    );
  }

  await writeFile(resolvedPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

export async function runRepairLinkedInThreads(argv = process.argv.slice(2)): Promise<void> {
  const prisma = await getPrisma();
  const options = parseCliArgs(argv);
  const linkedInThreads = await prisma.thread.findMany({
    where: {
      platform: "LINKEDIN"
    },
    select: {
      id: true,
      platformThreadId: true,
      threadUrl: true,
      personId: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          messages: true
        }
      }
    }
  });
  const records: RepairThreadRecord[] = linkedInThreads.map((thread) => ({
    id: thread.id,
    platformThreadId: clean(thread.platformThreadId),
    threadUrl: thread.threadUrl,
    personId: thread.personId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: thread._count.messages
  }));

  const threadsBefore = records.length;
  const plan = buildLinkedInRepairPlan(records, {
    deleteZeroMessageUnresolved: options.deleteZeroMessageUnresolved
  });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = options.reportPath ?? `./data/repair/linkedin-thread-repair-${timestamp}.ndjson`;
  await writeRepairReport(reportPath, plan);

  let applyResult: RepairApplyResult | null = null;
  if (options.apply) {
    applyResult = await applyLinkedInRepairPlan(plan);
  }

  const threadsAfter = options.apply
    ? await prisma.thread.count({
        where: {
          platform: "LINKEDIN"
        }
      })
    : threadsBefore;

  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    deleteZeroMessageUnresolved: options.deleteZeroMessageUnresolved,
    reportPath: resolve(reportPath),
    threadsBefore,
    threadsAfter,
    mergeCandidates: plan.summary.mergeCandidates,
    unresolvedCandidates: plan.summary.unresolvedCount,
    deleteCandidates: plan.summary.deleteCandidates,
    messagesRepointed: applyResult?.messagesRepointed ?? 0,
    threadsDeleted: applyResult?.threadsDeleted ?? 0,
    threadsUpdated: applyResult?.threadsUpdated ?? 0,
    draftsRepointed: applyResult?.draftsRepointed ?? 0,
    draftsDropped: applyResult?.draftsDropped ?? 0,
    sendRequestsRepointed: applyResult?.sendRequestsRepointed ?? 0
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRepairLinkedInThreads().finally(async () => {
    const prisma = await getPrisma();
    await prisma.$disconnect();
  });
}
