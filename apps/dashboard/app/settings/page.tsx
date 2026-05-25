"use client";

import { useEffect, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import { Canvas, PageHead } from "@/components/common/canvas";
import { UserVoiceProfile } from "@/components/settings/UserVoiceProfile";
import { PilotWelcomeCard } from "@/components/common/pilot-welcome";
import { FullDemoSettingsCard } from "@/components/full-demo/FullDemoSettingsCard";
import { openPilotFeedback, PILOT_WELCOME_DISMISSED_KEY } from "@/lib/pilot";
import { clearTourSeen, startPilotTour } from "@/lib/pilot-tour";
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

      <div data-demo-target="settings-user-voice">
        <UserVoiceProfile variant="settings" />
      </div>

      <section className="mt-10">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Demo</p>
        <FullDemoSettingsCard />
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
