// Demo / presenter-sandbox threads are seeded with a stable "demo-" prefix on
// their platformThreadId (runner services/demo.ts). The guided pilot tour and
// the presenter sandbox rely on this so the dashboard can show ONLY sandbox
// data while a sandbox flow is active. Without it, the curated walkthrough
// (e.g. the "Open Serena" step) can't resolve its targets on a real, busy
// inbox: the demo thread is buried below the operator's real threads and
// Today/Inbox never render its row.

type WithPlatformThreadId = { platformThreadId?: string | null };

export function isDemoThread(row: WithPlatformThreadId): boolean {
  return (row.platformThreadId ?? "").startsWith("demo-");
}

/**
 * While a sandbox guided flow is active, narrow inbox rows to demo threads
 * only. Outside sandbox flows this is a no-op, so normal Today/Inbox keep
 * showing the operator's real threads.
 */
export function scopeRowsToSandbox<T extends WithPlatformThreadId>(
  rows: T[],
  sandboxActive: boolean
): T[] {
  if (!sandboxActive) return rows;
  return rows.filter(isDemoThread);
}
