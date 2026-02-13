"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { CommandPalette } from "@/components/layout/command-palette";
import { apiGet, apiPost } from "@/lib/api";
import type { AppSettings, HealthResponse } from "@/lib/types";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const refreshMeta = useCallback(async () => {
    const [healthData, settingsData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health"),
      apiGet<AppSettings>("/runner/data/settings")
    ]);

    setHealth(healthData);
    setSettings(settingsData);
  }, []);

  useEffect(() => {
    void refreshMeta();
    const timer = setInterval(() => {
      void refreshMeta();
    }, 8000);

    return () => clearInterval(timer);
  }, [refreshMeta]);

  useEffect(() => {
    const previousEventId = Number(window.sessionStorage.getItem("runner_last_event_id") ?? "0");
    const eventUrl = previousEventId > 0 ? `/events?sinceEventId=${previousEventId}` : "/events";

    const source = new EventSource(eventUrl);

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; eventId?: number };
        if (payload.eventId) {
          window.sessionStorage.setItem("runner_last_event_id", String(payload.eventId));
        }

        window.dispatchEvent(new CustomEvent("runner-event", { detail: payload }));

        if (payload.type === "RESYNC_REQUIRED") {
          window.dispatchEvent(new CustomEvent("runner-resync"));
          void refreshMeta();
        }
      } catch {
        // Ignore malformed event payloads.
      }
    };

    source.onerror = () => {
      // Let EventSource auto-reconnect.
    };

    return () => source.close();
  }, [refreshMeta, pathname]);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };

    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  const lastScanAt = useMemo(() => health?.lastScanAt ?? null, [health]);

  const runScanNow = async () => {
    await apiPost("/runner/control/scan", {});
    await refreshMeta();
  };

  const toggleHeadless = async () => {
    if (!settings) {
      return;
    }

    const updated = await apiPost<AppSettings>("/runner/control/settings", {
      headless: !settings.headless
    });

    setSettings(updated);
  };

  return (
    <div className="min-h-screen bg-bg">
      <Sidebar health={health} lastScanAt={lastScanAt} onScanNow={runScanNow} />
      <div className="ml-[260px] min-h-screen">
        <Topbar
          settings={settings}
          health={health}
          onToggleHeadless={toggleHeadless}
          onOpenCommandPalette={() => setPaletteOpen(true)}
        />
        <main className="p-6">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
