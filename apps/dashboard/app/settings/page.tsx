"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import { Canvas, PageHead } from "@/components/common/canvas";
import { UserVoiceProfile } from "@/components/settings/UserVoiceProfile";
import { FocusSettingsSection } from "@/components/settings/FocusSettingsSection";
import { AppUpdates } from "@/components/settings/AppUpdates";
import { PilotWelcomeCard } from "@/components/common/pilot-welcome";
import { FullDemoSettingsCard } from "@/components/full-demo/FullDemoSettingsCard";
import { openPilotFeedback, PILOT_WELCOME_DISMISSED_KEY } from "@/lib/pilot";
import {
  notificationsSupported,
  readNotificationPermission,
  requestNotificationPermission,
  subscribeNotificationPermission
} from "@/lib/notifications";
import { localDateString } from "@/lib/overdue-digest";
import { interpretReassessAllResult } from "@/lib/reassess-all-result";
import type { MarkAllReassessResponse } from "@/lib/reassess-all-result";
import type {
  OverdueDigestCadence,
  OverdueDigestCandidate,
  OverdueDigestPreview,
  OverdueDigestSettings
} from "@/lib/overdue-digest";
import { clearTourSeen, startPilotTour } from "@/lib/pilot-tour";
import {
  DEFAULT_SCAN_INTERVAL,
  readScanInterval,
  SCAN_INTERVAL_OPTIONS,
  scanIntervalCaption,
  writeScanInterval,
  type ScanIntervalId
} from "@/lib/scan-interval";
import { cn } from "@/lib/utils";

const AUTO_SCAN_KEY = "linkedin_dashboard_autoscan_enabled";
const QUIET_HOURS_KEY = "inbox_quiet_hours";

