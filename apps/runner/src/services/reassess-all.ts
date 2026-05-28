// Bulk "mark for reassess" helper. Used by the new admin action that
// flags every active thread for a fresh AI pass — for example after a
// prompt change ships and the cached briefs/predrafts on existing
// threads are stale.
//
// Semantics: clear the cached AI outputs on every non-archived thread.
// The next time each thread is viewed (predraft pre-warm) or scanned,
// the runner sees no cache and regenerates against the new prompts.
// This is intentionally LAZY — we don't eagerly run AI calls for every
// thread here, because:
//   - With ~hundreds of threads, eager regen takes tens of minutes and
//     hammers the AI provider.
//   - Operators rarely need every thread refreshed simultaneously; they
//     reach for this after a prompt change and then visit threads in
//     priority order. Lazy regen means each thread refreshes exactly
//     when it next matters.
//
// Until a thread is next reassessed (manually or by scan), the dashboard
// falls back to the synthesised brief (chooseDisplayBrief / the runner's
// synthesiseFallbackBrief). That's a known, readable degraded state, not
// a broken one.
//
// Extracted as a pure helper so the endpoint at /control/threads/
// mark-all-for-reassess stays thin and the logic is testable against a
// throwaway Prisma client without booting Express.

import type { PrismaClient } from "@prisma/client";

export interface MarkAllForReassessResult {
  /** Number of active (non-archived) threads whose AI caches were cleared. */
  threadsMarked: number;
}

/**
 * Clear the AI output caches on every non-archived thread so they
 * regenerate against the current prompts on next view / scan.
 *
 * Fields cleared per thread:
 *   - replyBriefJson         → forces brief regen on next /reassess (or
 *                              scan refresh), and falls back to the
 *                              synthesised brief in the meantime
 *   - suggestedRepliesJson   → forces predraft regen on next /predraft
 *                              pre-warm
 *   - suggestedRepliesCacheKey → so the cache-miss path actually triggers
 *
 * Archived threads are deliberately excluded — they're not visible in
 * the inbox and shouldn't burn AI calls.
 */
export async function markAllThreadsForReassess(
  prisma: PrismaClient
): Promise<MarkAllForReassessResult> {
  const result = await prisma.thread.updateMany({
    where: { archivedAt: null },
    data: {
      replyBriefJson: null,
      suggestedRepliesJson: null,
      suggestedRepliesCacheKey: null
    }
  });
  return { threadsMarked: result.count };
}
