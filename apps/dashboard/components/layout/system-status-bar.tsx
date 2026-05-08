"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
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
  | { kind: "scanning"; platform?: string | null }
  | { kind: "enriching"; total: number; running: number }
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
    return { kind: "scanning", platform: input.health?.currentScanPlatform ?? null };
  }
  // Enrichment shows up under scanning so the operator sees the heavier
  // signal first when both are happening; an enrichment-only state is
  // still worth surfacing because Scan-all can queue 50+ profiles that
  // take many minutes to drain in the background.
  const enrichmentTotal = input.health?.enrichmentQueue?.total ?? 0;
  if (enrichmentTotal > 0) {
    return {
      kind: "enriching",
      total: enrichmentTotal,
      running: input.health?.enrichmentQueue?.running ?? 0
    };
  }
  return { kind: "idle" };
}

export function SystemStatusBar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [queue, setQueue] = useState<SendQueueResponse | null>(null);
  const [, setTick] = useState(0);
  // Per-task cancel-in-flight flag. Switches the cancel button to a
  // "Cancelling…" label while the runner POST is in flight, then clears
  // when the next /health poll confirms the task left the active state.
  const [cancelling, setCancelling] = useState<"scan" | "enrichment" | null>(null);
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
      case "enriching":
        return "bg-risk-waiting";
      case "send_failed":
        return "bg-risk-overdue";
      case "send_succeeded":
        return "bg-risk-fresh";
      default:
        return "bg-ink-3";
    }
  })();

  // Active states (scan in flight, send in flight, enrichment queue
  // draining) get a thin indeterminate progress sweep + animated
  // trailing dots so the operator can tell at a glance the runner is
  // still working. send_failed / send_succeeded are terminal — no
  // animation.
  const isActive =
    state.kind === "scanning" || state.kind === "sending" || state.kind === "enriching";

  // Cancellable tasks. Sends are intentionally not cancellable from this
  // bar — they're typically short and partly-mid-network when this state
  // is shown; aborting risks duplicate sends or an inconsistent thread.
  // Scans + enrichment-queue drains can be aborted cleanly.
  const cancelTarget: "scan" | "enrichment" | null =
    state.kind === "scanning" ? "scan" : state.kind === "enriching" ? "enrichment" : null;

  const onCancel = async () => {
    if (!cancelTarget || cancelling) return;
    setCancelling(cancelTarget);
    try {
      const path =
        cancelTarget === "scan" ? "/runner/control/scan/abort" : "/runner/control/enrichment/cancel-pending";
      await apiPost(path, {});
      // Trigger an immediate refresh so the bar transitions out of the
      // active state without waiting for the 3s poll tick.
      await refreshRef.current();
    } catch (error) {
      console.warn("[status-bar] cancel failed", error);
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative border-b border-hairline bg-paper px-12 py-2 font-mono text-[12px] text-ink-3"
    >
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-ink-2">
          {stateLabel(state)}
          {isActive ? <AnimatedEllipsis /> : null}
        </span>
        {stateDetail(state) ? <span>· {stateDetail(state)}</span> : null}
        {state.kind === "send_failed" && isPermissionDenied(state.message) ? (
          <button
            type="button"
            onClick={() => void runPermissionReset()}
            className="ml-2 rounded-row border border-hairline bg-paper px-2 py-[2px] font-mono text-[11px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink"
          >
            grant access
          </button>
        ) : null}
        {cancelTarget ? (
          <button
            type="button"
            onClick={() => void onCancel()}
            disabled={!!cancelling}
            className="ml-auto rounded-row border border-hairline bg-paper px-2 py-[2px] font-mono text-[11px] text-ink-3 transition-colors duration-calm hover:border-hairline-strong hover:text-ink disabled:opacity-50"
          >
            {cancelling ? "cancelling…" : "cancel"}
          </button>
        ) : null}
      </div>
      {isActive ? (
        // The dashboard's color tokens are `var(--ink-2)` etc. — opaque
        // CSS variables, so Tailwind's `bg-ink-2/30` opacity-channel
        // syntax doesn't apply (background ends up fully transparent).
        // Use a solid token + element-level opacity instead.
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-[3px] overflow-hidden"
        >
          <div className="animate-progress-sweep h-full w-[30%] rounded-full bg-ink-2 opacity-40" />
        </div>
      ) : null}
    </div>
  );
}

// Three dots that pulse in sequence — replaces the inert "…" character so
// the operator can tell at a glance the task is still running and not
// stuck. Each dot has a staggered delay so they fade in like a wave.
function AnimatedEllipsis() {
  return (
    <span aria-hidden className="ml-[1px] inline-flex">
      {[0, 200, 400].map((delay) => (
        <span
          key={delay}
          className="animate-pulse-dot"
          style={{ animationDelay: `${delay}ms` }}
        >
          .
        </span>
      ))}
    </span>
  );
}

function isPermissionDenied(message: string): boolean {
  return /-1743|not authorized to send Apple events|grant Automation/i.test(message);
}

async function runPermissionReset(): Promise<void> {
  try {
    await fetch("/runner/control/imessage/permission-reset", { method: "POST" });
  } catch {
    // best-effort; operator can still grant via System Settings manually.
  }
}

function platformDisplay(platform: string): string {
  switch (platform) {
    case "LINKEDIN":
      return "linkedin";
    case "IMESSAGE":
      return "iMessage";
    case "INSTAGRAM":
      return "instagram";
    case "TIKTOK":
      return "tiktok";
    default:
      return platform.toLowerCase();
  }
}

function stateLabel(state: StatusBarState): string {
  switch (state.kind) {
    case "scanning":
      // Trailing "…" is now rendered as <AnimatedEllipsis /> in the JSX so
      // it pulses; keeping the bare label here lets aria-live announce a
      // clean string to screen readers.
      return state.platform ? `Scanning ${platformDisplay(state.platform)}` : "Scanning";
    case "enriching":
      return `Enriching ${state.total} profile${state.total === 1 ? "" : "s"}`;
    case "sending":
      return state.blockedByScan
        ? `Send queued — waiting on scan before replying to ${state.personName}`
        : `Sending reply to ${state.personName}`;
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
  if (state.kind === "enriching" && state.running > 0) {
    return `${state.running} in flight`;
  }
  if (state.kind === "send_failed") {
    return state.message;
  }
  return null;
}