// v1 user surface: auto-scan, quiet hours, headless browser, and the user
// voice / reply-style profile the AI prompts read (UserVoiceProfile). Other
// operator-only knobs (demo data, scan thresholds, AI provider, enabled
// platforms, danger-zone wipe, runner restart) were stripped in PR1;
// restore from archive/pre-v1-stripback if they're needed back.
export default function SettingsPage() {
  const [autoScan, setAutoScan] = useState(false);
  const [quietHours, setQuietHours] = useState(false);
  const [autoScanDisabled, setAutoScanDisabled] = useState(false);
  // Pilot R-0087 (#754): the scan cadence is a choice, not a constant.
  const [scanInterval, setScanInterval] = useState<ScanIntervalId>(DEFAULT_SCAN_INTERVAL);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Headless lives in the runner's persisted settings (the runner reads
  // settings.headless when launching Chrome), so unlike autoScan/quietHours
  // it round-trips through the API rather than localStorage.
  const [headless, setHeadless] = useState(true);
  const [headlessReady, setHeadlessReady] = useState(false);
  const [headlessStatus, setHeadlessStatus] = useState<"idle" | "saving" | "error">("idle");

  // Clearing the dismissed flag brings the welcome card back on Today.
  const [welcomeReset, setWelcomeReset] = useState(false);

  // /settings#app-updates (the update toast / bell entry lands here): scroll
  // the App updates card into view and flash a short highlight ring so the
  // eye finds it. Mount covers cross-page navigation; hashchange covers
  // manual edits and back/forward.
  const [highlightUpdates, setHighlightUpdates] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const maybeHighlight = () => {
      if (window.location.hash !== "#app-updates") return;
      document
        .getElementById("app-updates")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightUpdates(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHighlightUpdates(false), 2400);
    };
    maybeHighlight();
    window.addEventListener("hashchange", maybeHighlight);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", maybeHighlight);
    };
  }, []);

  useEffect(() => {
    setAutoScanDisabled(
      resolveAutoScanDisabled({
        nodeEnv: process.env.NODE_ENV,
        disableAutoScan: process.env.NEXT_PUBLIC_DISABLE_AUTOSCAN,
        legacyDisableAutoScan: process.env.NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN
      })
    );
    setAutoScan(window.localStorage.getItem(AUTO_SCAN_KEY) === "true");
    setScanInterval(readScanInterval());
    setQuietHours(window.localStorage.getItem(QUIET_HOURS_KEY) === "1");
    void apiGet<{ headless?: boolean }>("/runner/data/settings")
      .then((data) => {
        if (data && typeof data.headless === "boolean") setHeadless(data.headless);
        setHeadlessReady(true);
      })
      .catch(() => setHeadlessReady(true));
  }, []);

  const toggleQuietHours = () => {
    const next = !quietHours;
    setQuietHours(next);
    window.localStorage.setItem(QUIET_HOURS_KEY, next ? "1" : "0");
    setSavedAt(Date.now());
  };

  const toggleAutoScan = () => {
    if (autoScanDisabled) return;
    const next = !autoScan;
    setAutoScan(next);
    window.localStorage.setItem(AUTO_SCAN_KEY, next ? "true" : "false");
    setSavedAt(Date.now());
  };

  const chooseScanInterval = (next: ScanIntervalId) => {
    if (autoScanDisabled) return;
    setScanInterval(next);
    // writeScanInterval also fans out the change event, so the app shell's
    // running scan loop re-arms with the new cadence immediately.
    writeScanInterval(next);
    setSavedAt(Date.now());
  };

  const toggleHeadless = async () => {
    if (!headlessReady || headlessStatus === "saving") return;
    const next = !headless;
    setHeadless(next); // optimistic
    setHeadlessStatus("saving");
    try {
      await apiPost("/runner/control/settings", { headless: next });
      setHeadlessStatus("idle");
      setSavedAt(Date.now());
    } catch {
      setHeadless(!next); // revert
      setHeadlessStatus("error");
    }
  };

  return (
    <Canvas>
      <PageHead
        eyebrow="Preferences"
        title="Settings"
        meta={
          savedAt && Date.now() - savedAt < 4000 ? (
            <span className="text-ink">saved</span>
          ) : (
            <span>synced to local profile</span>
          )
        }
      />

      <SettingsGroup head="Capture">
        <SettingRow
          name="Auto-scan"
          desc="Pull new messages from every connected platform on the cadence you choose below."
          onActivate={toggleAutoScan}
          disabled={autoScanDisabled}
          trailing={
            <div className="flex items-center gap-[10px]">
              {/* Issue #394. Explicit On/Off state next to the saved
                  cadence so the toggle's intent is unambiguous even
                  when the visual switch is the same colour as the page
                  background. */}
              <span className="font-mono text-[11px] text-ink-3">
                {autoScanDisabled
                  ? "off (disabled in this build)"
                  : autoScan
                    ? `On · ${scanIntervalCaption(scanInterval)}`
                    : `Off · ${scanIntervalCaption(scanInterval)} when on`}
              </span>
              <Toggle
                on={autoScan && !autoScanDisabled}
                disabled={autoScanDisabled}
                onChange={toggleAutoScan}
                label="Auto-scan"
              />
            </div>
          }
        />
        <SettingRow
          name="Scan cadence"
          desc="How often auto-scan checks for new messages. Timing stays slightly randomised around your choice, and quiet hours and active hours still apply. A daily scan runs at the first quiet moment after the interval passes."
          disabled={autoScanDisabled}
          trailing={
            <div className="flex flex-wrap items-center justify-end gap-[8px]">
              {SCAN_INTERVAL_OPTIONS.map((option) => (
                <CadenceOption
                  key={option.id}
                  label={option.label}
                  selected={scanInterval === option.id}
                  disabled={autoScanDisabled}
                  onClick={() => chooseScanInterval(option.id)}
                />
              ))}
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup head="Privacy">
        <SettingRow
          name="Quiet hours"
          desc="After 22:00, mute the attention dot and pause auto-scan."
          onActivate={toggleQuietHours}
          trailing={
            <div className="flex items-center gap-[10px]">
              {/* Issue #394 / R-0034 root cause: this caption used to
                  read "22:00-06:00" alone, with the toggle showing
                  off. Pilot read that as "broken" because the saved
                  schedule was visible while the switch said off.
                  Explicit "On"/"Off" + "saved schedule" wording makes
                  the relationship clear. */}
              <span className="font-mono text-[11px] text-ink-3">
                {quietHours ? "On · 22:00-06:00" : "Off · 22:00-06:00 saved"}
              </span>
              <Toggle on={quietHours} onChange={toggleQuietHours} label="Quiet hours" />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup head="Notifications">
        <SettingRow
          name="Desktop notifications"
          desc="Show a system notification when a new message arrives. Clicking it jumps you to the thread. Quiet hours still apply, and nothing fires while this tab is in focus."
          trailing={<NotificationsPermissionControl />}
        />
        <OverdueDigestRow />
      </SettingsGroup>

      <SettingsGroup head="Browser">
        <SettingRow
          name="Headless browser"
          desc="Off by default: the real Chrome runs headful but offscreen, so scans never disrupt you AND keep a full human fingerprint. Turn on only for CI/speed. Headless is one of the strongest bot signals and is far more detectable for LinkedIn."
          onActivate={toggleHeadless}
          disabled={!headlessReady || headlessStatus === "saving"}
          trailing={
            <div className="flex items-center gap-[10px]">
              {/* Issue #394. Same clarity treatment as the other
                  toggles: lead with the explicit state, then any
                  saving/error context. */}
              <span className="font-mono text-[11px] text-ink-3">
                {headlessStatus === "saving" ? (
                  "saving…"
                ) : headlessStatus === "error" ? (
                  <span className="text-risk-overdue">failed</span>
                ) : headless ? (
                  "On · headless"
                ) : (
                  "Off · visible"
                )}
              </span>
              <Toggle
                on={headless}
                disabled={!headlessReady || headlessStatus === "saving"}
                onChange={toggleHeadless}
                label="Headless browser"
              />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup head="AI">
        <SettingRow
          name="Reassess all threads"
          desc="Clear cached briefs and suggested replies on every active thread so they regenerate against the latest AI prompts. Each thread refreshes lazily when next viewed or scanned. Use after a prompt change ships."
          trailing={<ReassessAllControl />}
        />
      </SettingsGroup>

      <div data-demo-target="settings-user-voice">
        <UserVoiceProfile variant="settings" />
      </div>

      <FocusSettingsSection />

      <section className="mt-10">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Demo</p>
        <FullDemoSettingsCard />
      </section>

      <section id="app-updates" className="mt-10 scroll-mt-24">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          App updates
        </p>
        <div
          className={cn(
            "rounded-row transition-shadow duration-500",
            highlightUpdates && "ring-2 ring-accent/70"
          )}
        >
          <AppUpdates />
        </div>
      </section>

      <section className="mt-10">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Pilot</p>
        <PilotWelcomeCard />
        <div className="flex flex-wrap items-center gap-[10px]">
          <PilotActionButton onClick={() => openPilotFeedback("feedback")}>
            Share feedback
          </PilotActionButton>
          <PilotActionButton onClick={() => openPilotFeedback("bug")}>
            Report a bug
          </PilotActionButton>
          <PilotActionButton
            onClick={() => {
              window.localStorage.removeItem(PILOT_WELCOME_DISMISSED_KEY);
              setWelcomeReset(true);
            }}
          >
            Show welcome on Today
          </PilotActionButton>
          <PilotActionButton
            onClick={() => {
              clearTourSeen(window.localStorage);
              startPilotTour({ replay: true });
            }}
          >
            Replay walkthrough
          </PilotActionButton>
          {welcomeReset ? (
            <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
              it’ll show next time you open Today
            </span>
          ) : null}
        </div>
      </section>
    </Canvas>
  );
}

// "Reset all threads for reassessment" admin action. Wraps POST to
// /runner/control/threads/mark-all-for-reassess. The endpoint is fast
// (single SQL update) but the action is broad — clears cached AI
// briefs and suggested replies on every active thread — so the click
// goes through a window.confirm gate that names the irreversibility
// and the lazy regen behaviour explicitly. Inline status mirrors the
// headless toggle's pattern so the operator sees running / success /
// error without a toast.
//
// Idle / running / done / error states show inline next to the button.
// The success line names the count concretely ("345 active threads
// reset for reassessment") rather than a vague "done", so the action
// feels grounded.
function ReassessAllControl() {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "intercepted" | "error">("idle");
  const [count, setCount] = useState<number | null>(null);

  const handleClick = async () => {
    if (status === "running") return;
    const ok = window.confirm(
      "Clear cached AI briefs and suggested replies for every active thread? This cannot be undone. Each thread will regenerate lazily as it is next viewed or reassessed."
    );
    if (!ok) return;
    setStatus("running");
    try {
      const result = await apiPost<MarkAllReassessResponse>(
        "/runner/control/threads/mark-all-for-reassess",
        {}
      );
      // In the live presenter demo the fetch interceptor swallows this
      // mutation and resolves with a read-only sentinel that has no
      // `threadsMarked` — fold it into an explicit outcome so we never
      // render "undefined active threads reset for reassessment".
      const outcome = interpretReassessAllResult(result);
      setCount(outcome.count);
      setStatus(outcome.status);
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="flex items-center gap-[10px]">
      {status === "done" && count !== null ? (
        <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
          {count} active threads reset for reassessment
        </span>
      ) : status === "intercepted" ? (
        <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
          read-only demo, nothing changed
        </span>
      ) : status === "error" ? (
        <span className="font-mono text-[11px] text-risk-overdue" aria-live="polite">
          failed
        </span>
      ) : null}
      <button
        type="button"
        onClick={handleClick}
        disabled={status === "running"}
        className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "running" ? "Resetting…" : "Reset all for reassessment"}
      </button>
    </div>
  );
}

function PilotActionButton({
  onClick,
  children
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

function SettingsGroup({ head, children }: { head: string; children: React.ReactNode }) {
  return (
    <section className="mb-9">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{head}</p>
      <div className="border-b border-hairline">{children}</div>
    </section>
  );
}

function SettingRow({
  name,
  desc,
  trailing,
  onActivate,
  disabled
}: {
  name: string;
  desc?: string;
  trailing: React.ReactNode;
  /**
   * Issue #394. When set, the entire row is clickable — not just the
   * tiny switch in the trailing area. Pilot R-0034 read the toggle
   * as "broken" partly because the click target was too small and the
   * row had no obvious affordance. Passing onActivate makes the row
   * a button-like target while still routing the same action.
   *
   * The trailing element (typically <Toggle>) stops propagation on
   * its own onClick so a click on the switch itself doesn't double-fire.
   */
  onActivate?: () => void;
  /** Disables the row click target without changing the trailing visual. */
  disabled?: boolean;
}) {
  const interactive = onActivate && !disabled;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivate?.();
              }
            }
          : undefined
      }
      className={cn(
        // Phone: control drops under the description (the trailing column
        // otherwise squeezes the copy to a word per line); sm+ keeps the
        // two-column row.
        "grid grid-cols-1 gap-3 border-t border-hairline px-1 py-[16px] sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6",
        interactive
          ? "cursor-pointer rounded-[6px] transition-colors duration-calm hover:bg-paper-2/60 focus:bg-paper-2/60 focus:outline-none"
          : null
      )}
    >
      <div>
        <p className="m-0 mb-[4px] text-[14.5px] font-medium text-ink">{name}</p>
        {desc ? (
          <p className="m-0 max-w-[54ch] text-[12.5px] leading-[1.5] text-ink-3" style={{ textWrap: "pretty" }}>
            {desc}
          </p>
        ) : null}
      </div>
      <div onClick={(event) => event.stopPropagation()}>{trailing}</div>
    </div>
  );
}

