// Resolve the event id an /events SSE connection should resume from.
//
// Two sources can name a resume cursor and they disagree on a long-lived tab:
//   - the `sinceEventId` query param is frozen at the dashboard's AppShell
//     mount (the EventSource URL is built once, with `[]` deps, from the
//     sessionStorage value read at mount time);
//   - the `Last-Event-ID` request header is live — the browser sets it from
//     the last `id:` it actually delivered, so it advances on every event.
//
// On the browser's native auto-reconnect both are sent. The header must win:
// it reflects what the client has already seen, so the runner replays only the
// gap. Preferring the stale query param made `listSince` re-emit the entire
// buffered window (up to MAX_EVENTS) on every reconnect, re-dispatching every
// event and re-triggering the dashboard's refetch fan-out. On the very first
// connection there is no `Last-Event-ID` header yet, so the mount-time
// `sinceEventId` still drives the initial replay.
//
// Coercion mirrors the original inline `Number(... ?? ... ?? 0)`: `??` only
// falls through on null/undefined, and a NaN result is passed through untouched
// (eventBus.listSince already treats NaN as "replay from the buffer start").
export function resolveSseResumeCursor(
  sinceEventIdQuery: unknown,
  lastEventIdHeader: string | undefined
): number {
  return Number(lastEventIdHeader ?? sinceEventIdQuery ?? 0);
}

export function resolveSseResyncReason(input: {
  sinceEventId: number;
  oldestEventId: number;
  newestEventId: number;
}): string | null {
  if (!Number.isFinite(input.sinceEventId) || input.sinceEventId <= 0) return null;
  if (input.oldestEventId > 0 && input.sinceEventId < input.oldestEventId - 1) {
    return "Event replay window exceeded";
  }
  if (input.sinceEventId > input.newestEventId) {
    return "Event cursor is ahead of this runner";
  }
  return null;
}
