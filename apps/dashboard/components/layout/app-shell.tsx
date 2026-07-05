"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { resolveAutoScanDisabled, resolveAutoScanInitialEnabled } from "@inbox-os/core/autoscan";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileDock } from "@/components/layout/mobile-dock";
import { CommandPalette } from "@/components/layout/command-palette";
import { TopStatus } from "@/components/layout/top-status";
import { ToastHost } from "@/components/common/toast-host";
import { PilotFeedbackModal } from "@/components/common/pilot-feedback-modal";
import { PilotTour } from "@/components/common/PilotTour";
import { FocusOverlays } from "@/components/common/focus/focus-overlays";
import { FullDemoBanner } from "@/components/full-demo/FullDemoBanner";
import { apiGet, apiGetRaw, apiPost } from "@/lib/api";
import { startAppUpdate } from "@/lib/app-update-action";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { isQuietHoursActive } from "@/lib/quiet-hours";
import {
  DEFAULT_SCAN_INTERVAL,
  nextScanDelayMs,
  onScanIntervalChange,
  readScanInterval,
  type ScanIntervalId
} from "@/lib/scan-interval";
import {
  buildUpdateNotice,
  planUpdateNotice,
  readNotifiedUpdateVersion,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_NOTICE_ID,
  writeNotifiedUpdateVersion,
  type UpdateCheckResponse
} from "@/lib/update-notice";
import {
  buildNewMessageDigestNotice,
  buildNewMessageNotice,
  detectNewInbound,
  NEW_MESSAGE_TOAST_DURATION_MS,
  notificationsSupported,
  notifyNewMessage,
  notifyNewMessageDigest,
  notifyAppUpdateAvailable,
  notifyOverdueReplyDigest,
  planNewMessageNotice,
  snapshotInbox,
  type InboxSnapshot
} from "@/lib/notifications";
import {
  dismissCenterNotification,
  markCenterNotificationsSeen,
  pruneRepliedCenterNotifications,
  recordCenterNotifications,
  recordNewMessageNotifications,
  recordOverdueDigestNotification
} from "@/lib/notification-center";
import { dismissToast, showToast } from "@/lib/feedback";
import {
  classifyDigestAckError,
  digestFireFingerprint,
  EMPTY_DIGEST_FIRE_GUARD,
  localDateString,
  nextDigestFireGuard,
  planDigestFire,
  shouldAttemptDesktopDigestPing,
  shouldQueryDigestTick,
  summariseCandidatesForAck,
  type DigestAckOutcome,
  type DigestFireGuard,
  type OverdueDigestSettings,
  type OverdueDigestTickResult
} from "@/lib/overdue-digest";
import type { HealthResponse, InboxResponse, InboxRow, OperatorProfile } from "@/lib/types";
import { recordThreadSource } from "@/lib/thread-source";
import { isInTodayQueue } from "@/lib/today";

