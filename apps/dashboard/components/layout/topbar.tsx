"use client";

import { Search, SlidersHorizontal, Command } from "lucide-react";
import type { AppSettings, HealthResponse } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface TopbarProps {
  settings: AppSettings | null;
  health: HealthResponse | null;
  onToggleHeadless: () => Promise<void>;
  onOpenCommandPalette: () => void;
}

export function Topbar({ settings, health, onToggleHeadless, onOpenCommandPalette }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="flex items-center justify-between gap-4 px-6 py-3">
        <div className="relative max-w-lg flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input className="pl-9" placeholder="Search people, keywords..." />
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary">
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            Filters
          </Button>
          <Button variant="secondary" onClick={onToggleHeadless}>
            Headless: {settings?.headless ? "On" : "Off"}
          </Button>
          {settings?.demoMode ? <Badge tone="amber">Demo Mode Active</Badge> : null}
          <Badge tone="blue">Scan every {settings?.scanIntervalSeconds ?? 60}s</Badge>
          <Badge tone="neutral">Connected: {health?.connectedPlatforms ?? 0}/3</Badge>
          <Button variant="ghost" onClick={onOpenCommandPalette}>
            <Command className="mr-2 h-4 w-4" />
            Cmd+K
          </Button>
        </div>
      </div>
    </header>
  );
}
