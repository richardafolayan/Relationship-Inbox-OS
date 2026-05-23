// Issue #287 phase 3: when an old LinkedIn thread drops out of the active
// inbox (recency horizon, phase 1) it does not just become noise to
// ignore - some of those people are worth a gentle hello after the lull.
// The Reconnect page surfaces those candidates without ever auto-sending
// anything; the operator decides whether to reach out.
//
// Platform split is intentional:
//   - iMessage dormant threads are friends and family; lulls are natural
//     and a system-prompted "you should message your sister" would feel
//     wrong, so they are excluded entirely.
//   - LinkedIn dormant threads are professional or extended-network ties
//     where a deliberate reconnect is exactly what the network is for.
//
// The heuristic stays conservative: only threads that are clearly dormant
// AND clearly not auto-pitch outreach are flagged. Operator-archived
// threads stay out too - if the operator already closed the chapter,
// the Reconnect page should respect that.

import { isWithinHorizon } from "./horizon";

/**
 * The minimum shape of an inbox row needed to decide whether it belongs
 * on the Reconnect page. The component passes full InboxRow values but
 * the helper only reads these few fields, which keeps it easy to test.
 */
export interface ReconnectCandidate {
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
  lastMessageAt: string | null;
  archivedAt?: string | null;
  /** "outreach" | "genuine" | null - see InboxRow.category in types.ts. */
  category?: string | null;
  /** Scheduled outbound send; if present, the operator already has a
   *  reply teed up and the thread should stay out of the suggestions. */
  scheduledSendAt?: string | null;
}

/**
 * Whether the thread is a reconnect candidate under the conservative
 * heuristic above. Returns true only for LinkedIn threads that are
 * outside the recency horizon, not archived, not outreach-tagged, and
 * not already queued for a reply.
 */
export function isReconnectCandidate(row: ReconnectCandidate): boolean {
  if (row.platform !== "LINKEDIN") return false;
  if (row.archivedAt) return false;
  if (row.scheduledSendAt) return false;
  if (row.category === "outreach") return false;
  // Active threads belong in the Inbox; Reconnect only lists the ones
  // that have already aged out of the recency horizon.
  if (isWithinHorizon(row.lastMessageAt)) return false;
  return true;
}

/**
 * Order candidates so the most-recently-dormant threads appear first.
 * Threads that have only just dropped out of the horizon have the best
 * chance of being remembered fondly, so they sit at the top. Threads
 * with an unknown last-activity timestamp sink to the bottom.
 */
export function rankReconnectCandidates<T extends ReconnectCandidate>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
    const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
    return bTs - aTs;
  });
}
