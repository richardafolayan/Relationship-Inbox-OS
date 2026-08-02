// Thread re-summarisation pipeline. Extracted from the `resummarizeThreadById`
// closure in index.ts so the summary write — and the issue #385 transcript
// refresh clearing that rides on it — is testable without booting Express.
//
// Both operator-initiated Reassess (race: true) and the background
// stale-summary self-heal (no race) call this through the same thin wrapper
// in index.ts, so clearing the flag here covers both paths.

import type { PrismaClient } from "@prisma/client";
import type { PlatformName, RememberItem } from "@inbox-os/core";
import type { AiService } from "../types/runtime.js";
import { isAiVisibleMessage, prismaMessageToPrompt } from "./ai.js";

export interface ResummarizeThreadDeps {
  prisma: PrismaClient;
  aiService: Pick<AiService, "updateThreadSummary">;
  // iMessage splits one person across handle-specific chats; this resolves
  // the sibling thread ids to merge. Injected so tests don't need the DB.
  siblingThreadIds: (platform: PlatformName, personId: string) => Promise<string[]>;
}

export type ResummarizeThreadResult =
  | { ok: true; summary: string; whatTheyWant: string; openLoops: string[]; needsReply: boolean }
  // `ai_unavailable`: the AI call returned the synthesised FALLBACK (every
  // provider in the chain failed at runtime — expired key, outage, rate-limit,
  // 5xx). We deliberately DO NOT persist it, so a good stored summary is never
  // overwritten with "Conversation with X." Counts as a failure for callers.
  | { ok: false; reason: "not_found" | "ai_unavailable" };

/**
 * Issue #385. The audio-transcription rows whose flag should be cleared after
 * a fresh summary lands: a transcript was upgraded since the last summary
 * (`needsAiRefresh === true`) AND the message actually fed this summary
 * (passes the same `isAiVisibleMessage` filter the prompt builder uses).
 * Returns the message ids to clear; an upgraded transcript on a message the
 * AI never saw (system event, pending/empty voice bubble) is left untouched.
 */
export function transcriptionMessageIdsToRefresh<
  T extends {
    id: string;
    direction: string;
    text: string;
    timestamp: Date | string;
    rawJson?: string | null;
    audioTranscription?: {
      status: string;
      transcript: string | null;
      needsAiRefresh?: boolean | null;
    } | null;
  }
>(messages: readonly T[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!message.audioTranscription?.needsAiRefresh) continue;
    if (!isAiVisibleMessage(prismaMessageToPrompt(message))) continue;
    ids.push(message.id);
  }
  return ids;
}

/**
 * Re-summarise a single thread and persist the result. On a missing thread,
 * returns `{ ok: false }` and writes nothing. On success, writes the summary
 * and — in the SAME transaction — clears `needsAiRefresh` on the transcripts
 * that fed it, so the flag and the summary never disagree. If summary
 * generation throws, the rejection propagates before any write, so a failed
 * Reassess leaves both the summary and the flags untouched.
 */
