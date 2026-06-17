// One-click thread reassess pipeline (issue #382 / pilot R-0029).
// Extracted from the /control/thread/:threadId/reassess route handler
// so the race-opt-in wiring is testable without booting Express.
//
// Both AI calls in this path opt into the cross-provider race because
// the operator is staring at a spinner and wants the first valid
// result fast. This service is the ONLY production caller that sets
// `race: true` — scan-queue and the stale-summary background refresh
// stay on the chained single-provider path so background work
// doesn't double provider spend.

import type { PrismaClient } from "@prisma/client";
import type { PlatformName } from "@inbox-os/core";
import type { AiService } from "../types/runtime.js";
import { isAiVisibleMessage, prismaMessageToPrompt } from "./ai.js";
import { pickCanonicalThread } from "./canonical-thread.js";

export interface ReassessThreadDeps {
  prisma: PrismaClient;
  aiService: AiService;
  /**
   * Re-summarisation entry point — same shape as runner's
   * `resummarizeThreadById`. Injected so this service can be tested
   * with a stubbed implementation that records its `race` argument.
   * In production this is the closure that ultimately calls
   * `aiService.updateThreadSummary({ race })`.
   */
  resummarize: (
    threadId: string,
    options?: { race?: boolean }
  ) => Promise<
    | { ok: true; summary: string; whatTheyWant: string; openLoops: string[]; needsReply: boolean }
    // `ai_unavailable` (AI fallback used → write skipped) is handled the same
    // as not_found below: `if (!resummarised.ok)` returns kind:"not_found", so
    // the operator gets a clean 404-retry rather than a persisted fallback.
    | { ok: false; reason: "not_found" | "ai_unavailable" }
  >;
  /**
   * Resolve the sibling thread ids for an iMessage Person (phone + email
   * handle chats). Same closure resummarize uses, injected so this service
   * stays DB-free in tests. Only called for IMESSAGE threads.
   */
  siblingThreadIds: (platform: PlatformName, personId: string) => Promise<string[]>;
}

export type ReassessThreadResult =
  | { kind: "not_found" }
  | { kind: "ai_unavailable" }
  | {
      kind: "ok";
      threadId: string;
      summary: string;
      whatTheyWant: string;
      openLoops: string[];
      category: "outreach" | "genuine" | null;
    };

/**
 * Re-run the summary + classify pipeline for one thread.
 *
 * 1. Resummarise (via injected `resummarize`) with race opted in —
 *    burns the cached suggested replies internally and refreshes
 *    summary / whatTheyWant / openLoops.
 * 2. Re-fetch the thread (with its most recent 80 messages, made
 *    chronological by the reverse below — an `asc + take` would
 *    classify off the OLDEST 80 and ignore where the thread has gone
 *    on long conversations) and reclassify outreach vs genuine, again
 *    with race opted in.
 * 3. Burn the suggested-replies cache so the next /data/thread fetch
 *    regenerates them against the new summary / what-they-want /
 *    category. classifyThreadCategory is `.catch(() => null)`-wrapped
 *    upstream so a transient classifier hiccup leaves the existing
 *    category intact rather than blanking it.
 */
