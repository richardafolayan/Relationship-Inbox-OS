// Identity guard for thread-scoped async results.
//
// The thread page does not remount when navigating /thread/A -> /thread/B
// (same App Router dynamic segment). An async action started on A — e.g. the
// shorten / warmer transform — can therefore resolve AFTER the operator has
// already switched to B. Writing A's result into B's composer at that point
// is a wrong-recipient hazard: A's text becomes B's draft and could be sent.
//
// `shouldApplyThreadScopedResult` is the single decision: apply the result
// only when the thread the action started on is still the live thread. Callers
// snapshot the route thread id before the await (`startThreadId`) and pass the
// live route thread id (`currentThreadId`) after it resolves.
export function shouldApplyThreadScopedResult(
  startThreadId: string | null | undefined,
  currentThreadId: string | null | undefined
): boolean {
  return startThreadId === currentThreadId;
}

// SSE refetch routing for an iMessage Person split across handle-specific
// sibling threads. A new inbound (or a reassess / scan) that lands on the OTHER
// handle emits its event with the SIBLING's thread id, not the one the operator
// has open — so an exact `eventThreadId === openThreadId` match drops it and the
// rail goes stale. The runner now returns the sibling cohort (`siblingIds`) on
// the ThreadResponse; refetch when the event targets the open thread OR any
// sibling in that cohort. An unrelated thread's event (a scan burst on other
// contacts) is ignored so the open view does not jank. Degrades to exact-id
// matching when `siblingIds` is missing/empty (older runner build).
export function shouldRefetchForThreadEvent(
  eventThreadId: string | null | undefined,
  openThreadId: string | null | undefined,
  siblingIds: readonly string[] | null | undefined
): boolean {
  if (!eventThreadId || !openThreadId) return false;
  if (eventThreadId === openThreadId) return true;
  return Boolean(siblingIds && siblingIds.includes(eventThreadId));
}
