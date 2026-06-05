import type { InboxRow } from "./types";
import { isWithinHorizon } from "./horizon";
import { isLikelyClosed } from "./closed-conversation";

// The Today queue is "tonight's work": the runner's needs-reply set minus
// threads that aren't actually due tonight. A thread belongs in the queue
// when it still needs a reply, has no queued scheduled send, isn't
// optimistically removed, falls inside the recency horizon, and isn't a
// likely-closed conversation.
//
// Extracted so the page's `rows` filter and the MESSAGE_SENT handler share
// one definition of membership: a send for an off-queue thread (a scheduled
// send firing, or replying to a dormant/closed thread from elsewhere) must
// NOT advance Today's "done" counter.
export function isInTodayQueue(row: InboxRow, removedIds: ReadonlySet<string>): boolean {
  return (
    row.needsReply !== false &&
    !row.scheduledSendAt &&
    !removedIds.has(row.id) &&
    isWithinHorizon(row.lastMessageAt) &&
    !isLikelyClosed(row)
  );
}

function riskRank(level: InboxRow["riskLevel"]): number {
  return level === "RED" ? 0 : level === "AMBER" ? 1 : 2;
}

// Order for "tonight's work": most-urgent risk bucket first (overdue →
// waiting → fresh), oldest-waiting first within a bucket. Favourited contacts
// (R-0066 / #483) are lifted to the front of their OWN risk bucket only —
// never across buckets, so an overdue non-favourite still leads a fresh
// favourite. The chronological oldest-inbound order is preserved within the
// favourite / non-favourite split. The first row becomes the Today hero, so a
// favourite's overdue thread naturally leads the screen.
export function sortTodayQueue(rows: readonly InboxRow[]): InboxRow[] {
  return [...rows].sort((a, b) => {
    if (riskRank(a.riskLevel) !== riskRank(b.riskLevel)) {
      return riskRank(a.riskLevel) - riskRank(b.riskLevel);
    }
    const aFav = a.personFavourite ? 0 : 1;
    const bFav = b.personFavourite ? 0 : 1;
    if (aFav !== bFav) {
      return aFav - bFav;
    }
    const aIn = a.lastInboundAt ? Date.parse(a.lastInboundAt) : 0;
    const bIn = b.lastInboundAt ? Date.parse(b.lastInboundAt) : 0;
    return aIn - bIn;
  });
}
