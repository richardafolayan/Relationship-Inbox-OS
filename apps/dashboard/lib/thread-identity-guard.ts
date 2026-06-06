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
