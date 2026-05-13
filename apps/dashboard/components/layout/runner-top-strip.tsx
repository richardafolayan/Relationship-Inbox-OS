"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { IMPLEMENTED_PLATFORMS } from "@/lib/risk";
import type { HealthResponse, PlatformCard } from "@/lib/types";

// Sticky top strip that re-surfaces the controls dropped from the original
// topbar during the redesign: a "Restart runner" button, the connected
// platform count, and the most recent scan time. Lives on every page so
// runner health is always one click away. Voice/tokens follow the new
// design (mono caption, hairline border, no shouty colors).

const POLL_INTERVAL_MS = 5000;
const RESTART_MAX_WAIT_MS = 90_000;
const RESTART_POLL_INTERVAL_MS = 500;

const RESTART_CONFIRM_MESSAGE =
  "Restart the runner? Any in-flight scan or send will be cancelled. " +
  "Sends queued in the database (PENDING SendRequests) survive and resume after restart. " +
  "The restart rebuilds @inbox-os/core + @inbox-os/runner before relaunching, so it picks up any new code.";

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

function dotClassFor(connected: number, total: number): string {
  if (total === 0) return "bg-ink-3";
  if (connected === 0) return "bg-risk-overdue";
  if (connected < total) return "bg-risk-waiting";
  return "bg-risk-fresh";
}

export function RunnerTopStrip() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[] | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    const [healthData, platformData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health").catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => null)
    ]);
    if (healthData) setHealth(healthData);
    if (platformData) setPlatforms(platformData);
  }, []);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refreshRef.current(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Tick once a second so the "scan Xm ago" caption stays current
  // between polls without re-fetching.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const onRestartRunner = useCallback(async () => {
    if (restarting) return;
    if (!window.confirm(RESTART_CONFIRM_MESSAGE)) {
      return;
    }
    setRestartError(null);
    setRestarting(true);
    try {
      await apiPost("/runner/control/system/restart", {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to ask runner to restart";
      setRestartError(message);
      setRestarting(false);
      return;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < RESTART_MAX_WAIT_MS) {
      const ok = await apiGet<HealthResponse>("/runner/health")
        .then((data) => data?.runnerStatus === "ONLINE")
        .catch(() => false);
      if (ok) {
        window.location.reload();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
    }

    setRestartError(
      "Runner did not come back within 90s. Tail /tmp/runner-restart.log to see whether the rebuild errored or the relaunch is still in progress."
    );
    setRestarting(false);
  }, [restarting]);

  const implemented = platforms?.filter((p) => IMPLEMENTED_PLATFORMS.includes(p.platform)) ?? null;
  const total = implemented?.length ?? IMPLEMENTED_PLATFORMS.length;
  const connected =
    implemented?.filter((p) => p.status === "CONNECTED").length ??
    health?.connectedPlatforms ??
    0;
  const dot = dotClassFor(connected, total);
  const scanLabel = formatRelativeScan(health?.lastScanAt ?? null);

  return (
    <div className="sticky top-0 z-30 flex items-center justify-end gap-4 border-b border-hairline bg-paper/95 px-6 py-1.5 font-mono text-[11px] text-ink-3 backdrop-blur">
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
        <span>
          {connected}/{total} connected
        </span>
      </span>
      <span aria-hidden className="text-ink-3/60">·</span>
      <span>{scanLabel}</span>
      <span aria-hidden className="text-ink-3/60">·</span>
      <Button
        variant="quiet"
        onClick={() => void onRestartRunner()}
        disabled={restarting}
        className="px-3 py-1 text-[11px] font-mono"
        title={
          restartError
            ? `Last attempt: ${restartError}`
            : "Restart the runner process. Cancels any in-flight scan or send."
        }
      >
        {restarting ? "restarting…" : "Restart runner"}
      </Button>
      {restartError && !restarting ? (
        <span className="text-[oklch(45%_0.18_28)]" role="alert">
          {restartError}
        </span>
      ) : null}
    </div>
  );
}
