"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import { Canvas, PageHead } from "@/components/common/canvas";
import { UserVoiceProfile } from "@/components/settings/UserVoiceProfile";
import { PilotWelcomeCard } from "@/components/common/pilot-welcome";
import { openPilotFeedback, PILOT_WELCOME_DISMISSED_KEY } from "@/lib/pilot";
import { notificationsSupported, requestNotificationPermission } from "@/lib/notifications";
import { localDateString } from "@/lib/overdue-digest";
import type {
  OverdueDigestCadence,
  OverdueDigestCandidate,
  OverdueDigestPreview,
  OverdueDigestSettings
} from "@/lib/overdue-digest";
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
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Headless lives in the runner's persisted settings (the runner reads
  // settings.headless when launching Chrome), so unlike autoScan/quietHours
  // it round-trips through the API rather than localStorage.
  const [headless, setHeadless] = useState(true);
  const [headlessReady, setHeadlessReady] = useState(false);
  const [headlessStatus, setHeadlessStatus] = useState<"idle" | "saving" | "error">("idle");

  // Clearing the dismissed flag brings the welcome card back on Today.
  const [welcomeReset, setWelcomeReset] = useState(false);

  useEffect(() => {
    setAutoScanDisabled(
      resolveAutoScanDisabled({
        nodeEnv: process.env.NODE_ENV,
        disableAutoScan: process.env.NEXT_PUBLIC_DISABLE_AUTOSCAN,
        legacyDisableAutoScan: process.env.NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN
      })
    );
    setAutoScan(window.localStorage.getItem(AUTO_SCAN_KEY) === "true");
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
          desc="Pull new messages from every connected platform on a fixed cadence."
          trailing={
            <div className="flex items-center gap-[10px]">
              <span className="font-mono text-[11px] text-ink-3">every 10 min</span>
              <Toggle
                on={autoScan && !autoScanDisabled}
                disabled={autoScanDisabled}
                onChange={toggleAutoScan}
                label="Auto-scan"
              />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup head="Privacy">
        <SettingRow
          name="Quiet hours"
          desc="After 22:00, mute the attention dot and pause auto-scan."
          trailing={
            <div className="flex items-center gap-[10px]">
              <span className="font-mono text-[11px] text-ink-3">22:00-06:00</span>
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
          trailing={
            <div className="flex items-center gap-[10px]">
              <span className="font-mono text-[11px] text-ink-3">
                {headlessStatus === "saving"
                  ? "saving…"
                  : headlessStatus === "error"
                    ? <span className="text-risk-overdue">failed</span>
                    : headless
                      ? "headless"
                      : "visible"}
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

      <UserVoiceProfile variant="settings" />

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
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [count, setCount] = useState<number | null>(null);

  const handleClick = async () => {
    if (status === "running") return;
    const ok = window.confirm(
      "Clear cached AI briefs and suggested replies for every active thread? This cannot be undone — each thread will regenerate lazily as it is next viewed or reassessed."
    );
    if (!ok) return;
    setStatus("running");
    try {
      const result = await apiPost<{ ok: true; threadsMarked: number }>(
        "/runner/control/threads/mark-all-for-reassess",
        {}
      );
      setCount(result.threadsMarked);
      setStatus("done");
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
  trailing
}: {
  name: string;
  desc?: string;
  trailing: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-6 border-t border-hairline px-1 py-[16px]">
      <div>
        <p className="m-0 mb-[4px] text-[14.5px] font-medium text-ink">{name}</p>
        {desc ? (
          <p className="m-0 max-w-[54ch] text-[12.5px] leading-[1.5] text-ink-3" style={{ textWrap: "pretty" }}>
            {desc}
          </p>
        ) : null}
      </div>
      <div>{trailing}</div>
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

  if (permission === "granted") {
    return (
      <span className="inline-flex items-center gap-[6px] font-mono text-[11px] text-ink-3">
        <span className="inline-block h-[6px] w-[6px] rounded-full bg-risk-fresh" />
        Enabled
      </span>
    );
  }

  if (permission === "denied") {
    return (
      <span className="font-mono text-[11px] text-ink-3">
        Blocked - re-enable in your browser settings
      </span>
    );
  }

  // permission === "default" — actionable enable button
  return (
    <button
      type="button"
      onClick={() => void enable()}
      disabled={busy}
      className={cn(
        "inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm",
        "hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
        busy && "cursor-not-allowed opacity-60"
      )}
    >
      {busy ? "Asking…" : "Enable desktop notifications"}
    </button>
  );
}

// #360: calm overdue-reply digest. Quiet, opt-in, low-frequency. Sits
// under Notifications because it shares the desktop-notification gate;
// the cadence selector defaults to Off and the operator can dismiss today
// or snooze individual people from here without disabling the feature.
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
    if (notificationsSupported()) {
      setPermission(Notification.permission);
    } else {
      setPermission("unsupported");
    }
    void refresh();
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
    <div className="grid grid-cols-[1fr_auto] items-start gap-6 border-t border-hairline px-1 py-[16px]">
      <div>
        <p className="m-0 mb-[4px] text-[14.5px] font-medium text-ink">Overdue reply digest</p>
        <p
          className="m-0 max-w-[54ch] text-[12.5px] leading-[1.5] text-ink-3"
          style={{ textWrap: "pretty" }}
        >
          One calm reminder for overdue replies. Off by default. Choose daily or weekly if you
          want a single digest. Clicks open Today, so you can work through the queue in your
          own time.
        </p>
        {desktopNotEnabled ? (
          <p className="m-0 mt-[8px] font-mono text-[11px] text-ink-3">
            Enable desktop notifications first.
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
            disabled={busy || desktopNotEnabled}
            onClick={() => void writeCadence("daily")}
          />
          <CadenceOption
            label="Weekly"
            selected={cadence === "weekly"}
            disabled={busy || desktopNotEnabled}
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
  onClick
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center rounded-pill border px-[14px] py-[6px] font-mono text-[11px] transition-colors duration-calm",
        selected
          ? "border-ink bg-ink text-paper"
          : "border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      {label}
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
        "relative h-[20px] w-[36px] rounded-pill transition-colors duration-calm",
        on ? "bg-ink" : "bg-hairline",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-[2px] h-[16px] w-[16px] rounded-full bg-paper shadow-[0_1px_3px_rgba(0,0,0,0.15)] transition-transform duration-calm",
          on ? "translate-x-[18px]" : "translate-x-[2px]"
        )}
      />
    </button>
  );
}