// #359: desktop notification permission control.
//
// The previous version asked for permission on every AppShell mount,
// before the operator had expressed any intent. Browsers (Chrome
// especially) treat these "cold" requests as low-quality signals and
// deny them more readily; after enough denies the origin can be
// permanently blocked from ever asking again. This control moves the
// ask behind an explicit operator gesture and reflects the live
// permission state so it never re-prompts a granted/denied browser.
function NotificationsPermissionControl() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported"
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!notificationsSupported()) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
  }, []);

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await requestNotificationPermission();
      setPermission(result);
    } finally {
      setBusy(false);
    }
  };

  if (permission === "unsupported") {
    return (
      <span className="font-mono text-[11px] text-ink-3">Not supported in this browser</span>
    );
  }

  // #436 R-0058: present the same caption + pill shape as every other
  // Notifications row instead of a bespoke "● Enabled" label. The browser
  // permission can't be flipped off from JS once granted/denied, so those
  // states render a read-only pill and the caption names where the real
  // control lives. "default" is the only in-app actionable state: the OFF
  // pill requests permission on click — an explicit gesture, so it keeps
  // the #359 fix that avoids low-quality cold prompts.
  const on = permission === "granted";
  const caption =
    permission === "granted"
      ? "On · turn off in your browser"
      : permission === "denied"
        ? "Blocked · re-enable in your browser"
        : busy
          ? "asking…"
          : "Off";

  return (
    <div className="flex items-center gap-[10px]">
      <span className="font-mono text-[11px] text-ink-3">{caption}</span>
      <Toggle
        on={on}
        disabled={busy || permission !== "default"}
        onChange={() => {
          if (permission === "default") void enable();
        }}
        label="Desktop notifications"
      />
    </div>
  );
}