const linkedInAutoScanStorageKey = "linkedin_dashboard_autoscan_enabled";
// Auto-scan cadence is randomised per firing rather than a hard loop: a
// perfectly periodic scan is one of the strongest behavioural fingerprints
// we produce — anyone watching the LinkedIn account would see a scrape land
// like clockwork. The base interval is operator-adjustable now (pilot
// R-0087 / #754, Settings > Capture), and lib/scan-interval.ts keeps every
// cadence on the same proportional jitter the historical 8-13 min window
// gave the 10-minute default.

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
  // Issue #336. Remember the most recent non-thread route so that
  // archiving a thread can return the operator to wherever they came
  // from rather than always bouncing to /today. Lives in the shell so
  // every list page contributes without needing per-page wiring.
  useEffect(() => {
    recordThreadSource(pathname);
  }, [pathname]);
  // Issue #435 (R-0057). Tri-state, not a binary. `undefined` means the
  // first /health fetch hasn't resolved yet (a cold mount / reload),
  // which the sidebar renders as a calm "Connecting…" rather than the
  // alarming "Runner offline". `null` means a fetch actually completed
  // and failed with no prior success — that's a truthful offline. An
  // object is the last good health. Soft navigation keeps this state
  // (AppShell lives in the root layout), so this only ever shows on a
  // genuine fresh mount.
  const [health, setHealth] = useState<HealthResponse | null | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [attentionCount, setAttentionCount] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Operator display name for the sidebar footer (#332). Sourced from
  // operator_profile_v1 so a fresh install still falls back to "Operator"
  // rather than baking any persona into the shell.
  // #435: `undefined` while the first profile fetch is in flight so the
  // sidebar shows a skeleton instead of flashing the generic "Operator"
  // fallback before the real name resolves. `null` = loaded, no profile.
  const [operatorDisplayName, setOperatorDisplayName] = useState<string | null | undefined>(undefined);
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
  // Diff the latest inbox poll against the previous one and surface any
  // thread that gained a new inbound message. Gated so it stays a signal,
  // not noise: silent on the first poll (baseline only) and rolled up when
  // a batch lands at once. How it surfaces depends on where the operator
  // is (see planNewMessageNotice):
  //   - tab hidden: a desktop notification (suppressed during quiet hours),
  //   - tab focused: a quiet, clickable in-app toast, so a new message is
  //     visible without having to open the thread to discover it.
  const maybeNotify = useCallback(
    (rows: InboxRow[]) => {
      // #758 (R-0091): threads the operator has since replied to (from the
      // dashboard, the phone, anywhere a scan can see) drop out of the
      // notification center on every poll. Runs before the priming check so
      // even the first poll after a reload clears stale notices.
      pruneRepliedCenterNotifications(rows);
      const previous = inboxSnapshotRef.current;
      inboxSnapshotRef.current = snapshotInbox(rows);
      if (!notificationsPrimedRef.current || !previous) {
        notificationsPrimedRef.current = true;
        return;
      }
      const fresh = detectNewInbound(previous, rows);
      // Every fresh inbound lands in the notification center, whatever the
      // delivery plan turns out to be (toast, desktop ping, or quiet-hours
      // silence): the bell must answer "what came in while I was away" even
      // when the alert itself was missed or suppressed.
      recordNewMessageNotifications(fresh);
      const tabHidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      const plan = planNewMessageNotice({
        freshCount: fresh.length,
        tabHidden,
        quietHoursActive: isQuietHoursActive()
      });
      switch (plan) {
        case "none":
          return;
        case "desktop-single":
          for (const row of fresh) {
            notifyNewMessage(row, (threadId) => router.push(`/thread/${threadId}`));
          }
          return;
        case "desktop-digest":
          notifyNewMessageDigest(fresh, () => router.push("/today"));
          return;
        case "toast-single":
          for (const row of fresh) {
            const notice = buildNewMessageNotice(row);
            const threadId = row.id;
            showToast({
              id: `new-message:${threadId}`,
              kind: "info",
              title: notice.title,
              description: notice.body,
              href: notice.href,
              durationMs: NEW_MESSAGE_TOAST_DURATION_MS,
              // Waving the toast away means "seen it": stop counting it in
              // the bell badge but keep it listed for review. Clicking
              // through opens the thread itself, so the entry is done.
              onManualDismiss: () => markCenterNotificationsSeen([threadId]),
              onActivate: () => dismissCenterNotification(threadId)
            });
          }
          return;
        case "toast-digest": {
          const notice = buildNewMessageDigestNotice(fresh);
          const threadIds = fresh.map((row) => row.id);
          showToast({
            id: "new-message:digest",
            kind: "info",
            title: notice.title,
            description: notice.body,
            href: notice.href,
            durationMs: NEW_MESSAGE_TOAST_DURATION_MS,
            // The digest stands in for several threads. Dismissing it, or
            // opening /today from it, marks them all seen; each entry stays
            // in the center until handled individually.
            onManualDismiss: () => markCenterNotificationsSeen(threadIds),
            onActivate: () => markCenterNotificationsSeen(threadIds)
          });
          return;
        }
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
    // Short TTLs so this 8s background poll de-dupes with the page-level
    // /data/inbox and /health reads instead of issuing parallel duplicates.
    const [healthData, inboxData] = await Promise.all([
      apiGet<HealthResponse>("/runner/health", { ttlMs: 4000 }).catch(() => null),
      apiGet<InboxResponse>("/runner/data/inbox", { ttlMs: 4000 }).catch(() => null)
    ]);

    // healthData ?? prev ?? null: a fresh result wins; a failed poll
    // keeps the last good value (no mid-session blip to "offline"); and
    // a first poll that fails (prev === undefined) resolves to null so
    // the sidebar can stop saying "Connecting…" and tell the truth.
    setHealth((prev) => healthData ?? prev ?? null);
    if (inboxData) {
      const count = inboxData.rows.filter((row) => isInTodayQueue(row, new Set())).length;
      setAttentionCount(count);
      maybeNotify(inboxData.rows);
    }
  }, [maybeNotify]);

  // Poll health + inbox every 8s while visible; pause in background tabs and
  // catch up on return (the hook fires an immediate tick on mount).
  useVisiblePolling(() => void refreshMeta(), 8000);

  // Update-available notice: ask the runner whether a newer pilot build is
  // on the feed. A new version surfaces like a new message: a 30s toast
  // while focused, a native notification while hidden, plus a center entry.
  // Clicking any of them starts the update and relaunch flow. One notice per
  // version keeps the minute-level check quiet after the first alert.
  const checkAppUpdate = useCallback(async () => {
    const check = await apiGetRaw<UpdateCheckResponse>("/runner/system/update-check").catch(
      () => null
    );
    // Unconfigured installs and failed checks stay silent - the Settings
    // card is the place that explains those states, not a notification.
    if (!check || !check.configured || check.error) return;
    const plan = planUpdateNotice({
      updateAvailable: check.updateAvailable,
      latestVersion: check.latestVersion,
      notifiedVersion: readNotifiedUpdateVersion(),
      quietHoursActive: isQuietHoursActive()
    });
    if (plan === "none") return;
    if (plan === "clear") {
      dismissCenterNotification(UPDATE_NOTICE_ID);
      return;
    }
    const notice = buildUpdateNotice(check.latestVersion);
    recordCenterNotifications([
      {
        id: UPDATE_NOTICE_ID,
        title: notice.title,
        body: notice.body,
        href: notice.href,
        at: Date.now(),
        seen: false
      }
    ]);
    writeNotifiedUpdateVersion(check.latestVersion);
    if (plan === "record-and-toast") {
      const activateUpdate = () => {
        void startAppUpdate(check.latestVersion);
      };
      const tabHidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      if (tabHidden) {
        notifyAppUpdateAvailable(check.latestVersion, activateUpdate);
      } else {
        showToast({
          id: UPDATE_NOTICE_ID,
          kind: "info",
          title: notice.title,
          description: notice.body,
          durationMs: NEW_MESSAGE_TOAST_DURATION_MS,
          onManualDismiss: () => markCenterNotificationsSeen([UPDATE_NOTICE_ID]),
          onActivate: activateUpdate
        });
      }
    }
  }, []);

  useEffect(() => {
    void checkAppUpdate();
    const timer = window.setInterval(() => void checkAppUpdate(), UPDATE_CHECK_INTERVAL_MS);
    const onFocus = () => void checkAppUpdate();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkAppUpdate]);

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
        // If the very first load fails, fall back to the "Operator"
        // label (null) rather than leaving the skeleton up forever; a
        // later transient failure keeps whatever name we already had.
        .catch(() => setOperatorDisplayName((prev) => prev ?? null));
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

  // Operator-chosen scan cadence (pilot R-0087 / #754). Changing it in
  // Settings re-arms the loop immediately - the effect below depends on it.
  const [scanInterval, setScanInterval] = useState<ScanIntervalId>(DEFAULT_SCAN_INTERVAL);
  useEffect(() => {
    setScanInterval(readScanInterval());
    return onScanIntervalChange(() => setScanInterval(readScanInterval()));
  }, []);

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
      // A skipped tick retries on the short window whatever the cadence:
      // the gates above still decide whether the retry scans, so a daily
      // interval can't starve just because its timer landed at night.
      timer = setTimeout(tick, nextScanDelayMs(scanInterval, { skipped: skip }));
    };
    timer = setTimeout(tick, nextScanDelayMs(scanInterval));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [autoScanDisabled, autoScanEnabled, scanInterval]);

  // #359: notification permission is no longer requested on mount.
  // Asking pre-intent (i.e. on every page load before the operator has
  // signalled they want desktop alerts) is a low-quality permission
  // request — modern browsers deny these more often, and after enough
  // denies the origin can be permanently blocked from ever asking
  // again. The ask now lives behind an explicit "Enable desktop
  // notifications" button in Settings (see Notifications group there).
  // The firing logic below is unchanged — if permission is granted
  // however the operator got there, new-message alerts still work.

  // #360: calm overdue-reply digest scheduler. Quiet, opt-in, low-frequency.
  // Self-gated: never asks for permission, never fires during quiet hours,
  // never fires when cadence is off. When a digest is due it always lands
  // as one persistent bell entry (the notification center is the primary
  // surface - it works without desktop permission, which used to silently
  // disable the whole feature), plus a desktop notification when that extra
  // is available (permission granted, tab hidden). /ack is only called when
  // the digest actually landed.
  const overdueDigestInFlightRef = useRef(false);
  // Fire/ack transaction guard (#P4L3): remembers a digest we already fired
  // whose ack has not yet landed, so a failed ack does not re-fire the
  // identical notification on the next 5-minute poll.
  const overdueDigestGuardRef = useRef<DigestFireGuard>(EMPTY_DIGEST_FIRE_GUARD);
  useEffect(() => {
    const check = async () => {
      if (overdueDigestInFlightRef.current) return;
      overdueDigestInFlightRef.current = true;
      try {
        const settings = await apiGet<OverdueDigestSettings>(
          "/runner/data/overdue-digest/settings"
        ).catch(() => null);
        if (!settings) return;
        const gate = shouldQueryDigestTick({
          cadence: settings.cadence,
          quietHoursActive: isQuietHoursActive()
        });
        if (!gate) return;
        const tick = await apiPost<OverdueDigestTickResult>(
          "/runner/control/overdue-digest/tick",
          { localDate: localDateString() }
        ).catch(() => null);
        if (!tick || !tick.due || tick.candidates.length === 0) return;
        // Fire + ack are one transaction: only a successful ack advances the
        // runner's lastDigestAt. If the ack failed last time, retry it WITHOUT
        // re-firing the identical notification (#P4L3).
        const fingerprint = digestFireFingerprint(settings.lastDigestAt, tick.candidates);
        if (planDigestFire(fingerprint, overdueDigestGuardRef.current) === "fire-then-ack") {
          const people = tick.candidates.map((c) => ({
            personId: c.personId,
            personName: c.personName
          }));
          // The bell entry IS the digest: recorded unconditionally so the
          // reminder lands somewhere the operator actually looks, with or
          // without desktop permission.
          recordOverdueDigestNotification(people);
          // Desktop ping on top, only when it adds anything: permission
          // granted and the operator not already looking at the app.
          const permission: NotificationPermission | "unsupported" = notificationsSupported()
            ? Notification.permission
            : "unsupported";
          if (
            shouldAttemptDesktopDigestPing({
              notificationsSupported: notificationsSupported(),
              notificationPermission: permission,
              documentVisibility:
                typeof document === "undefined" ? "unknown" : document.visibilityState
            })
          ) {
            notifyOverdueReplyDigest(people, () => router.push("/today"));
          }
          // Arm the guard BEFORE awaiting the ack so a re-entrant poll cannot
          // re-fire while the ack is still in flight.
          overdueDigestGuardRef.current = { pendingFingerprint: fingerprint };
        }
        let outcome: DigestAckOutcome = "ok";
        try {
          await apiPost("/runner/control/overdue-digest/ack", {
            included: summariseCandidatesForAck(tick.candidates),
            // Same local date used for the tick gate above, persisted so the daily
            // cadence compares like-for-like local dates next time (#628).
            localDate: localDateString()
          });
        } catch (error) {
          outcome = classifyDigestAckError(error);
        }
        overdueDigestGuardRef.current = nextDigestFireGuard(fingerprint, outcome);
      } finally {
        overdueDigestInFlightRef.current = false;
      }
    };
    // First check after a short delay so we don't pile onto the AppShell
    // mount. After that, every 5 minutes. The cadence calendar gate
    // (daily / weekly) lives on the runner; this interval is only a poll
    // rate, not a "fire every 5 min" cadence.
    const initial = setTimeout(() => void check(), 30_000);
    const timer = setInterval(() => void check(), 5 * 60 * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [router]);

  // SSE event stream. Pages subscribe to `runner-event` / `runner-resync`
  // window events. The stream is created ONCE for the shell's lifetime: it
  // used to list `pathname` (and `refreshMeta`) in its deps, so every route
  // change tore down the EventSource and reconnected with `sinceEventId`,
  // making the runner replay its whole buffered window and re-dispatch a
  // burst of events on the freshly-mounted page. refreshMeta is read through
  // a ref so its changing identity never re-arms the stream.
  const refreshMetaRef = useRef(refreshMeta);
  refreshMetaRef.current = refreshMeta;
  useEffect(() => {
    const previousEventId = Number(window.sessionStorage.getItem("runner_last_event_id") ?? "0");
    const eventUrl = previousEventId > 0 ? `/events?sinceEventId=${previousEventId}` : "/events";
    const source = new EventSource(eventUrl);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type?: string;
          eventId?: number;
          threadId?: string;
        };
        if (payload.eventId) {
          window.sessionStorage.setItem("runner_last_event_id", String(payload.eventId));
        }
        window.dispatchEvent(new CustomEvent("runner-event", { detail: payload }));
        // #758 (R-0091): replying resolves that thread's new-message notice
        // instantly - the center entry goes, and so does a still-showing
        // 30s toast. The poll-driven prune below covers phone-side replies;
        // this covers the dashboard send the operator just made.
        if (payload.type === "MESSAGE_SENT" && payload.threadId) {
          dismissCenterNotification(payload.threadId);
          dismissToast(`new-message:${payload.threadId}`);
        }
        if (payload.type === "RESYNC_REQUIRED") {
          window.dispatchEvent(new CustomEvent("runner-resync"));
        }
        // Refresh the app-wide inbox snapshot the moment a scan finishes
        // (or a resync is demanded) so new-message notifications fire
        // promptly - background tabs throttle the 8s poll hard, which is
        // exactly when the notification matters most.
        if (payload.type === "RESYNC_REQUIRED" || payload.type === "SCAN_FINISHED") {
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

  // Quiet hours: when the toggle is on AND the local time is between
  // 22:00 and 06:00, mute the sidebar attention dot and pause auto-scan
  // (gated above). Keeps the toggle honest with its label (#94).
  const sidebarAttention = isQuietHoursActive() ? 0 : attentionCount;

  return (
    <div
      // Single column below md (the sidebar hides; the MobileDock takes
      // over). The sidebar width lives in a CSS var so the inline style
      // can't override the phone layout — a plain gridTemplateColumns
      // style would keep reserving the sidebar track at every width.
      className="grid h-app-screen grid-cols-1 overflow-hidden bg-paper text-ink md:[grid-template-columns:var(--shell-cols)]"
      style={{
        "--shell-cols": sidebarCollapsed ? "56px 1fr" : "200px 1fr"
      } as CSSProperties}
    >
      <Sidebar
        health={health}
        attentionCount={sidebarAttention}
        onOpenSearch={() => setPaletteOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
        operatorDisplayName={operatorDisplayName}
      />
      <div className="flex h-app-screen min-h-0 flex-col">
        <FullDemoBanner />
        <TopStatus />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <MobileDock attentionCount={sidebarAttention} onOpenSearch={() => setPaletteOpen(true)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ToastHost />
      <PilotFeedbackModal />
      <PilotTour />
      <FocusOverlays />
    </div>
  );
}
