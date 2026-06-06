"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { runActionWithFeedback } from "@/lib/feedback";
import { onReassessChange } from "@/lib/reassess-status";
import { onReportSendChange } from "@/lib/pilot-report-status";
import { IMPLEMENTED_PLATFORMS } from "@/lib/risk";
import { shouldAutoCloseReconnect } from "@/lib/platform-reconnect";
import type { HealthResponse, PlatformCard } from "@/lib/types";

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

// Proper-cased platform labels for the reconnect modal. PLATFORM_LABEL
// in lib/risk is all-lowercase (used elsewhere for compact captions);
// the modal wants real product casing.
const PLATFORM_DISPLAY: Record<string, string> = {
  LINKEDIN: "LinkedIn",
  IMESSAGE: "iMessage",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok"
};

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
    default:
      return platform.toLowerCase();
  }
}

function computeTicker(input: {
  health: HealthResponse | null;
  queue: SendQueueResponse | null;
  reassessingCount: number;
  reportSendCount: number;
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
  // Issue #421. Pilot-feedback uploads sit at the same priority tier as
  // reassess — both are operator-initiated, dashboard-originated
  // actions that would otherwise vanish into a closed modal. Placed
  // after reassess so a rapid Reassess-then-feedback sequence still
  // shows the reassess copy first; in practice these don't overlap.
  if (input.reportSendCount > 0) {
    return { kind: "sending_report", count: input.reportSendCount };
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

export function TopStatus() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [queue, setQueue] = useState<SendQueueResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[] | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [platformActionBusy, setPlatformActionBusy] = useState<string | null>(null);
  const [scanTriggering, setScanTriggering] = useState(false);
  // Issue #369. In-flight Reassess actions originate in the thread page
  // (lib/reassess-status emits an event). Surface the count in the
  // ticker instead of a static pending toast.
  const [reassessingCount, setReassessingCount] = useState(0);
  // Issue #421. Same pattern for pilot-feedback report uploads —
  // signal originates in the (now-closed) feedback modal.
  const [reportSendCount, setReportSendCount] = useState(0);
  // Issue #435 (R-0057). False until the first poll settles. Until then
  // the bar shows a calm "Connecting…" instead of "0/2 connected · scan
  // never · Scan now", which read as the operator's real status going
  // wrong during a cold mount / reload. Soft navigation keeps this true
  // (TopStatus lives in the persistent shell), so it only shows once.
  const [ready, setReady] = useState(false);
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    // Short TTLs so /health and /data/platforms de-dupe with the app-shell's
    // own 8s poll via the shared client cache instead of issuing duplicate
    // requests on overlapping cadences.
    const [healthData, queueData, platformData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health", { ttlMs: 4000 }).catch(() => null),
      apiGet<SendQueueResponse>("/runner/data/send-queue", { ttlMs: 3000 }).catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms", { ttlMs: 10000 }).catch(() => null)
    ]);
    if (healthData) setHealth(healthData);
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

  const implemented = platforms?.filter((p) => IMPLEMENTED_PLATFORMS.includes(p.platform)) ?? null;
  const total = implemented?.length ?? IMPLEMENTED_PLATFORMS.length;
  const connected =
    implemented?.filter((p) => p.status === "CONNECTED").length ??
    health?.connectedPlatforms ??
    0;
  const pip = pipToneFor(connected, total);
  // Platforms that need operator attention. The pip becomes a button
  // that opens a minimal reconnect modal when any are non-CONNECTED —
  // the only recovery path a v1 user gets, since the full operator
  // console at /platforms is intentionally unlinked. (You can still
  // type /platforms directly for the full diagnostics.)
  const degradedPlatforms = implemented?.filter((p) => p.status !== "CONNECTED") ?? [];
  const hasDegraded = degradedPlatforms.length > 0;

  // Keep the reconnect modal's open-state honest. `reconnectOpen` is tracked
  // separately from `degradedPlatforms` (derived fresh each render from the
  // polled snapshot), so when the last degraded platform reconnects — via the
  // operator's own Reconnect click, a background poll, or a runner-event
  // refresh — the list empties but the boolean stays true, leaving the modal
  // showing its "These platforms aren't connected" header over an empty list.
  // Auto-close once there is nothing left to reconnect; this doubles as
  // confirmation the reconnect worked.
  useEffect(() => {
    if (shouldAutoCloseReconnect(reconnectOpen, hasDegraded)) {
      setReconnectOpen(false);
    }
  }, [reconnectOpen, hasDegraded]);

  const runPlatformAction = useCallback(
    async (platform: string, endpoint: "connect" | "reset-session") => {
      const key = `${platform}:${endpoint}`;
      if (platformActionBusy) return;
      setPlatformActionBusy(key);
      try {
        await apiPost(`/runner/control/platform/${endpoint}`, { platform });
        await refreshRef.current();
      } catch (error) {
        console.warn(`[top-status] ${endpoint} failed for ${platform}`, error);
      } finally {
        setPlatformActionBusy(null);
      }
    },
    [platformActionBusy]
  );

  const scanLabel = formatRelativeScan(health?.lastScanAt ?? null);

  const ticker = computeTicker({ health, queue, reassessingCount, reportSendCount });
  const tickerIsActive =
    ticker.kind === "scanning" ||
    ticker.kind === "sending" ||
    ticker.kind === "enriching" ||
    ticker.kind === "reassessing" ||
    ticker.kind === "sending_report";

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

  const tickerHeading = tickerLabel(ticker);
  const tickerSub = tickerDetail(ticker);
  const tickerTone =
    ticker.kind === "send_failed"
      ? "text-risk-overdue"
      : ticker.kind === "send_succeeded"
        ? "text-risk-fresh"
        : "text-ink-2";

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-30 flex h-[44px] items-center gap-3 border-b border-hairline bg-paper/95 px-6 font-mono text-[11px] tracking-[0.02em] text-ink-3 backdrop-blur"
    >
      {!ready ? (
        // #435: cold-mount placeholder. A grey pip + "Connecting…" instead
        // of a confident "0/2 connected" before the first poll resolves.
        <span className="inline-flex items-center gap-[6px]" title="Connecting to runner…">
          <span className="h-[6px] w-[6px] rounded-full bg-ink-3" aria-hidden />
          <span className="text-ink-3">Connecting…</span>
        </span>
      ) : hasDegraded ? (
        <button
          type="button"
          onClick={() => setReconnectOpen(true)}
          title={`${connected}/${total} platforms connected, click to reconnect`}
          className="inline-flex items-center gap-[6px] rounded-[6px] px-1 -mx-1 transition-colors duration-calm hover:bg-paper-2"
        >
          <span className={`h-[6px] w-[6px] rounded-full ${pip}`} aria-hidden />
          <span className="text-ink-2 underline-offset-2 hover:underline">
            {connected}/{total} connected
          </span>
        </button>
      ) : (
        <span className="inline-flex items-center gap-[6px]" title={`${connected}/${total} platforms connected`}>
          <span className={`h-[6px] w-[6px] rounded-full ${pip}`} aria-hidden />
          <span className="text-ink-2">
            {connected}/{total} connected
          </span>
        </span>
      )}

      {tickerIsActive || ticker.kind === "send_failed" || ticker.kind === "send_succeeded" ? (
        <>
          <span className="inline-flex min-w-0 items-center gap-[8px]">
            {ticker.kind === "send_succeeded" ? (
              <span className="inline-block h-[6px] w-[6px] rounded-full bg-risk-fresh" aria-hidden />
            ) : ticker.kind === "send_failed" ? (
              <span className="inline-block h-[6px] w-[6px] rounded-full bg-risk-overdue" aria-hidden />
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
        {/* #435: suppress "scan never" / "Scan now" until the first poll
            settles so a cold mount doesn't imply the runner has never run. */}
        {ready ? <span>{scanLabel}</span> : null}
        {ready && ticker.kind !== "scanning" ? (
          <>
            <button
              type="button"
              onClick={onScanNow}
              disabled={scanTriggering}
              title="Scan every connected platform now to check for new replies."
              className="font-mono text-[11px] text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
            >
              {scanTriggering ? "scanning…" : "Scan now"}
            </button>
          </>
        ) : null}
      </div>

      {reconnectOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setReconnectOpen(false)}
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-xl border border-hairline bg-paper p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <p className="font-display text-[15px] font-medium tracking-[-0.012em] text-ink">
                Connection issue
              </p>
              <p className="mt-1 font-mono text-[11px] text-ink-3">
                These platforms aren&apos;t connected. Reconnect, or reset the
                session if reconnect keeps failing.
              </p>
            </div>
            <div className="space-y-2">
              {degradedPlatforms.map((p) => {
                const label = PLATFORM_DISPLAY[p.platform]
                  ?? p.platform.charAt(0) + p.platform.slice(1).toLowerCase();
                const connectBusy = platformActionBusy === `${p.platform}:connect`;
                const resetBusy = platformActionBusy === `${p.platform}:reset-session`;
                // iMessage has no browser session — it reads chat.db
                // locally. "Reconnect" (re-probe the DB) is the only
                // meaningful action; "Reset session" is a browser
                // concept that doesn't apply. Its only real failure
                // mode is a missing macOS Full Disk Access grant, so
                // say that instead of offering a session reset.
                const isImessage = p.platform === "IMESSAGE";
                return (
                  <div
                    key={p.platform}
                    className="flex flex-col gap-2 rounded-row border border-hairline bg-paper-2/40 px-3 py-2"
                  >
                    <span className="text-[13px] text-ink-2">
                      {label}{" "}
                      <span className="font-mono text-[11px] text-risk-overdue">
                        {p.status.toLowerCase().replace(/_/g, " ")}
                      </span>
                    </span>
                    {isImessage ? (
                      <span className="font-mono text-[11px] leading-snug text-ink-3">
                        Reads Messages locally, no login. If it stays
                        disconnected, grant the runner Full Disk Access
                        in System Settings → Privacy &amp; Security, then
                        retry.
                      </span>
                    ) : null}
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!!platformActionBusy}
                        onClick={() => void runPlatformAction(p.platform, "connect")}
                        className="rounded-pill bg-ink px-3 py-1 font-mono text-[11px] text-paper transition-opacity duration-calm hover:opacity-90 disabled:opacity-50"
                      >
                        {connectBusy
                          ? (isImessage ? "retrying…" : "reconnecting…")
                          : (isImessage ? "Retry" : "Reconnect")}
                      </button>
                      {isImessage ? null : (
                        <button
                          type="button"
                          disabled={!!platformActionBusy}
                          onClick={() => void runPlatformAction(p.platform, "reset-session")}
                          className="rounded-pill border border-hairline px-3 py-1 font-mono text-[11px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink disabled:opacity-50"
                        >
                          {resetBusy ? "resetting…" : "Reset session"}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setReconnectOpen(false)}
                className="font-mono text-[11px] text-ink-3 hover:text-ink"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
