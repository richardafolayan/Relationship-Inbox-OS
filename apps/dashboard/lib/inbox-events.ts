// Inbox live-update event filter (P4L1).
//
// The runner fans out SSE events to the browser as `runner-event` window
// events (see components/layout/app-shell.tsx). The Today page subscribes to
// that stream and refetches on the events that change what a row shows, so a
// finished scan or a send from the thread page / another tab reflects almost
// instantly. The Inbox previously listened only for `runner-resync` plus a 10s
// poll, so it lagged the same data by up to the poll interval (longer in a
// throttled background tab).
//
// This helper is the single source of truth for which runner-event types the
// Inbox should refetch on. It mirrors Today's set. Unlike Today, the Inbox has
// no separate MESSAGE_SENT hero-advance handler, so MESSAGE_SENT is included
// here directly (there is no double-refresh to avoid).

/** Runner-event types that change inbox row data and warrant a refetch. */
const INBOX_REFRESH_EVENT_TYPES = new Set([
  "THREAD_UPDATED",
  "MESSAGES_PERSISTED",
  "MESSAGE_SENT",
  "MESSAGE_SEND_FAILED",
  "SCAN_FINISHED"
]);

/**
 * Whether an inbound `runner-event` of the given type should trigger an inbox
 * refetch. Unknown / missing types (including RESYNC_REQUIRED, which the shell
 * already re-dispatches as a separate `runner-resync` event) return false so
 * the inbox does not refetch on noise.
 */
export function shouldInboxRefreshOnRunnerEvent(type: string | undefined | null): boolean {
  return type != null && INBOX_REFRESH_EVENT_TYPES.has(type);
}
