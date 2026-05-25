"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { resolveAutoScanDisabled, resolveAutoScanInitialEnabled } from "@inbox-os/core/autoscan";
import { Sidebar } from "@/components/layout/sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { TopStatus } from "@/components/layout/top-status";
import { ToastHost } from "@/components/common/toast-host";
import { PilotFeedbackModal } from "@/components/common/pilot-feedback-modal";
import { PilotTour, recoverAbandonedTourIfAny } from "@/components/common/pilot-tour";
import { apiGet, apiPost } from "@/lib/api";
import { isQuietHoursActive } from "@/lib/quiet-hours";
import {
  detectNewInbound,
  notifyNewMessage,
  notifyNewMessageDigest,
  requestNotificationPermission,
  snapshotInbox,
  type InboxSnapshot
} from "@/lib/notifications";
import type { HealthResponse, InboxResponse, InboxRow, OperatorProfile } from "@/lib/types";

const linkedInAutoScanStorageKey = "linkedin_dashboard_autoscan_enabled";
// Auto-scan cadence is randomised between 8 and 13 minutes per
// firing rather than the old hard 10-min loop. A perfect 10-minute
// cadence is one of the strongest behavioural fingerprints we
// produce — anyone watching the LinkedIn account would see a
// scrape land like clockwork. Jittering still averages a similar
// rate but kills the periodicity.
const LINKEDIN_AUTO_SCAN_MIN_MS = 8 * 60 * 1000;
const LINKEDIN_AUTO_SCAN_MAX_MS = 13 * 60 * 1000;
function nextAutoScanDelayMs(): number {
  return Math.floor(Math.random() * (LINKEDIN_AUTO_SCAN_MAX_MS - LINKEDIN_AUTO_SCAN_MIN_MS + 1)) + LINKEDIN_AUTO_SCAN_MIN_MS;
}

// Active-hours gate: only auto-scan during plausible working hours
// for a real person on this account. Skipping nights and weekends
// matches a personal-account usage profile much more closely than
// scraping at 3am on a Sunday. Quiet hours (22:00-06:00) are
// already handled via isQuietHoursActive(); this layer adds the
// weekday constraint and a daytime window. The user-facing quiet
// hours toggle still wins — turning quiet hours off doesn't bypass
// active-hours.
// Configurable so this doesn't become a "why isn't it scanning?"
// debug session for anyone who works different hours, a different
// timezone, or actually uses LinkedIn on weekends. These are
// NEXT_PUBLIC_* because this runs client-side (Next only exposes
// NEXT_PUBLIC_ vars to the browser bundle). Hours are local-clock
// 24h ints; end is exclusive. Set NEXT_PUBLIC_AUTO_SCAN_WEEKENDS=1
// to also scan Sat/Sun. Bad/missing values fall back to the
// 08:00-19:00 weekday default.
function parseHour(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 24 ? n : fallback;
}
const AUTO_SCAN_ACTIVE_HOUR_START = parseHour(
  process.env.NEXT_PUBLIC_AUTO_SCAN_HOUR_START,
  8
);
const AUTO_SCAN_ACTIVE_HOUR_END = parseHour(
  process.env.NEXT_PUBLIC_AUTO_SCAN_HOUR_END,
  19
);
const AUTO_SCAN_INCLUDE_WEEKENDS =
  process.env.NEXT_PUBLIC_AUTO_SCAN_WEEKENDS === "1" ||
  process.env.NEXT_PUBLIC_AUTO_SCAN_WEEKENDS === "true";
