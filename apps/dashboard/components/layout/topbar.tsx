"use client";

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
            title={autoScanDisabled ? "Auto-scan disabled in dev" : undefined}
          >
            Auto-scan: {autoScanEnabled ? "On" : "Off"}
          </Button>
          {settings?.demoMode ? <Badge tone="amber">Demo Mode</Badge> : null}
          <Badge tone="neutral">{health?.connectedPlatforms ?? 0}/3 connected</Badge>
        </div>
      </div>
    </header>
  );
}
