// Per-thread "check for new messages" (rescan) state for the TopStatus
// ticker. Pilot feedback: the rescan progress used to render inline in the
// thread header ("Reading messages…"), which read as part of the chat UI.
// Ongoing work belongs in the top-bar ticker, phrased around the contact
// ("Checking Tola's messages"), with a short-lived result line afterwards
// answering the question the operator actually asked: were there any new
// messages?
//
// Pure reducer + selector + copy, kept out of top-status.tsx so the event
// ordering (start / progress / finish, bulk overlap, stale-entry pruning,
// failed checks) is testable without jsdom. TopStatus feeds it the
// SCAN_THREAD_* runner events it already receives on `runner-event`.

export interface ThreadCheckEventDetail {
  type?: string;
  threadId?: string;
  personName?: string;
  stage?: string;
  newMessages?: number;
  failed?: boolean;
  freshnessComplete?: boolean;
}

interface ThreadCheckActive {
  threadId: string;
  personName: string | null;
  stage: string | null;
  startedAt: number;
}

interface ThreadCheckResult {
  threadId: string;
  personName: string | null;
  // null = unknown (older runner build without the newMessages field).
  newMessages: number | null;
  freshnessComplete: boolean | null;
  completedAt: number;
}

export interface ThreadCheckSnapshot {
  // Insertion-ordered; the most recently started/progressed check sits
  // last and is the one the ticker names during bulk rescans.
  active: ThreadCheckActive[];
  lastResult: ThreadCheckResult | null;
}

export const EMPTY_THREAD_CHECK: ThreadCheckSnapshot = { active: [], lastResult: null };

// Defensive ceiling, mirrors the thread page's own 30s guard: if a
// SCAN_THREAD_FINISHED is lost (SSE drop), the entry ages out instead of
// stranding the ticker in "Checking…" forever.
const THREAD_CHECK_STALE_MS = 45_000;
// How long the result line ("No new messages from Tola") stays up. Same
// shape as TopStatus's RECENT_FRESHNESS_MS for completed sends.
export const THREAD_CHECK_RESULT_FRESH_MS = 8_000;

export function isThreadCheckEvent(type: string | undefined): boolean {
  return (
    type === "SCAN_THREAD_STARTED" ||
    type === "SCAN_THREAD_PROGRESS" ||
    type === "SCAN_THREAD_FINISHED"
  );
}

export function reduceThreadCheck(
  prev: ThreadCheckSnapshot,
  detail: ThreadCheckEventDetail,
  now: number
): ThreadCheckSnapshot {
  if (!detail.threadId || !isThreadCheckEvent(detail.type)) return prev;
  const active = prev.active.filter((e) => now - e.startedAt < THREAD_CHECK_STALE_MS);
  if (detail.type === "SCAN_THREAD_FINISHED") {
    return {
      active: active.filter((e) => e.threadId !== detail.threadId),
      // A failed check keeps the previous result (if any) instead of
      // minting a false "No new messages" — the failure itself surfaces
      // through the thread page's error handling.
      lastResult: detail.failed
        ? prev.lastResult
        : {
            threadId: detail.threadId,
            personName: detail.personName ?? null,
            newMessages: typeof detail.newMessages === "number" ? detail.newMessages : null,
            freshnessComplete:
              typeof detail.freshnessComplete === "boolean" ? detail.freshnessComplete : null,
            completedAt: now
          }
    };
  }
  const existing = active.find((e) => e.threadId === detail.threadId);
  const entry: ThreadCheckActive = {
    threadId: detail.threadId,
    personName: detail.personName ?? existing?.personName ?? null,
    stage: detail.stage ?? existing?.stage ?? null,
    startedAt: existing?.startedAt ?? now
  };
  return {
    active: [...active.filter((e) => e.threadId !== detail.threadId), entry],
    lastResult: prev.lastResult
  };
}

export type ThreadCheckTicker =
  | { kind: "checking"; personName: string | null; count: number }
  | { kind: "checked"; personName: string | null; newMessages: number | null }
  | { kind: "incomplete"; personName: string | null }
  | { kind: "none" };

export function selectThreadCheck(snapshot: ThreadCheckSnapshot, now: number): ThreadCheckTicker {
  const active = snapshot.active.filter((e) => now - e.startedAt < THREAD_CHECK_STALE_MS);
  const latest = active[active.length - 1];
  if (latest) {
    return { kind: "checking", personName: latest.personName, count: active.length };
  }
  const result = snapshot.lastResult;
  if (result && now - result.completedAt < THREAD_CHECK_RESULT_FRESH_MS) {
    if (result.freshnessComplete === false) {
      return { kind: "incomplete", personName: result.personName };
    }
    return { kind: "checked", personName: result.personName, newMessages: result.newMessages };
  }
  return { kind: "none" };
}

export function threadCheckLabel(state: ThreadCheckTicker): string {
  if (state.kind === "checking") {
    if (state.count > 1) return `Checking messages for ${state.count} people`;
    return state.personName ? `Checking ${state.personName}'s messages` : "Checking messages";
  }
  if (state.kind === "checked") {
    if (state.newMessages === null) {
      return state.personName ? `Checked ${state.personName}'s messages` : "Checked messages";
    }
    const from = state.personName ? ` from ${state.personName}` : "";
    if (state.newMessages === 0) return `No new messages${from}`;
    return `${state.newMessages} new message${state.newMessages === 1 ? "" : "s"}${from}`;
  }
  if (state.kind === "incomplete") {
    return state.personName
      ? `Message check incomplete for ${state.personName}`
      : "Message check incomplete";
  }
  return "";
}
