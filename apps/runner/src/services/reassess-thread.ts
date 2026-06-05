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
    | { ok: false; reason: "not_found" }
  >;
}

export type ReassessThreadResult =
  | { kind: "not_found" }
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

  const orderedMessages = [...thread.messages].reverse();
  const [resummarised, category] = await Promise.all([
    deps.resummarize(threadId, { race: true }),
    deps.aiService
      .classifyThreadCategory({
        platform: thread.platform as PlatformName,
        displayName: thread.person.displayName,
        messages: orderedMessages.map(prismaMessageToPrompt).filter(isAiVisibleMessage),
        summary: thread.rollingSummary,
        whatTheyWant: thread.whatTheyWant,
        race: true
      })
      .catch(() => null)
  ]);

  // resummarise only reports not_found when the thread vanished mid-flight;
  // treat it as not_found and skip the write (the parallel category result is
  // simply discarded).
  if (!resummarised.ok) {
    return { kind: "not_found" };
  }

  await deps.prisma.thread.update({
    where: { id: thread.id },
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
