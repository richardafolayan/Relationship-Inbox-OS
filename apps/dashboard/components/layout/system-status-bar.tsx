"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { HealthResponse } from "@/lib/types";

// One-line summary of the runner's current state. Hidden when idle so it
// doesn't burn screen real estate. Voice and tokens follow the new design
// (mono caption, hairline, no shouty colors).

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
const RECENT_FRESHNESS_MS = 8000;

type StatusBarState =
  | { kind: "idle" }
  | { kind: "scanning" }
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
      queuedBehind: Math.max(0, queueActive.length - 1)
    };
  }
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
    return { kind: "scanning" };
  }
  return { kind: "idle" };
}

export function SystemStatusBar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [queue, setQueue] = useState<SendQueueResponse | null>(null);
  const [, setTick] = useState(0);
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

  const dot = (() => {
    switch (state.kind) {
      case "scanning":
      case "sending":
        return "bg-risk-waiting";
      case "send_failed":
        return "bg-risk-overdue";
      case "send_succeeded":
        return "bg-risk-fresh";
      default:
        return "bg-ink-3";
    }
  })();

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 border-b border-hairline bg-paper px-12 py-2 font-mono text-[12px] text-ink-3"
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="text-ink-2">{stateLabel(state)}</span>
      {stateDetail(state) ? <span>· {stateDetail(state)}</span> : null}
    </div>
  );
}

function stateLabel(state: StatusBarState): string {
  switch (state.kind) {
    case "scanning":
      return "Scanning linkedin…";
    case "sending":
      return state.blockedByScan
        ? `Send queued — waiting on scan before replying to ${state.personName}`
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
