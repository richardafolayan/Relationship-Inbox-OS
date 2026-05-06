"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { HealthResponse } from "@/lib/types";

// One-line summary of the runner's current state. The bar shows nothing
// when idle so it doesn't burn screen real estate; it only appears for
// states the user needs to know about (a scan is in progress, a send is
// in flight, sends are queued behind a scan, or a recent send failed).
//
// The state is sourced from two places:
//   1. /runner/health — runnerStatus:"SCANNING" + lastScanAt for the scan
//      progress label.
//   2. /runner/data/send-queue — list of PENDING SendRequests + last 5
//      completed sends. PENDING covers both "queued behind a scan" and
//      "currently being sent through the platform lease" — they're the
//      same row in the DB, just different lease state.
//
// We poll both every 3s. The AppShell already subscribes to /events SSE
// and dispatches a `runner-event` window event for every emitted event;
// we listen and force-refresh on MESSAGE_SENT / MESSAGE_SEND_FAILED /
// SCAN_FINISHED so the bar reacts within ~50ms of the runner side state
// change instead of waiting for the next poll tick.

interface SendQueueItem {
  clientSendId: string;
  threadId: string;
  personName: string;
  platform: string;
  status: "PENDING" | "SENT" | "FAILED";
  requestText?: string;
  enqueuedAt: string;
  queuePosition: number;
}

interface SendQueueRecentItem {
  clientSendId: string;
  threadId: string;
  personName: string;
  platform: string;
  status: "SENT" | "FAILED";
  completedAt: string;
  errorMessage?: string;
}

interface SendQueueResponse {
  activeCount: number;
  active: SendQueueItem[];
  recent: SendQueueRecentItem[];
}

const POLL_INTERVAL_MS = 3000;
// A "recent send" toast (success or failure) hangs around briefly so the user
// sees confirmation even if they were on a different page when the runner
// flipped status. Ignore older completions on first load — only show what
// happened *while the user has the dashboard open*.
const RECENT_FRESHNESS_MS = 8000;

type StatusBarState =
  | { kind: "idle" }
  | { kind: "scanning"; lastScanAt: string | null }
  | {
      kind: "sending";
      personName: string;
      blockedByScan: boolean;
      queuedBehind: number;
    }
  | { kind: "send_failed"; personName: string; message: string }
  | { kind: "send_succeeded"; personName: string };

function computeState(input: { health: HealthResponse | null; queue: SendQueueResponse | null }): StatusBarState {
  const queueActive = input.queue?.active ?? [];
  const head = queueActive[0];
  const blockedByScan = input.health?.runnerStatus === "SCANNING";
  if (head) {
    return {
      kind: "sending",
      personName: head.personName,
      blockedByScan,
      // queue position 0 == the head being processed; everyone after them
      // is the backlog count.
      queuedBehind: Math.max(0, queueActive.length - 1)
    };
  }
  // No active sends. Surface a brief recent-completion banner if anything
  // landed in the last few seconds.
  const recentest = input.queue?.recent[0];
  if (recentest) {
    const completedAt = Date.parse(recentest.completedAt);
    const age = Date.now() - completedAt;
    if (Number.isFinite(age) && age < RECENT_FRESHNESS_MS) {
      if (recentest.status === "FAILED") {
        return {
          kind: "send_failed",
          personName: recentest.personName,
          message: recentest.errorMessage ?? "Send failed"
        };
      }
      return { kind: "send_succeeded", personName: recentest.personName };
    }
  }
  if (blockedByScan) {
    return { kind: "scanning", lastScanAt: input.health?.lastScanAt ?? null };
  }
  return { kind: "idle" };
}

export function SystemStatusBar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [queue, setQueue] = useState<SendQueueResponse | null>(null);
  // Re-render every second when there's a recent send to expire the
  // "Sent to X" banner without an explicit poll. Cheap (no fetches).
  const [, setTick] = useState(0);
  // Refs so the visibility-change handler can fetch without re-creating
  // the polling effect every render.
  const refresh = useCallback(async () => {
    const [healthData, queueData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health").catch(() => null),
      apiGet<SendQueueResponse>("/runner/data/send-queue").catch(() => null)
    ]);
    if (healthData) setHealth(healthData);
    if (queueData) setQueue(queueData);
  }, []);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refreshRef.current(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Fast path: react to runner-emitted events the AppShell SSE already
  // forwards as window events. Cuts perceived latency from ~3s (poll) to
  // ~50ms (event arrival → fetch).
  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      const t = detail?.type;
      if (
        t === "MESSAGE_SENT" ||
        t === "MESSAGE_SEND_FAILED" ||
        t === "SCAN_STARTED" ||
        t === "SCAN_FINISHED" ||
        t === "THREAD_UPDATED"
      ) {
        void refreshRef.current();
      }
    };
    window.addEventListener("runner-event", onEvent as EventListener);
    return () => window.removeEventListener("runner-event", onEvent as EventListener);
  }, []);

  // Tick at 1Hz while a recent-completion banner is showing so it disappears
  // when it ages past RECENT_FRESHNESS_MS without needing another fetch.
  useEffect(() => {
    const recentest = queue?.recent[0];
    if (!recentest) return undefined;
    const age = Date.now() - Date.parse(recentest.completedAt);
    if (!Number.isFinite(age) || age >= RECENT_FRESHNESS_MS) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [queue]);

  const state = computeState({ health, queue });
  if (state.kind === "idle") {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-3 border-b px-6 py-2 text-sm ${stateBackground(state)}`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${stateDotColor(state)} ${state.kind === "scanning" || state.kind === "sending" ? "animate-pulse" : ""}`} />
      <span className="font-medium text-slate-900">{stateLabel(state)}</span>
      {stateDetail(state) ? (
        <span className="text-slate-600">{stateDetail(state)}</span>
      ) : null}
    </div>
  );
}

function stateBackground(state: StatusBarState): string {
  switch (state.kind) {
    case "scanning":
      return "border-blue-200 bg-blue-50/70";
    case "sending":
      return "border-amber-200 bg-amber-50/70";
    case "send_failed":
      return "border-rose-200 bg-rose-50/70";
    case "send_succeeded":
      return "border-emerald-200 bg-emerald-50/70";
    default:
      return "border-slate-200 bg-white";
  }
}

function stateDotColor(state: StatusBarState): string {
  switch (state.kind) {
    case "scanning":
      return "bg-blue-500";
    case "sending":
      return "bg-amber-500";
    case "send_failed":
      return "bg-rose-500";
    case "send_succeeded":
      return "bg-emerald-500";
    default:
      return "bg-slate-400";
  }
}

function stateLabel(state: StatusBarState): string {
  switch (state.kind) {
    case "scanning":
      return "Scanning LinkedIn…";
    case "sending":
      return state.blockedByScan
        ? `Send queued — waiting for scan to finish before replying to ${state.personName}`
        : `Sending reply to ${state.personName}…`;
    case "send_failed":
      return `Failed to send to ${state.personName}`;
    case "send_succeeded":
      return `Sent to ${state.personName}`;
    default:
      return "";
  }
}

function stateDetail(state: StatusBarState): string | null {
  if (state.kind === "sending" && state.queuedBehind > 0) {
    return `${state.queuedBehind} more send${state.queuedBehind === 1 ? "" : "s"} queued`;
  }
  if (state.kind === "send_failed") {
    return state.message;
  }
  return null;
}
