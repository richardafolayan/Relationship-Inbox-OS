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
