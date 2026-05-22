// Issue #287: a year of message history floods the active inbox. The
// recency horizon keeps Today and the Inbox focused on conversations with
// recent activity. Older threads are not archived or deleted, they are
// only set aside: the Inbox "show all" control and search still reach
// them, and any new message pulls a thread back in.

/** Conversations with no activity in this many days drop out of the active inbox. */
export const INBOX_HORIZON_DAYS = 30;

/**
 * Whether a thread's last activity falls inside the recency horizon. A
 * missing or unparseable timestamp counts as inside, so a thread is never
 * hidden just because its date is unknown.
 */
export function isWithinHorizon(
  lastActivityAt: string | null | undefined,
  now: number = Date.now(),
  horizonDays: number = INBOX_HORIZON_DAYS
): boolean {
  if (!lastActivityAt) return true;
  const ts = Date.parse(lastActivityAt);
  if (Number.isNaN(ts)) return true;
  return now - ts <= horizonDays * 24 * 60 * 60 * 1000;
}
