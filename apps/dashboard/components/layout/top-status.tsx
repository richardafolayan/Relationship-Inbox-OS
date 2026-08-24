"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MessageSquareText, Moon } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { formatUntil } from "@/lib/focus";
import { openFocusReview, openFocusSetup, useFocusWindow } from "@/lib/use-focus-window";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { runActionWithFeedback } from "@/lib/feedback";
import { onReassessChange } from "@/lib/reassess-status";
import { onReportSendChange } from "@/lib/pilot-report-status";
import { visibleImplementedPlatforms } from "@/lib/risk";
import { NotificationBell } from "@/components/common/notification-center";
import {
  EMPTY_THREAD_CHECK,
  isThreadCheckEvent,
  reduceThreadCheck,
  selectThreadCheck,
  threadCheckLabel,
  type ThreadCheckEventDetail,
  type ThreadCheckSnapshot
} from "@/lib/thread-check-status";
import type { HealthResponse, PlatformCard } from "@/lib/types";
import {
  type MobileStatusChrome,
  shouldSurfaceHiddenStatus
} from "@/lib/mobile-status-chrome";
import { cn } from "@/lib/utils";
import { openPilotFeedback } from "@/lib/pilot";

// Single 44px status row. Mostly read-only in v1:
//
//   [● 2/4 connected] · [activity ticker with inline progress] (right) [scan Xm ago · Scan now]
//
// Two contextual operator actions are kept: "cancel" during a running
// scan, and "Scan now" when idle - restored after pilot feedback #293
// reported there was no discoverable way to check for new replies.
// The rest of the kebab (Restart runner / Pause all scans / Force
// re-enrich / View logs / Manage platforms) and the iMessage "grant
// access" affordance stay stripped; restore from
// archive/pre-v1-stripback if any of those are also needed.
//
// Mobile density (#914) is route-aware via `mobileChrome`. Desktop (md+)
// always keeps the full row.

const POLL_INTERVAL_MS = 5000;
const RECENT_FRESHNESS_MS = 8000;

// Shape of POST /control/scan we care about. A blocked request still
// comes back HTTP 200 with `ok:false` (a scan already running, or the
// cooldown is active) - surface that honestly in the toast rather than
// claim a fake "scan started".
interface ScanResult {
  ok: boolean;
  status?: "queued" | "running";
  reason?: string;
  retryAfterSeconds?: number;
}

interface StartRunnerResponse {
  ok: boolean;
  status?: "already_running" | "starting";
  pid?: number;
  reason?: string;
}

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

type TickerState =
  | { kind: "idle" }
  | {
      kind: "scanning";
      platform?: string | null;
      // #338/#362: scope + openedRows feed the copy that distinguishes
      // an incremental "checking" pass from a true full-inbox sweep.
      // Both are optional so an older runner build (without the fields)
      // falls through to the legacy "Scanning <platform>" / "X/total"
      // copy rather than rendering blanks.
      scope?: "update" | "full";
      processedRows?: number;
      openedRows?: number;
      total?: number;
      percent?: number;
      etaSeconds?: number | null;
    }
  | { kind: "enriching"; total: number; running: number }
  | {
      kind: "sending";
      personName: string;
      blockedByScan: boolean;
      queuedBehind: number;
    }
  | { kind: "send_failed"; personName: string; message: string }
  | { kind: "send_succeeded"; personName: string }
  | {
      // Issue #369. Per-thread Reassess is a 5-15s LLM call. Previously
      // surfaced as a static pending toast (violates the same rule
      // #337 fixed for the pilot feedback modal — ongoing work belongs
      // in the ticker). Dashboard-side state via lib/reassess-status,
      // so no /runner/health round-trip needed for a click that
      // originates in the dashboard itself.
      kind: "reassessing";
      count: number;
    }
  | {
      // Issue #421 / R-0047. Pilot-feedback report POST is async after
      // the modal closes (issue #383 / R-0030). Pilot asked for an
      // explicit "Sending report…" signal in the ticker rather than
      // only a discrete success/error toast at the end. Dashboard-side
      // state via lib/pilot-report-status.
      kind: "sending_report";
      count: number;
    }
  | {
      // Per-thread "check for new messages" (rescan). Previously rendered
      // inline in the thread header — pilot feedback moved it here, named
      // after the contact ("Checking Tola's messages"). State derives from
      // the SCAN_THREAD_* runner events via lib/thread-check-status.
      kind: "checking_thread";
      personName: string | null;
      count: number;
    }
  | {
      // Transient result line after a per-thread check, same lifetime
      // shape as send_succeeded: "No new messages from Tola" / "2 new
      // messages from Tola".
      kind: "thread_checked";
      personName: string | null;
      newMessages: number | null;
    }
  | {
      kind: "thread_check_incomplete";
      personName: string | null;
    };

