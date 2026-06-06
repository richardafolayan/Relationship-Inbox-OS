// Pure builder for the Prisma `where` clause behind
// POST /control/reconnect/refresh-scores' candidate query.
//
// Extracted from index.ts so the candidate set stays in lockstep with the
// dashboard's isReconnectCandidate predicate (apps/dashboard/lib/reconnect.ts)
// and is unit testable without booting Express + Prisma (mirrors
// person-name-action.ts and reassess-on-send.ts).
//
// Why it matters: the dashboard hides a dormant thread from the Reconnect page
// the moment a reply is queued (scheduledSendAt set). The runner's query used to
// filter only on archivedAt / dormancy / not-outreach, so it would spend an AI
// call scoring  and persist reconnectScore + reason + cacheKey onto  a dormant
// thread the dashboard never shows. This helper adds the scheduled-send
// exclusion so producer (runner) and consumer (dashboard) agree on the set.
//
// Mirror of the dashboard predicate's conditions:
//   platform === "LINKEDIN"          -> platform: "LINKEDIN"
//   !archivedAt                      -> archivedAt: null
//   !isWithinHorizon(lastMessageAt)  -> lastMessageAt: { lt: horizonCutoff }
//   category !== "outreach"          -> NOT category outreach
//   !scheduledSendAt                 -> NOT id in scheduledThreadIds
// The dashboard predicate stays authoritative; this only narrows the DB query
// so the two never disagree.

import type { Prisma } from "@prisma/client";

/**
 * Build the Prisma `where` for the reconnect refresh-scores candidate query.
 *
 * @param horizonCutoff Threads with lastMessageAt at or after this instant are
 *   still inside the recency horizon and belong in the Inbox, not Reconnect.
 * @param scheduledThreadIds Thread ids that have a SCHEDULED outbound send. The
 *   operator already teed up a reply, so the dashboard hides them  exclude
 *   them here too. Empty array -> `{ id: { in: [] } }` excludes nothing.
 */
export function buildReconnectCandidateWhere(
  horizonCutoff: Date,
  scheduledThreadIds: string[]
): Prisma.ThreadWhereInput {
  return {
    platform: "LINKEDIN",
    archivedAt: null,
    // Dormant = last activity older than the 30-day horizon. Threads whose
    // lastMessageAt is null are out of scope: the scorer needs at least one
    // timestamp to anchor "days dormant".
    lastMessageAt: { lt: horizonCutoff },
    NOT: [
      // Skip outreach threads regardless of category - reconnecting with a
      // cold pitch contact is the opposite of what this page exists for.
      // Threads without a category yet are still eligible.
      { category: "outreach" },
      // Mirror the dashboard's scheduledSendAt exclusion: a queued reply takes
      // the thread off the Reconnect page, so it must not be scored either.
      { id: { in: scheduledThreadIds } }
    ]
  };
}