export async function resummarizeThread(
  deps: ResummarizeThreadDeps,
  threadId: string,
  options?: { race?: boolean; fromScratch?: boolean }
): Promise<ResummarizeThreadResult> {
  const { prisma } = deps;
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { person: true }
  });
  if (!thread) {
    return { ok: false, reason: "not_found" };
  }

  // Mirror the live /data/thread view: for iMessage, merge messages across
  // sibling threads for the same Person. LinkedIn stays thread-scoped.
  const messageThreadFilter =
    thread.platform === "IMESSAGE"
      ? { threadId: { in: await deps.siblingThreadIds(thread.platform as PlatformName, thread.personId) } }
      : { threadId: thread.id };
  // Most RECENT 120 messages (desc + take) then reverse to chronological — an
  // asc + take would summarise the OLDEST 120 and starve the summariser of the
  // live conversation.
  const recentMessagesDesc = await prisma.message.findMany({
    where: messageThreadFilter,
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: 120,
    include: { audioTranscription: true }
  });
  const orderedMessages = [...recentMessagesDesc].reverse();

  const computedNeedsReply = Boolean(
    thread.lastInboundAt &&
      (!thread.lastOutboundAt || thread.lastInboundAt > thread.lastOutboundAt)
  );
  // `fromScratch` drops the prior summary/loops/remember from the prompt so
  // the model regenerates purely from the transcript. Needed to de-poison a
  // summary that already carries a bad value: the prompt feeds the previous
  // summary back and is told to keep it "durable/stable", so a wrong name
  // (e.g. a leaked example name on a nameless thread, with no real recipient
  // name to override it) perpetuates itself across normal re-summarisation.
  const fromScratch = options?.fromScratch ?? false;
  const summary = await deps.aiService.updateThreadSummary({
    displayName: thread.person.displayName,
    // #753: group framing + per-sender transcript labels.
    isGroup: thread.isGroup,
    groupName: thread.groupName ?? null,
    previousSummary: fromScratch ? undefined : (thread.rollingSummary ?? undefined),
    previousOpenLoops:
      fromScratch || !thread.openLoopsJson ? [] : (JSON.parse(thread.openLoopsJson) as string[]),
    previousRemember:
      fromScratch || !thread.rememberJson ? [] : (JSON.parse(thread.rememberJson) as RememberItem[]),
    messages: orderedMessages.map(prismaMessageToPrompt).filter(isAiVisibleMessage),
    needsReply: computedNeedsReply,
    race: options?.race
  });

  // Data-loss guard. updateThreadSummary returns the synthesised FALLBACK
  // (summary "Conversation with {name}.", previous loops, the raw last inbound
  // as whatTheyWant) — NOT a thrown error — when every AI provider in the chain
  // fails at runtime. The key-presence check the backfill does up front can't
  // catch a key that's present but expired, an outage, a rate-limit, or a 5xx.
  // Persisting that fallback overwrites the real summary; with `fromScratch` it
  // degrades to the bare "Conversation with {name}." (no prior to fall back on),
  // so a single bad run could flatten every thread. Treat a fallback result as
  // a FAILURE and write nothing — same signal raceModelJson validates with
  // (source absent ⇒ legacy/mocked, or source.providerId === null ⇒ exhausted).
  const usedFallback = !summary.source || summary.source.providerId === null;
  if (usedFallback) {
    return { ok: false, reason: "ai_unavailable" };
  }

  const summaryData = {
    rollingSummary: summary.summary,
    whatTheyWant: summary.what_they_want,
    openLoopsJson: JSON.stringify(summary.open_loops),
    toneNotesJson: JSON.stringify(summary.tone_notes),
    rememberJson: JSON.stringify(summary.remember),
    replyBriefJson: summary.reply_brief ? JSON.stringify(summary.reply_brief) : null
  };

  const refreshMessageIds = transcriptionMessageIdsToRefresh(orderedMessages);
  const persisted = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.thread.updateMany({
      where: { id: thread.id, updatedAt: thread.updatedAt },
      data: summaryData
    });
    if (updated.count !== 1) return false;
    if (refreshMessageIds.length > 0) {
      await transaction.messageAudioTranscription.updateMany({
        where: { messageId: { in: refreshMessageIds }, needsAiRefresh: true },
        data: { needsAiRefresh: false }
      });
    }
    return true;
  });
  if (!persisted) {
    const latest = await prisma.thread.findUnique({
      where: { id: thread.id },
      select: {
        rollingSummary: true,
        whatTheyWant: true,
        openLoopsJson: true,
        lastInboundAt: true,
        lastOutboundAt: true
      }
    });
    if (!latest) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      summary: latest.rollingSummary ?? "",
      whatTheyWant: latest.whatTheyWant ?? "",
      openLoops: latest.openLoopsJson ? (JSON.parse(latest.openLoopsJson) as string[]) : [],
      needsReply: Boolean(
        latest.lastInboundAt &&
          (!latest.lastOutboundAt || latest.lastInboundAt > latest.lastOutboundAt)
      )
    };
  }

  return {
    ok: true,
    summary: summary.summary,
    whatTheyWant: summary.what_they_want,
    openLoops: summary.open_loops,
    needsReply: summary.needs_reply
  };
}