// #360: calm overdue-reply digest. Quiet, opt-in, low-frequency. The digest
// lands in the notification bell whenever it is due; the desktop ping is an
// optional extra behind the sibling permission control, so the cadence
// selector works without it. The operator can dismiss today or snooze
// individual people from here without disabling the feature.
function OverdueDigestRow() {
  const [settings, setSettings] = useState<OverdueDigestSettings | null>(null);
  const [candidates, setCandidates] = useState<OverdueDigestCandidate[]>([]);
  const [snoozed, setSnoozed] = useState<OverdueDigestPreview["snoozed"]>([]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported"
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  const refresh = useCallback(async () => {
    const preview = await apiGet<OverdueDigestPreview>(
      "/runner/data/overdue-digest/preview"
    ).catch(() => null);
    if (!preview) return;
    setSettings(preview.settings);
    setCandidates(preview.candidates);
    setSnoozed(preview.snoozed);
  }, []);

  useEffect(() => {
    // Seed from the live permission, then stay in sync: granting from the
    // sibling NotificationsPermissionControl in the same session must enable
    // the cadence control here without a reload (it used to read once on
    // mount and go stale).
    setPermission(readNotificationPermission());
    const unsubscribe = subscribeNotificationPermission(setPermission);
    void refresh();
    return unsubscribe;
  }, [refresh]);

  const writeCadence = async (cadence: OverdueDigestCadence) => {
    if (busy) return;
    setBusy(true);
    setStatus("idle");
    try {
      const next = await apiPost<OverdueDigestSettings>(
        "/runner/control/overdue-digest/settings",
        { cadence }
      );
      setSettings(next);
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const dismissToday = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await apiPost<OverdueDigestSettings>(
        "/runner/control/overdue-digest/dismiss-today",
        { localDate: localDateString() }
      );
      setSettings(next);
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const snoozePerson = async (personId: string, displayName: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiPost("/runner/control/overdue-digest/snooze-person", {
        personId,
        displayName,
        days: 7
      });
      await refresh();
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const unsnoozePerson = async (personId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiPost("/runner/control/overdue-digest/unsnooze-person", { personId });
      await refresh();
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const cadence = settings?.cadence ?? "off";
  const localDateToday = localDateString();
  const alreadyDismissedToday = settings?.dismissForLocalDate === localDateToday;
  const desktopNotEnabled = permission !== "granted";

  return (
    <div className="grid grid-cols-1 gap-3 border-t border-hairline px-1 py-[16px] sm:grid-cols-[1fr_auto] sm:items-start sm:gap-6">
      <div>
        <p className="m-0 mb-[4px] text-[14.5px] font-medium text-ink">Overdue reply digest</p>
        <p
          className="m-0 max-w-[54ch] text-[12.5px] leading-[1.5] text-ink-3"
          style={{ textWrap: "pretty" }}
        >
          One calm reminder for overdue replies. Off by default. Choose daily or weekly if you
          want a single digest. It lands in the bell at the top of the app and clicks open
          Today, so you can work through the queue in your own time.
        </p>
        {desktopNotEnabled ? (
          <p className="m-0 mt-[8px] font-mono text-[11px] text-ink-3">
            Enable desktop notifications if you also want a ping while the app is in the
            background.
          </p>
        ) : null}

        <div className="mt-[14px] flex flex-wrap items-center gap-[8px]">
          <CadenceOption
            label="Off"
            selected={cadence === "off"}
            disabled={busy}
            onClick={() => void writeCadence("off")}
          />
          <CadenceOption
            label="Daily"
            selected={cadence === "daily"}
            disabled={busy}
            onClick={() => void writeCadence("daily")}
          />
          <CadenceOption
            label="Weekly"
            selected={cadence === "weekly"}
            disabled={busy}
            onClick={() => void writeCadence("weekly")}
          />
          {status === "saved" ? (
            <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
              saved
            </span>
          ) : status === "error" ? (
            <span className="font-mono text-[11px] text-risk-overdue" aria-live="polite">
              failed
            </span>
          ) : null}
        </div>

        {cadence !== "off" ? (
          <div className="mt-[16px] rounded-[10px] border border-hairline bg-paper-2/40 p-[12px]">
            <p className="m-0 mb-[8px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
              Preview
            </p>
            {candidates.length === 0 ? (
              <p className="m-0 text-[12.5px] text-ink-3">
                Nothing waiting on you right now.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
                {candidates.map((c) => (
                  <li
                    key={`${c.threadId}:${c.personId}`}
                    className="flex items-center justify-between gap-[12px] text-[12.5px] text-ink-2"
                  >
                    <span className="truncate">
                      <span
                        className={cn(
                          "mr-[8px] inline-block h-[6px] w-[6px] rounded-full align-middle",
                          c.riskLevel === "RED" ? "bg-risk-overdue" : "bg-risk-waiting"
                        )}
                        aria-hidden
                      />
                      {c.personName}
                    </span>
                    <button
                      type="button"
                      onClick={() => void snoozePerson(c.personId, c.personName)}
                      disabled={busy}
                      className="font-mono text-[11px] text-ink-3 underline decoration-hairline-strong underline-offset-2 transition-colors duration-calm hover:text-ink"
                    >
                      Snooze 7 days
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {candidates.length > 0 ? (
              <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
                <button
                  type="button"
                  onClick={() => void dismissToday()}
                  disabled={busy || alreadyDismissedToday}
                  className={cn(
                    "inline-flex items-center rounded-pill border border-hairline px-[12px] py-[6px] font-mono text-[11px] text-ink-2 transition-colors duration-calm",
                    "hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
                    (busy || alreadyDismissedToday) && "cursor-not-allowed opacity-60"
                  )}
                >
                  {alreadyDismissedToday ? "Dismissed for today" : "Dismiss for today"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {snoozed.length > 0 ? (
          <div className="mt-[14px]">
            <p className="m-0 mb-[6px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
              Snoozed people
            </p>
            <p className="m-0 mb-[8px] text-[12px] text-ink-3">
              Snoozed people stay out of the digest until the snooze ends.
            </p>
            <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
              {snoozed.map((s) => (
                <li
                  key={s.personId}
                  className="flex items-center justify-between gap-[12px] text-[12.5px] text-ink-2"
                >
                  <span className="truncate">{s.displayName}</span>
                  <button
                    type="button"
                    onClick={() => void unsnoozePerson(s.personId)}
                    disabled={busy}
                    className="font-mono text-[11px] text-ink-3 underline decoration-hairline-strong underline-offset-2 transition-colors duration-calm hover:text-ink"
                  >
                    Unsnooze
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div />
    </div>
  );
}

function CadenceOption({
  label,
  selected,
  disabled,
  disabledReason,
  onClick
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  /**
   * Surfaced beside the label when disabled, so the operator can see
   * WHY the button does nothing (pilot R-0034 — "the toggle is just
   * broken" was likely the cadence buttons being silently disabled
   * pending notifications permission). Tooltip alone wasn't enough.
   */
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      title={disabled && disabledReason ? disabledReason : undefined}
      className={cn(
        "inline-flex items-center rounded-pill border px-[14px] py-[6px] font-mono text-[11px] transition-colors duration-calm",
        selected
          ? "border-ink bg-ink text-paper"
          : "border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      {label}
      {disabled && disabledReason ? (
        <span className="ml-1 text-ink-3">({disabledReason})</span>
      ) : null}
    </button>
  );
}

function Toggle({
  on,
  onChange,
  disabled,
  label
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        // shrink-0 so the surrounding flex row (state caption + pill)
        // can't compress the track below 36px — when it did, the 16px
        // knob's on/off offsets collapsed and the switch read as
        // reversed/ambiguous (#429 R-0052).
        "relative h-[20px] w-[36px] shrink-0 rounded-pill transition-colors duration-calm",
        // Accent fill ON vs neutral track OFF reads clearly in BOTH
        // light and dark mode. The old bg-ink/bg-hairline pair was two
        // near-identical darks in dark mode, so the states were
        // indistinguishable without reading the label (#429 R-0052).
        on ? "bg-accent" : "bg-hairline-strong",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      )}
    >
      <span
        aria-hidden
        className={cn(
          // Fixed white knob (not theme paper) so it contrasts on the
          // grey OFF track and the accent ON track in either mode. OFF =
          // left, ON = right per platform convention.
          //
          // left-0 anchors the knob to the track's left edge. Without it
          // the absolute knob's static position resolved to the RIGHT
          // (computed left:18px), so the off-state translate-x-[2px] put
          // the knob at ~20px — i.e. the switch read reversed: off showed
          // the knob on the right (#429 R-0052). The transform classes
          // were always correct; the missing anchor was the real bug.
          "absolute left-0 top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-calm",
          on ? "translate-x-[18px]" : "translate-x-[2px]"
        )}
      />
    </button>
  );
}
