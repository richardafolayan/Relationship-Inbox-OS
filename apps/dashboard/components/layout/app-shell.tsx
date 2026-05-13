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
import { isQuietHoursActive } from "@/lib/quiet-hours";
import type { HealthResponse, InboxResponse } from "@/lib/types";

const linkedInAutoScanStorageKey = "linkedin_dashboard_autoscan_enabled";
const linkedInAutoScanIntervalMs = 600_000;
const sidebarCollapsedStorageKey = "dashboard_sidebar_collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [attentionCount, setAttentionCount] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  // refreshMeta drops the /runner/data/settings poll the shell used to
  // perform every 8s. The setSettings result was only `void`-discarded —
  // pages that genuinely need settings (/settings, /platforms) fetch
  // their own copy, so the AppShell poll was a wasted round-trip on
  // every tick. /health and /data/inbox still fire because the sidebar
  // and attention-count badge depend on them.
  const refreshMeta = useCallback(async () => {
    const [healthData, inboxData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health").catch(() => null),
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null)
    ]);

    if (healthData) setHealth(healthData);
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
    const stored = window.localStorage.getItem(sidebarCollapsedStorageKey);
    if (stored === "true") setSidebarCollapsed(true);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(sidebarCollapsedStorageKey, sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (autoScanDisabled) return;
    window.localStorage.setItem(linkedInAutoScanStorageKey, autoScanEnabled ? "true" : "false");
  }, [autoScanDisabled, autoScanEnabled]);

  useEffect(() => {
    if (autoScanDisabled || !autoScanEnabled) return undefined;
    const timer = setInterval(() => {
      if (autoScanInFlightRef.current) return;
      // Quiet hours pause auto-scan during the 22:00-06:00 window. The
      // toggle is otherwise inert; this gives it something tangible to do
      // (#94).
      if (isQuietHoursActive()) return;
      autoScanInFlightRef.current = true;
      // Kick LinkedIn (rate-limited browser session) and iMessage (local
      // chat.db read, essentially free) on the same cadence. The runner
      // serializes them per-platform; iMessage will usually finish in
      // under a second while LinkedIn is still going.
      Promise.all([
        apiPost("/runner/control/scan", { platform: "LINKEDIN", scope: "update" }).catch(() => undefined),
        apiPost("/runner/control/scan", { platform: "IMESSAGE", scope: "update" }).catch(() => undefined)
      ]).finally(() => {
        autoScanInFlightRef.current = false;
      });
    }, linkedInAutoScanIntervalMs);
    return () => clearInterval(timer);
  }, [autoScanDisabled, autoScanEnabled]);

  // SSE event stream. Pages subscribe to `runner-event` / `runner-resync`
  // window events.
  //
  // Dep list intentionally OMITS `pathname`. Previously this effect re-ran
  // on every route change, tearing down and re-opening the SSE connection
  // — which lost in-flight events, incremented the runner's connection
  // count, and triggered a fresh sinceEventId replay on every navigation.
  // The dispatched window events reach every page regardless of pathname,
  // so there's no reason to recreate the source per route. Stash
  // `refreshMeta` in a ref so the effect doesn't need it as a dep.
  const refreshMetaRef = useRef(refreshMeta);
  useEffect(() => {
    refreshMetaRef.current = refreshMeta;
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
          void refreshMetaRef.current();
        }
      } catch {
        // Ignore malformed event payloads.
      }
    };
    source.onerror = () => {
      // Let EventSource auto-reconnect.
    };
    return () => source.close();
  }, []);

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
        return;
      }
      // `[` collapses/expands the main nav sidebar. Skipped when typing
      // in inputs/textareas/contenteditable so it doesn't fight the
      // composer or any search field.
      if (event.key === "[") {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target?.isContentEditable
        ) {
          return;
        }
        event.preventDefault();
        setSidebarCollapsed((prev) => !prev);
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

  // Quiet hours: when the toggle is on AND the local time is between
  // 22:00 and 06:00, mute the sidebar attention dot and pause auto-scan
  // (gated above). Keeps the toggle honest with its label (#94).
  const sidebarAttention = isQuietHoursActive() ? 0 : attentionCount;

  return (
    <div
      className="grid h-screen overflow-hidden bg-paper text-ink"
      style={{
        gridTemplateColumns: sidebarCollapsed ? "56px 1fr" : "200px 1fr"
      }}
    >
      <Sidebar
        health={health}
        attentionCount={sidebarAttention}
        userInitials={userInitials}
        onOpenSearch={() => setPaletteOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
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
