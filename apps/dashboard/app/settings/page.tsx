"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import type { OperatorProfile } from "@/lib/types";
import { Canvas, PageHead } from "@/components/common/canvas";
import { cn } from "@/lib/utils";

const AUTO_SCAN_KEY = "linkedin_dashboard_autoscan_enabled";
const QUIET_HOURS_KEY = "inbox_quiet_hours";

// v1 user surface: auto-scan, quiet hours, headless browser, and the two
// operator-profile textareas the AI prompts read. Other operator-only
// knobs (demo data, scan thresholds, AI provider, enabled platforms,
// danger-zone wipe, runner restart) were stripped in PR1; restore from
// archive/pre-v1-stripback if they're needed back.
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

  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>({ about: "", interests: "" });
  const [operatorProfileStatus, setOperatorProfileStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const operatorProfileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (operatorProfileSaveTimer.current) clearTimeout(operatorProfileSaveTimer.current);
  }, []);

  const onOperatorProfileChange = useCallback((field: keyof OperatorProfile, value: string) => {
    setOperatorProfile((prev) => ({ ...prev, [field]: value }));
    setOperatorProfileStatus("saving");
    if (operatorProfileSaveTimer.current) clearTimeout(operatorProfileSaveTimer.current);
    operatorProfileSaveTimer.current = setTimeout(async () => {
      try {
        const next = await apiPost<OperatorProfile>("/runner/control/operator-profile", {
          [field]: value
        });
        setOperatorProfile(next);
        setOperatorProfileStatus("saved");
      } catch {
        setOperatorProfileStatus("error");
      }
    }, 600);
  }, []);

  useEffect(() => {
    void apiGet<OperatorProfile>("/runner/data/operator-profile")
      .then((data) => { if (data) setOperatorProfile(data); })
      .catch(() => undefined);
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
              <span className="font-mono text-[11px] text-ink-3">22:00–06:00</span>
              <Toggle on={quietHours} onChange={toggleQuietHours} label="Quiet hours" />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup head="Browser">
        <SettingRow
          name="Headless browser"
          desc="Run Chrome without a visible window (default). Turn off to watch a live scan/send for debugging — note a visible window is less detection-prone for LinkedIn."
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

      <section
        data-testid="operator-profile"
        className="mt-10 rounded-card border border-hairline bg-paper p-5"
      >
        <div className="flex items-baseline justify-between">
          <div>
            <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              About me
            </p>
            <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-ink-2">
              The AI uses these two boxes when drafting suggested replies and rewriting in your
              voice. Empty boxes are fine - they just mean nothing extra is added to the prompt.
            </p>
          </div>
          <span
            className="font-mono text-[11px] text-ink-3"
            aria-live="polite"
          >
            {operatorProfileStatus === "saving"
              ? "saving…"
              : operatorProfileStatus === "saved"
                ? "saved"
                : operatorProfileStatus === "error"
                  ? <span className="text-risk-overdue">failed to save</span>
                  : ""}
          </span>
        </div>

        <label className="mt-4 block">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
            How you write / about you
          </span>
          <textarea
            rows={4}
            value={operatorProfile.about}
            onChange={(event) => onOperatorProfileChange("about", event.target.value)}
            placeholder="e.g. British, peer-to-peer, conversational. I'm a software engineer working on AI relationship tools. I prefer short replies - never use em-dashes or corporate filler."
            className="mt-2 w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </label>

        <label className="mt-4 block">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
            Things you care about
          </span>
          <textarea
            rows={4}
            value={operatorProfile.interests}
            onChange={(event) => onOperatorProfileChange("interests", event.target.value)}
            placeholder="e.g. AI agents, developer tooling, music production, climbing. Open to grabbing coffee with people working on similar problems; politely declining sales pitches."
            className="mt-2 w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </label>
      </section>
    </Canvas>
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
