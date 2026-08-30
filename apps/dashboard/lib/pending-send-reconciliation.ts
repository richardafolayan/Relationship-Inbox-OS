export interface ReconcilePendingSend {
  clientSendId: string;
  failed?: boolean;
  sentAt: string;
  sessionRevision?: number;
  text: string;
  threadId: string;
  uncertain?: boolean;
}

export interface ReconcileThreadMessage {
  direction: string;
  text: string;
  timestamp: string | null;
}

export function reconcilePendingSendsAgainstThread<T extends ReconcilePendingSend>(
  pendingSends: T[],
  thread: {
    id: string;
    siblingIds?: string[];
    messages: ReconcileThreadMessage[];
  },
  reconcileWindowMs = 5 * 60 * 1000
): T[] {
  const cohort = new Set([thread.id, ...(thread.siblingIds ?? [])]);
  const freshOutTexts = new Map<string, number>();
  for (const message of thread.messages) {
    if (message.direction !== "OUT" || !message.text) continue;
    const timestamp = message.timestamp ? Date.parse(message.timestamp) : NaN;
    if (Number.isNaN(timestamp)) continue;
    const prior = freshOutTexts.get(message.text);
    if (prior === undefined || timestamp > prior) freshOutTexts.set(message.text, timestamp);
  }
  return pendingSends.filter((pending) => {
    if (!cohort.has(pending.threadId)) return true;
    if (pending.failed || pending.uncertain || pending.sessionRevision || !pending.text) return true;
    const timestamp = freshOutTexts.get(pending.text);
    if (timestamp === undefined) return true;
    const pendingTimestamp = Date.parse(pending.sentAt);
    if (Number.isNaN(pendingTimestamp)) return false;
    return Math.abs(timestamp - pendingTimestamp) > reconcileWindowMs;
  });
}

export function pendingSendReconcileKey(pendingSends: ReconcilePendingSend[]): string {
  return pendingSends
    .map((pending) => `${pending.clientSendId}:${pending.failed ? "failed" : "active"}:${pending.uncertain ? "uncertain" : "known"}`)
    .join("|");
}