export async function runReassessForThread(
  deps: ReassessThreadDeps,
  threadId: string
): Promise<ReassessThreadResult> {
  // Fetch the thread + its recent messages ONCE, up front, so the classifier
  // can run CONCURRENTLY with re-summarisation instead of waiting for it.
  // These were two strictly-serial raced LLM round-trips (summary, then a
  // separate 80-message fetch, then category) while the operator watched a
  // spinner. The classifier keys off the inbound messages and the EXISTING
  // summary/what-they-want, not the freshly-generated summary, so racing the
  // two changes nothing about the category it returns — it just removes one
  // full LLM round-trip from the wall-clock.
  const thread = await deps.prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      person: true,
      messages: {
        orderBy: { timestamp: "desc" },
        take: 80,
        include: { audioTranscription: true }
      }
    }
  });
  if (!thread) {
    return { kind: "not_found" };
  }

  // iMessage splits one Person across handle-specific sibling threads. The
  // thread view and resummarize already MERGE messages across siblings; manual
  // Reassess must match, on BOTH ends:
  //   - classify over the merged sibling messages (not just this row's), and
  //   - target the CANONICAL sibling (most-recent inbound) for the summary
  //     refresh + cache burn.
  // Otherwise Reassess on a dormant high-message-count sibling (e.g. an old
  // phone thread) would refresh THAT row while the readers consult the
  // live email-handle sibling — the operator clicks Reassess and nothing
  // visibly changes. Single-thread iMessage persons and non-iMessage threads
  // skip the extra queries and behave exactly as before.
  let canonicalThreadId = thread.id;
  // Summary/what-they-want fed to the classifier. Default to the requested
  // row's values (correct for single-sibling iMessage persons and every
  // non-iMessage thread); the >1-sibling branch overrides these with the
  // CANONICAL sibling's values so the classifier prompt isn't steered by a
  // dormant sibling's stale AI fields.
  let classifierSummary: string | null = thread.rollingSummary;
  let classifierWhatTheyWant: string | null = thread.whatTheyWant;
  let orderedMessages = [...thread.messages].reverse();
  if (thread.platform === "IMESSAGE") {
    const siblingIds = await deps.siblingThreadIds(
      thread.platform as PlatformName,
      thread.personId
    );
    if (siblingIds.length > 1) {
      const siblingRows = await deps.prisma.thread.findMany({
        where: { id: { in: siblingIds } },
        select: {
          id: true,
          lastInboundAt: true,
          rollingSummary: true,
          whatTheyWant: true,
          _count: { select: { messages: true } }
        }
      });
      const canonicalRow = pickCanonicalThread(
        siblingRows.map((row) => ({
          id: row.id,
          lastInboundAt: row.lastInboundAt,
          messageCount: row._count?.messages ?? 0,
          rollingSummary: row.rollingSummary,
          whatTheyWant: row.whatTheyWant
        }))
      );
      canonicalThreadId = canonicalRow?.id ?? thread.id;
      // AI fields are persisted per-row, so a dormant sibling carries stale
      // summary/what-they-want. Classify off the CANONICAL sibling's values
      // (the row the readers + the summary refresh + the category write all
      // agree on) rather than the requested row's, which may be dormant.
      if (canonicalRow) {
        classifierSummary = canonicalRow.rollingSummary;
        classifierWhatTheyWant = canonicalRow.whatTheyWant;
      }
      const mergedDesc = await deps.prisma.message.findMany({
        where: { threadId: { in: siblingIds } },
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: 80,
        include: { audioTranscription: true }
      });
      orderedMessages = [...mergedDesc].reverse();
    }
  }

  const [resummarised, category] = await Promise.all([
    deps.resummarize(canonicalThreadId, { race: true }),
    deps.aiService
      .classifyThreadCategory({
        platform: thread.platform as PlatformName,
        displayName: thread.person.displayName,
        messages: orderedMessages.map(prismaMessageToPrompt).filter(isAiVisibleMessage),
        summary: classifierSummary,
        whatTheyWant: classifierWhatTheyWant,
        race: true
      })
      .catch(() => null)
  ]);

  // Skip the write when resummarise could not produce a durable AI result. A
  // real missing thread and an exhausted provider chain need different API
  // responses so the dashboard does not tell the operator the thread vanished.
  if (!resummarised.ok) {
    return { kind: resummarised.reason === "ai_unavailable" ? "ai_unavailable" : "not_found" };
  }

  await deps.prisma.thread.update({
    where: { id: canonicalThreadId },
    data: {
      ...(category ? { category } : {}),
      suggestedRepliesCacheKey: null,
      suggestedRepliesJson: null
    }
  });

  // thread.category is `string | null` per the Prisma schema; the
  // runtime enum is always "outreach" / "genuine" / null. Narrow
  // explicitly so the return shape matches the API contract.
  const existingCategory: "outreach" | "genuine" | null =
    thread.category === "outreach" || thread.category === "genuine"
      ? thread.category
      : null;
  return {
    kind: "ok",
    threadId,
    summary: resummarised.summary,
    whatTheyWant: resummarised.whatTheyWant,
    openLoops: resummarised.openLoops,
    category: category ?? existingCategory
  };
}
