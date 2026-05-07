"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { resolveAutoScanDisabled, resolveAutoScanInitialEnabled } from "@inbox-os/core/autoscan";
import { Sidebar } from "@/components/layout/sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { SystemStatusBar } from "@/components/layout/system-status-bar";
import { ToastHost } from "@/components/common/toast-host";
import { RunnerTopStrip } from "@/components/layout/runner-top-strip";
import { apiGet, apiPost } from "@/lib/api";
import { initials } from "@/lib/risk";
import type { AppSettings, HealthResponse, InboxResponse } from "@/lib/types";

const linkedInAutoScanStorageKey = "linkedin_dashboard_autoscan_enabled";
const linkedInAutoScanIntervalMs = 600_000;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [attentionCount, setAttentionCount] = useState(0);
  const autoScanInFlightRef = useRef(false);
  const autoScanDisabled = useMemo(
    () =>
      resolveAutoScanDisabled({
        nodeEnv: process.env.NODE_ENV,
        disableAutoScan: process.env.NEXT_PUBLIC_DISABLE_AUTOSCAN,
        legacyDisableAutoScan: process.env.NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN
      }),
    []
  );

  const refreshMeta = useCallback(async () => {
    const [healthData, settingsData, inboxData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health").catch(() => null),
      apiGet<AppSettings>("/runner/data/settings").catch(() => null),
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null)
    ]);

    if (healthData) setHealth(healthData);
    if (settingsData) setSettings(settingsData);
    if (inboxData) {
      const count = inboxData.rows.filter(
        (row) => row.riskLevel === "RED" || row.riskLevel === "AMBER"
      ).length;
      setAttentionCount(count);
    }
  }, []);

  useEffect(() => {
    void refreshMeta();
    const timer = setInterval(() => {
      void refreshMeta();
    }, 8000);
    return () => clearInterval(timer);
  }, [refreshMeta]);

  useEffect(() => {
    if (autoScanDisabled) {
      setAutoScanEnabled(false);
      return;
    }
    const stored = window.localStorage.getItem(linkedInAutoScanStorageKey);
    setAutoScanEnabled(
      resolveAutoScanInitialEnabled({
        envDisabled: autoScanDisabled,
        storedValue: stored
      })
    );
  }, [autoScanDisabled]);

  useEffect(() => {
    if (autoScanDisabled) return;
    window.localStorage.setItem(linkedInAutoScanStorageKey, autoScanEnabled ? "true" : "false");
  }, [autoScanDisabled, autoScanEnabled]);

  useEffect(() => {
    if (autoScanDisabled || !autoScanEnabled) return undefined;
    const timer = setInterval(() => {
      if (autoScanInFlightRef.current) return;
      autoScanInFlightRef.current = true;
      void apiPost("/runner/control/scan", { platform: "LINKEDIN" })
        .catch(() => undefined)
        .finally(() => {
          autoScanInFlightRef.current = false;
        });
    }, linkedInAutoScanIntervalMs);
    return () => clearInterval(timer);
  }, [autoScanDisabled, autoScanEnabled]);

  // SSE event stream — kept untouched. Pages subscribe to `runner-event` /
  // `runner-resync` window events.
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

  // ⌘K toggles the palette. Esc closes the palette and, when there is no
  // palette open, navigates back from a thread to /today (matches the
  // prototype's "Esc closes thread" behaviour).
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
        return;
      }
      if (event.key === "Escape") {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        if (pathname.startsWith("/thread/")) {
          router.push("/today");
        }
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [paletteOpen, pathname, router]);

  // Defense in depth: any rejection that escapes a callsite-level handler
  // would otherwise bubble to Next.js's dev error overlay. Action callsites
  // already capture their own errors via `runAction`; this is the safety net.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      console.warn("[unhandledRejection]", message, reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);

  const operatorName = "Richard";
  const userInitials = initials(operatorName);

  // Quiet hours (UI-only for now): if the user has set "quiet_hours" in
  // localStorage, drop the attention dot from the sidebar even when
  // overdue+waiting > 0. Matches the README intent without touching the
  // runner-side AppSettings shape.
  const quietHours =
    typeof window !== "undefined" && window.localStorage.getItem("inbox_quiet_hours") === "1";
  const sidebarAttention = quietHours ? 0 : attentionCount;

  // Suppress unused-warning for settings; pages that need it (Settings,
  // Platforms) fetch their own copy. We hold it here so a future toolbar
  // could read it without re-fetching.
  void settings;

  return (
    <div className="grid h-screen grid-cols-[200px_1fr] overflow-hidden bg-paper text-ink">
      <Sidebar
        health={health}
        attentionCount={sidebarAttention}
        userInitials={userInitials}
        onOpenSearch={() => setPaletteOpen(true)}
      />
      <div className="flex h-screen min-h-0 flex-col">
        <RunnerTopStrip />
        <SystemStatusBar />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ToastHost />
    </div>
  );
}
