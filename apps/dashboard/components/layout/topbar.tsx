"use client";

import { useCallback, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { apiPost, apiGet } from "@/lib/api";
import type { AppSettings, HealthResponse } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlobalSearch } from "@/components/layout/global-search";

interface TopbarProps {
  settings: AppSettings | null;
  health: HealthResponse | null;
  autoScanEnabled: boolean;
  autoScanDisabled: boolean;
  scanFallbackEnabled: boolean;
  onToggleHeadless: () => Promise<void>;
  onToggleAutoScan: () => void;
  onOpenCommandPalette: () => void;
}

export function Topbar({
  settings,
  health,
  autoScanEnabled,
  autoScanDisabled,
  onToggleHeadless,
  onToggleAutoScan
}: TopbarProps) {
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  // Restart the runner without leaving the dashboard. Walks four phases:
  //   1. confirm() — process.exit() kills any in-flight scan/send so we
  //      need explicit consent.
  //   2. POST /runner/control/system/restart — accepted with 202 then the
  //      runner exits ~250ms later.
  //   3. Poll /runner/health on a tight loop. The first request after
  //      exit fails (connection refused). Once tsx watch relaunches the
  //      process and the event bus is up, /health returns 200 and we
  //      know the runner is back.
  //   4. Reload the dashboard so it re-subscribes to /events with a
  //      fresh sinceEventId.
  const onRestartRunner = useCallback(async () => {
    if (restarting) return;
    if (
      !window.confirm(
        "Restart the runner? Any in-flight scan or send will be cancelled. " +
          "Sends queued in the database (PENDING SendRequests) survive and resume after restart. " +
          "The restart rebuilds @inbox-os/core + @inbox-os/runner before relaunching, so it picks up any new code."
      )
    ) {
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

    // Wait for the runner to come back. Budget 90s — the bootstrap
    // helper rebuilds core (~2s) + runner (~10-30s on a cold tsbuildinfo)
    // before relaunching, so a healthy restart can take 15-45s.
    const startedAt = Date.now();
    const maxWaitMs = 90_000;
    const pollEveryMs = 500;
    while (Date.now() - startedAt < maxWaitMs) {
      // The first health checks during the restart window will reject
      // (proxy can't reach 4001). Swallow and try again.
      const ok = await apiGet<HealthResponse>("/runner/health")
        .then(() => true)
        .catch(() => false);
      if (ok) {
        // Runner is up. Reload so /events SSE rebinds and pages
        // re-fetch their initial state.
        window.location.reload();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
    }

    setRestartError(
      "Runner did not come back within 90s. Tail /tmp/runner-restart.log to see whether the rebuild errored or the relaunch is still in progress."
    );
    setRestarting(false);
  }, [restarting]);

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="flex items-center justify-between gap-4 px-6 py-3">
        <GlobalSearch />

        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onToggleHeadless}>
            Headless: {settings?.headless ? "On" : "Off"}
          </Button>
          <Button
            variant={autoScanEnabled ? "primary" : "secondary"}
            onClick={onToggleAutoScan}
            disabled={autoScanDisabled}
            title={
              autoScanDisabled
                ? "Auto-scan disabled by env (NEXT_PUBLIC_DISABLE_AUTOSCAN or LINKEDIN_DEV_DISABLE_AUTOSCAN). Restart the dashboard after editing .env."
                : autoScanEnabled
                  ? "Auto-scan firing every 10 minutes. Click to pause."
                  : "Click to enable auto-scan (every 10 minutes)."
            }
          >
            Auto-scan: {autoScanEnabled ? "On" : "Off"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void onRestartRunner()}
            disabled={restarting}
            title={
              restartError
                ? `Last attempt: ${restartError}`
                : "Restart the runner process. In dev (tsx watch) it relaunches automatically."
            }
          >
            {restarting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Restarting…
              </>
            ) : (
              <>
                <RotateCcw className="mr-2 h-4 w-4" />
                Restart runner
              </>
            )}
          </Button>
          {settings?.demoMode ? <Badge tone="amber">Demo Mode</Badge> : null}
          <Badge tone="neutral">{health?.connectedPlatforms ?? 0}/3 connected</Badge>
        </div>
      </div>
    </header>
  );
}