function formatRelativeScan(lastScanAt: string | null): string {
  if (!lastScanAt) return "scan never";
  const ts = Date.parse(lastScanAt);
  if (!Number.isFinite(ts)) return "scan never";
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "scan now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `scan ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `scan ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `scan ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `scan ${days}d ago`;
}

function pipToneFor(connected: number, total: number): string {
  if (total === 0) return "bg-ink-3";
  if (connected === 0) return "bg-risk-overdue";
  if (connected < total) return "bg-risk-waiting";
  return "bg-risk-fresh";
}

function platformDisplay(platform: string): string {
  switch (platform) {
    case "LINKEDIN":
      return "linkedin";
    case "IMESSAGE":
      return "imessage";
    case "INSTAGRAM":
      return "instagram";
    case "TIKTOK":
      return "tiktok";
    case "WHATSAPP":
      return "whatsapp";
    default:
      return platform.toLowerCase();
  }
}

function computeTicker(input: {
  health: HealthResponse | null;
  queue: SendQueueResponse | null;
  reassessingCount: number;
  reportSendCount: number;
  threadCheck: ThreadCheckSnapshot;
}): TickerState {
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
  const recentest = input.queue?.recent?.[0];
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
  // Issue #369. Reassess takes priority over scanning here because it's
  // a discrete operator-initiated click — the scan ticker is the
  // background heartbeat. If a scan happens to be running while the
  // operator clicks Reassess, surface the more specific reassess copy
  // so the operator's own action stays visible.
  if (input.reassessingCount > 0) {
    return { kind: "reassessing", count: input.reassessingCount };
  }
  // Per-thread checks share the operator-initiated tier with reassess:
  // the operator just clicked "Check for new messages" on a specific
  // thread, so the ticker names that work over the background scan
  // heartbeat. The transient result line sits below sending_report so an
  // in-flight upload isn't hidden behind an 8s-old result.
  const threadCheck = selectThreadCheck(input.threadCheck, Date.now());
  if (threadCheck.kind === "checking") {
    return {
      kind: "checking_thread",
      personName: threadCheck.personName,
      count: threadCheck.count
    };
  }
  // Issue #421. Pilot-feedback uploads sit at the same priority tier as
  // reassess — both are operator-initiated, dashboard-originated
  // actions that would otherwise vanish into a closed modal. Placed
  // after reassess so a rapid Reassess-then-feedback sequence still
  // shows the reassess copy first; in practice these don't overlap.
  if (input.reportSendCount > 0) {
    return { kind: "sending_report", count: input.reportSendCount };
  }
  if (threadCheck.kind === "checked") {
    return {
      kind: "thread_checked",
      personName: threadCheck.personName,
      newMessages: threadCheck.newMessages
    };
  }
  if (threadCheck.kind === "incomplete") {
    return {
      kind: "thread_check_incomplete",
      personName: threadCheck.personName
    };
  }
  if (blockedByScan) {
    const platform = input.health?.currentScanPlatform ?? null;
    const progress = input.health?.scanProgress;
    if (progress) {
      return {
        kind: "scanning",
        platform,
        scope: progress.scope,
        processedRows: progress.processedRows,
        openedRows: progress.openedRows,
        total: progress.total,
        percent: progress.percent,
        etaSeconds: progress.etaSeconds
      };
    }
    return { kind: "scanning", platform };
  }
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

function tickerLabel(state: TickerState): string {
  switch (state.kind) {
    case "scanning": {
      const platformLabel = state.platform ? platformDisplay(state.platform) : "linkedin";
      // #338/#362: branch on scope so an incremental walk doesn't read as
      // a full inbox sweep. Reporter R-0027 saw "Scanning linkedin · 5/167"
      // during an update-mode pass and interpreted the 167 (the persisted
      // inbox row count) as "the runner is about to re-scan 167 threads".
      // - "update": "Checking <plat> · N checked · M updated" — no
      //   denominator, because we don't visit the whole inbox. M is the
      //   count of rows actually opened (rows with new content).
      // - "full": keep the X/total denominator — for a true sweep it's
      //   the right shape, and the operator opted into it.
      // Falls through to the legacy copy if either scope or the counts
      // are missing (older runner build).
      if (state.scope === "update" && typeof state.processedRows === "number") {
        const updated = typeof state.openedRows === "number" ? state.openedRows : 0;
        return `Checking ${platformLabel}, ${state.processedRows} checked, ${updated} updated`;
      }
      if (
        typeof state.processedRows === "number" &&
        typeof state.total === "number" &&
        state.total > 0
      ) {
        const prefix = state.scope === "full" ? `Full ${platformLabel} scan` : `Scanning ${platformLabel}`;
        return `${prefix} ${state.processedRows}/${state.total}`;
      }
      return state.scope === "full" ? `Full ${platformLabel} scan` : `Scanning ${platformLabel}`;
    }
    case "enriching":
      return `Enriching ${state.total} profile${state.total === 1 ? "" : "s"}`;
    case "sending":
      return state.blockedByScan
        ? `Send queued, waiting on scan to reply to ${state.personName}`
        : `Sending to ${state.personName}`;
    case "send_failed":
      return `Failed to send to ${state.personName}`;
    case "send_succeeded":
      return `Sent to ${state.personName}`;
    case "reassessing":
      // Multi-reassess only happens if the operator clicks Reassess on
      // two threads in quick succession (rare). Pluralise so the copy
      // never reads "Reassessing 1 threads".
      return state.count === 1
        ? "Reassessing thread"
        : `Reassessing ${state.count} threads`;
    case "sending_report":
      // Pluralise the same way as reassess — concurrent submits are
      // rare but possible if the operator opens the modal twice fast.
      return state.count === 1
        ? "Sending report"
        : `Sending ${state.count} reports`;
    case "checking_thread":
      return threadCheckLabel({
        kind: "checking",
        personName: state.personName,
        count: state.count
      });
    case "thread_checked":
      return threadCheckLabel({
        kind: "checked",
        personName: state.personName,
        newMessages: state.newMessages
      });
    case "thread_check_incomplete":
      return threadCheckLabel({
        kind: "incomplete",
        personName: state.personName
      });
    default:
      return "";
  }
}

function tickerDetail(state: TickerState): string | null {
  if (state.kind === "sending" && state.queuedBehind > 0) {
    return `${state.queuedBehind} more queued`;
  }
  if (state.kind === "enriching" && state.running > 0) {
    return `${state.running} in flight`;
  }
  if (state.kind === "scanning" && typeof state.etaSeconds === "number") {
    if (state.etaSeconds <= 0) return "wrapping up…";
    if (state.etaSeconds < 60) return `~${state.etaSeconds}s left`;
    return `~${Math.round(state.etaSeconds / 60)}m left`;
  }
  // Carry the failure reason the (now removed) send-failed toast used to show,
  // skipping the generic fallback that would just echo the heading.
  if (state.kind === "send_failed" && state.message && state.message !== "Send failed") {
    return state.message;
  }
  return null;
}

export function TopStatus({
  mobileChrome = "full"
}: {
  mobileChrome?: MobileStatusChrome;
}) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [queue, setQueue] = useState<SendQueueResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[] | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [runnerReachable, setRunnerReachable] = useState<boolean | null>(null);
  const [runnerStartState, setRunnerStartState] = useState<"idle" | "starting" | "started">("idle");
  const [scanTriggering, setScanTriggering] = useState(false);
  // Issue #369. In-flight Reassess actions originate in the thread page
  // (lib/reassess-status emits an event). Surface the count in the
  // ticker instead of a static pending toast.
  const [reassessingCount, setReassessingCount] = useState(0);
  // Issue #421. Same pattern for pilot-feedback report uploads —
  // signal originates in the (now-closed) feedback modal.
  const [reportSendCount, setReportSendCount] = useState(0);
  // Per-thread "check for new messages" state, reduced from the
  // SCAN_THREAD_* runner events in the listener below. The 1s visible
  // tick already re-renders this component, which is what ages the
  // transient result line out of the ticker.
  const [threadCheck, setThreadCheck] = useState<ThreadCheckSnapshot>(EMPTY_THREAD_CHECK);
  // Issue #435 (R-0057). False until the first poll settles. Until then
  // the bar shows a calm "Connecting…" instead of "0/2 connected · scan
  // never · Scan now", which read as the operator's real status going
  // wrong during a cold mount / reload. Soft navigation keeps this true
  // (TopStatus lives in the persistent shell), so it only shows once.
  const [ready, setReady] = useState(false);
  const [, setTick] = useState(0);
  // Focus Reply Buffer: a calm top-bar entry point, reachable from any page
  // (and any width). Off -> open the setup sheet; on -> open the review sheet.
  const { active: focusActive, focusWindow } = useFocusWindow();

  const refresh = useCallback(async () => {
    // Short TTLs so /health and /data/platforms de-dupe with the app-shell's
    // own 8s poll via the shared client cache instead of issuing duplicate
    // requests on overlapping cadences.
    const [healthData, queueData, platformData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health", { ttlMs: 4000 }).catch(() => null),
      apiGet<SendQueueResponse>("/runner/data/send-queue", { ttlMs: 3000 }).catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms", { ttlMs: 10000 }).catch(() => null)
    ]);
    setRunnerReachable(Boolean(healthData));
    if (healthData) {
      setHealth(healthData);
      setRunnerStartState("idle");
    }
    if (queueData) setQueue(queueData);
    if (platformData) setPlatforms(platformData);
    setReady(true);
  }, []);
  // Stable handle for the action handlers below that trigger an out-of-band
  // refresh (scan now, reset session, etc.) without depending on refresh's
  // identity.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Poll while visible; paused in background tabs. The hook fires an
  // immediate tick on mount and a catch-up tick on return to foreground.
  useVisiblePolling(() => void refresh(), POLL_INTERVAL_MS);

  // Tick once a second so the "scan Xm ago" caption stays current — but only
  // while the tab is visible, so a backgrounded tab isn't re-rendering the
  // status bar every second for a caption nobody is reading.
  useVisiblePolling(() => setTick((n) => n + 1), 1000);

  // Issue #369. Subscribe to per-thread Reassess in-flight signals so
  // the ticker surfaces "Reassessing thread" while a kebab → Reassess
  // click is running.
  useEffect(() => onReassessChange(setReassessingCount), []);

  // Issue #421. Subscribe to pilot-feedback report-send signals so the
  // ticker surfaces "Sending report" between modal-close and POST
  // settlement.
  useEffect(() => onReportSendChange(setReportSendCount), []);

  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<ThreadCheckEventDetail>).detail;
      const t = detail?.type;
      if (isThreadCheckEvent(t)) {
        setThreadCheck((prev) => reduceThreadCheck(prev, detail, Date.now()));
        return;
      }
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

  const visiblePlatforms = visibleImplementedPlatforms(platforms, health?.availablePlatforms);
  const implemented = platforms?.filter((p) => visiblePlatforms.includes(p.platform)) ?? null;
  const total = implemented?.length ?? visiblePlatforms.length;
  const connected =
    implemented?.filter((p) => p.status === "CONNECTED").length ??
    health?.connectedPlatforms ??
    0;
  const pip = pipToneFor(connected, total);
  const degradedPlatforms = implemented?.filter((p) => p.status !== "CONNECTED") ?? [];
  const hasDegraded = degradedPlatforms.length > 0;

  const scanLabel = formatRelativeScan(health?.lastScanAt ?? null);
  const runnerOffline = ready && runnerReachable === false;

  const ticker = computeTicker({ health, queue, reassessingCount, reportSendCount, threadCheck });
  const tickerIsActive =
    ticker.kind === "scanning" ||
    ticker.kind === "sending" ||
    ticker.kind === "enriching" ||
    ticker.kind === "reassessing" ||
    ticker.kind === "sending_report" ||
    ticker.kind === "checking_thread";

  // Cancelling a running scan is a legitimate user action — a scan
  // can sit on a single thread for tens of seconds and the operator
  // shouldn't have to wait it out. This is the one operator-style
  // control kept in the v1 top bar; the rest of the kebab (restart
  // runner, pause all, manage platforms) stays stripped.
  const canCancelScan = ticker.kind === "scanning";
  const onCancelScan = useCallback(async () => {
    if (cancellingScan) return;
    setCancellingScan(true);
    try {
      await apiPost("/runner/control/scan/abort", {});
      await refreshRef.current();
    } catch (error) {
      console.warn("[top-status] scan cancel failed", error);
    } finally {
      setCancellingScan(false);
    }
  }, [cancellingScan]);

  // Manual scan trigger. Posts /control/scan with no platform, so the
  // runner scans every enabled platform (LinkedIn + iMessage). The
  // operator just wants to know "did anyone reply", not pick a
  // platform. The button is hidden once a scan is actually running
  // (the ticker takes over with its own cancel control); we only
  // need to handle the brief window between click and the runner
  // entering SCANNING via the `scanTriggering` flag.
  const onScanNow = useCallback(() => {
    if (scanTriggering) return;
    setScanTriggering(true);
    const request = apiPost<ScanResult>("/runner/control/scan", {});
    runActionWithFeedback(request, {
      pending: "Checking for new replies…",
      success: (result) => {
        if (result.ok) return "Scan started";
        if (result.reason === "in_flight") return "A scan is already running";
        if (result.reason === "cooldown_active") {
          const secs = result.retryAfterSeconds ?? 0;
          return secs > 0
            ? `Just scanned - try again in ${secs}s`
            : "Just scanned - try again shortly";
        }
        return "Scan request received";
      },
      failure: "Couldn't start scan"
    });
    // Refresh once the request settles so the ticker flips to
    // "Scanning…" without waiting for the next 5s poll. Own .catch so
    // this chain never leaks a rejection - runActionWithFeedback has
    // already shown the error toast.
    request
      .then(() => refreshRef.current())
      .catch(() => undefined)
      .finally(() => setScanTriggering(false));
  }, [scanTriggering]);

  const onStartRunner = useCallback(() => {
    if (runnerStartState === "starting") return;
    setRunnerStartState("starting");
    const request = fetch("/api/local-runner/start", { method: "POST" }).then(async (response) => {
      const payload = (await response.json().catch(() => ({}))) as StartRunnerResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.reason ?? `Request failed: ${response.status}`);
      }
      return payload;
    });
    runActionWithFeedback(request, {
      pending: "Starting runner…",
      success: (result) =>
        result.status === "already_running" ? "Runner is already running" : "Runner is starting",
      failure: "Couldn’t start runner"
    });
    request
      .then(() => {
        setRunnerStartState("started");
        window.setTimeout(() => void refreshRef.current(), 2500);
        window.setTimeout(() => void refreshRef.current(), 6000);
      })
      .catch(() => setRunnerStartState("idle"));
  }, [runnerStartState]);

  const tickerHeading = tickerLabel(ticker);
  const tickerSub = tickerDetail(ticker);
  const tickerTone =
    ticker.kind === "send_failed"
      ? "text-ink-2"
      : ticker.kind === "send_succeeded" || ticker.kind === "thread_checked"
        ? "text-risk-fresh"
        : "text-ink-2";

  // #914: secondary mobile routes hide the row unless degraded / offline /
  // in-flight work needs a surface. Desktop always keeps the full row.
  const forceSurface =
    mobileChrome === "hidden" &&
    shouldSurfaceHiddenStatus({
      ready,
      runnerOffline,
      hasDegraded,
      tickerKind: ticker.kind
    });
  const hideOnMobile = mobileChrome === "hidden" && !forceSurface;
  // Compact (and attention-only re-entry on hidden routes): drop Focus /
  // Scan chrome that is not required for the current signal.
  const attentionOnlyMobile = mobileChrome === "hidden" && forceSurface;
  const compactMobile = mobileChrome === "compact";

  return (
    <div
      role="status"
      aria-live="polite"
      data-mobile-chrome={mobileChrome}
      data-mobile-surface={
        hideOnMobile ? "suppressed" : forceSurface ? "attention" : mobileChrome
      }
      className={cn(
        "sticky top-0 z-30 flex h-[44px] items-center gap-2 border-b border-hairline bg-paper/95 px-4 font-mono text-[11px] tracking-[0.02em] text-ink-3 backdrop-blur md:gap-3 md:px-6",
        hideOnMobile && "hidden md:flex"
      )}
    >
      {!ready ? (
        // #435: cold-mount placeholder. A grey pip + "Connecting…" instead
        // of a confident "0/2 connected" before the first poll resolves.
        <span className="inline-flex items-center gap-[6px]" title="Connecting to runner…">
          <span className="h-[6px] w-[6px] rounded-full bg-ink-3" aria-hidden />
          <span className="text-ink-3">Connecting…</span>
        </span>
      ) : runnerOffline ? (
        <span className="inline-flex items-center gap-[6px]" title="Local helper paused">
          <span className="h-[6px] w-[6px] rounded-full bg-ink-3" aria-hidden />
          <span className="text-ink-2">App helper paused</span>
        </span>
      ) : hasDegraded ? (
        <Link
          href="/settings#platforms"
          title={`${connected}/${total} platforms connected, open platform settings`}
          className="inline-flex items-center gap-[6px] rounded-[6px] px-1 -mx-1 transition-colors duration-calm hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
        >
          <span className={`h-[6px] w-[6px] rounded-full ${pip}`} aria-hidden />
          <span className="text-ink-2 underline-offset-2 hover:underline">
            {connected}/{total} connected
          </span>
        </Link>
      ) : (
        <Link
          href="/settings#platforms"
          className={cn(
            "inline-flex items-center gap-[6px] rounded-[6px] px-1 -mx-1 transition-colors duration-calm hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
            // Healthy idle state can live in Settings on compact mobile.
            (attentionOnlyMobile || compactMobile) && "hidden md:inline-flex"
          )}
          title={`${connected}/${total} platforms connected, open platform settings`}
        >
          <span className={`h-[6px] w-[6px] rounded-full ${pip}`} aria-hidden />
          <span
            className={cn(
              "text-ink-2 underline-offset-2 hover:underline",
              // Compact mobile: pip only; full count returns at md.
              compactMobile && "hidden md:inline"
            )}
          >
            {connected}/{total} connected
          </span>
        </Link>
      )}

      {tickerIsActive ||
      ticker.kind === "send_failed" ||
      ticker.kind === "send_succeeded" ||
      ticker.kind === "thread_checked" ? (
        <>
          <span className="inline-flex min-w-0 items-center gap-[8px]">
            {ticker.kind === "send_succeeded" || ticker.kind === "thread_checked" ? (
              <span className="inline-block h-[6px] w-[6px] rounded-full bg-risk-fresh" aria-hidden />
            ) : ticker.kind === "send_failed" ? (
              <span className="inline-block h-[6px] w-[6px] rounded-full bg-ink-3" aria-hidden />
            ) : null}
            <span className={`truncate ${tickerTone}`}>{tickerHeading}</span>
            {tickerIsActive ? (
              <span
                aria-hidden
                className="relative inline-block h-[2px] w-[56px] overflow-hidden rounded-full bg-hairline"
              >
                {ticker.kind === "scanning" && typeof ticker.percent === "number" ? (
                  <span
                    className="absolute inset-0 rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${ticker.percent}%` }}
                  />
                ) : (
                  <span
                    className="absolute inset-y-0 w-[40%] rounded-full bg-accent animate-progress-sweep"
                    style={{ left: 0 }}
                  />
                )}
              </span>
            ) : null}
            {tickerSub ? <span className="text-ink-3">{tickerSub}</span> : null}
            {canCancelScan ? (
              <button
                type="button"
                onClick={() => void onCancelScan()}
                disabled={cancellingScan}
                className="ml-1 font-mono text-[10.5px] text-ink-4 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
              >
                {cancellingScan ? "cancelling…" : "cancel"}
              </button>
            ) : null}
          </span>
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        <span
          className={cn(
            // Notifications stay on Today + Inbox; secondary attention
            // strips only carry the signal that forced them open.
            attentionOnlyMobile && "hidden md:inline-flex"
          )}
        >
          <NotificationBell />
        </span>
        <button
          type="button"
          onClick={() => openPilotFeedback("feedback")}
          title="Send feedback"
          aria-label="Send feedback"
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink md:hidden",
            attentionOnlyMobile && "hidden"
          )}
        >
          <MessageSquareText className="h-[15px] w-[15px]" strokeWidth={1.7} />
        </button>
        <button
          type="button"
          onClick={() => (focusActive ? openFocusReview() : openFocusSetup())}
          title={focusActive ? "Focus block active, review acknowledgements" : "Start a focus window"}
          className={cn(
            "inline-flex items-center gap-[6px] rounded-pill border px-[10px] py-[3px] font-sans text-[11.5px] tracking-[-0.005em] transition-colors duration-calm",
            focusActive
              ? "border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-accent-soft text-accent-ink"
              : "border-hairline-strong text-ink-2 hover:border-[color-mix(in_srgb,var(--accent)_30%,transparent)] hover:text-ink",
            // Compact: only show Focus when it is on. Attention-only: desktop.
            attentionOnlyMobile && "hidden md:inline-flex",
            compactMobile && !focusActive && "hidden md:inline-flex"
          )}
        >
          <Moon className="h-[12px] w-[12px]" strokeWidth={1.7} />
          <span className={cn(compactMobile && "hidden md:inline")}>
            {focusActive
              ? `Focus${focusWindow.endsAt ? ` · until ${formatUntil(focusWindow.endsAt)}` : ""}`
              : "Focus off"}
          </span>
        </button>
        {/* #435: suppress "scan never" / "Scan now" until the first poll
            settles so a cold mount doesn't imply the runner has never run.
            The relative timestamp is the first thing to go on phone widths —
            "Scan now" keeps the actionable part. */}
        {runnerOffline ? (
          <button
            type="button"
            onClick={onStartRunner}
            disabled={runnerStartState === "starting"}
            title="Start the local runner process."
            className="font-mono text-[11px] text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
          >
            {runnerStartState === "starting"
              ? "starting…"
              : runnerStartState === "started"
                ? "runner starting"
                : "Start runner"}
          </button>
        ) : null}
        {ready && !runnerOffline ? (
          <span className="hidden sm:inline">{scanLabel}</span>
        ) : null}
        {ready && !runnerOffline && ticker.kind !== "scanning" ? (
          <>
            <button
              type="button"
              onClick={onScanNow}
              disabled={scanTriggering}
              title="Scan every connected platform now to check for new replies."
              className={cn(
                "font-mono text-[11px] text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50",
                // Compact mobile keeps the global strip focused on attention.
                (attentionOnlyMobile || compactMobile) && "hidden md:inline"
              )}
            >
              {scanTriggering ? "scanning…" : "Scan now"}
            </button>
          </>
        ) : null}
      </div>

    </div>
  );
}