function isWithinActiveHours(now: Date = new Date()): boolean {
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  if (!AUTO_SCAN_INCLUDE_WEEKENDS && (day === 0 || day === 6)) return false;
  const hour = now.getHours();
  return hour >= AUTO_SCAN_ACTIVE_HOUR_START && hour < AUTO_SCAN_ACTIVE_HOUR_END;
}
const sidebarCollapsedStorageKey = "dashboard_sidebar_collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [attentionCount, setAttentionCount] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Operator display name for the sidebar footer (#332). Sourced from
  // operator_profile_v1 so a fresh install still falls back to "Operator"
  // rather than baking any persona into the shell.
  const [operatorDisplayName, setOperatorDisplayName] = useState<string | null>(null);
  const autoScanInFlightRef = useRef(false);
  // New-message desktop notifications: the previous inbox snapshot to diff
  // against, plus a flag so the first poll only establishes a baseline
  // rather than alerting for the whole existing inbox.
  const inboxSnapshotRef = useRef<InboxSnapshot | null>(null);
  const notificationsPrimedRef = useRef(false);
  const autoScanDisabled = useMemo(
    () =>
      resolveAutoScanDisabled({
        nodeEnv: process.env.NODE_ENV,
        disableAutoScan: process.env.NEXT_PUBLIC_DISABLE_AUTOSCAN,
        legacyDisableAutoScan: process.env.NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN
      }),
    []
  );
  // Diff the latest inbox poll against the previous one and raise a
  // desktop notification for any thread that gained a new inbound
  // message. Gated so it stays a signal, not noise: silent on the first
  // poll (baseline only), silent while the tab is focused (the Today feed
  // already shows it), silent during quiet hours, and rolled up into one
  // digest when a batch lands at once.
  const maybeNotify = useCallback(
    (rows: InboxRow[]) => {
      const previous = inboxSnapshotRef.current;
      inboxSnapshotRef.current = snapshotInbox(rows);
      if (!notificationsPrimedRef.current || !previous) {
        notificationsPrimedRef.current = true;
        return;
      }
      if (typeof document !== "undefined" && document.visibilityState !== "hidden") return;
      if (isQuietHoursActive()) return;
      const fresh = detectNewInbound(previous, rows);
      if (fresh.length === 0) return;
      if (fresh.length <= 3) {
        for (const row of fresh) {
          notifyNewMessage(row, (threadId) => router.push(`/thread/${threadId}`));
        }
      } else {
        notifyNewMessageDigest(fresh, () => router.push("/today"));
      }
    },
    [router]
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
      maybeNotify(inboxData.rows);
    }
  }, [maybeNotify]);

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

  // Keep the sidebar footer label in sync with the operator's displayName.
  // Fires `operator-profile-saved` whenever Settings writes a new profile —
  // we re-fetch so the sidebar updates without a full reload.
  useEffect(() => {
    const loadProfile = () => {
      void apiGet<OperatorProfile>("/runner/data/operator-profile")
        .then((profile) => setOperatorDisplayName(profile?.displayName ?? null))
        .catch(() => undefined);
    };
    loadProfile();
    window.addEventListener("operator-profile-saved", loadProfile);
    return () => window.removeEventListener("operator-profile-saved", loadProfile);
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (cancelled) return;
      // Three reasons we skip a tick:
      //   - already mid-scan (don't pile up requests)
      //   - quiet hours toggle is on (22:00-06:00 user override)
      //   - outside plausible active hours (weekend / before 08:00 /
      //     after 19:00 — keeps the scrape footprint matched to a
      //     real person's working pattern rather than a 24/7 bot)
      const skip = autoScanInFlightRef.current || isQuietHoursActive() || !isWithinActiveHours();
      if (!skip) {
        autoScanInFlightRef.current = true;
        // Kick LinkedIn (rate-limited browser session) and iMessage (local
        // chat.db read, essentially free) on the same cadence. The runner
        // serializes them per-platform; iMessage will usually finish in
        // under a second while LinkedIn is still going.
        void Promise.all([
          apiPost("/runner/control/scan", { platform: "LINKEDIN", scope: "update" }).catch(() => undefined),
          apiPost("/runner/control/scan", { platform: "IMESSAGE", scope: "update" }).catch(() => undefined)
        ]).finally(() => {
          autoScanInFlightRef.current = false;
        });
      }
      // Re-schedule with a fresh jitter on every firing so we don't
      // settle into a predictable cadence even with quiet-hours skips.
      timer = setTimeout(tick, nextAutoScanDelayMs());
    };
    timer = setTimeout(tick, nextAutoScanDelayMs());
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [autoScanDisabled, autoScanEnabled]);

  // Ask for desktop-notification permission once on mount so new-message
  // alerts can fire when the operator is away from the tab.
  useEffect(() => {
    void requestNotificationPermission();
  }, []);

  // One-shot recovery for an abandoned pilot guided tour. If the previous
  // session ended without a clean /control/pilot-tour/end (tab closed mid-
  // tour, hard refresh, etc.), this re-runs cleanup so the seeded demo
  // threads never linger. Guarded inside recoverAbandonedTourIfAny so it
  // can only ever fire once per JS session — route navigation inside the
  // running app cannot trigger it.
  useEffect(() => {
    void recoverAbandonedTourIfAny();
  }, []);

  // SSE event stream - kept untouched. Pages subscribe to `runner-event` /
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
        }
        // Refresh the app-wide inbox snapshot the moment a scan finishes
        // (or a resync is demanded) so new-message notifications fire
        // promptly - background tabs throttle the 8s poll hard, which is
        // exactly when the notification matters most.
        if (payload.type === "RESYNC_REQUIRED" || payload.type === "SCAN_FINISHED") {
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
        onOpenSearch={() => setPaletteOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
        operatorDisplayName={operatorDisplayName}
      />
      <div className="flex h-screen min-h-0 flex-col">
        <TopStatus />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ToastHost />
      <PilotFeedbackModal />
      <PilotTour />
    </div>
  );
}
