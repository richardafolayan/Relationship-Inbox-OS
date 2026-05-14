"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import type { OperatorProfile } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Canvas, PageHead, QuietRow } from "@/components/common/canvas";

const AUTO_SCAN_KEY = "linkedin_dashboard_autoscan_enabled";
const QUIET_HOURS_KEY = "inbox_quiet_hours";

// v1 user surface: quiet hours, auto-scan, and the two operator-profile
// textareas the AI prompts read. Operator-only knobs (headless, demo
// data, scan thresholds, AI provider, enabled platforms, danger-zone
// reset, runner restart) were stripped in PR1; restore from
// archive/pre-v1-stripback if they're needed back.
export default function SettingsPage() {
  const [autoScan, setAutoScan] = useState(false);
  const [quietHours, setQuietHours] = useState(false);
  const [autoScanDisabled, setAutoScanDisabled] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Operator self-description. Two free-text fields the AI prompts read
  // (apps/runner/src/services/ai.ts → operatorProfileFragment) so suggested
  // replies and voice rewrites stay in the operator's domain.
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

  return (
    <Canvas>
      <PageHead
        eyebrow="Preferences"
        title="Settings"
        subtitle="Quiet hours, auto-scan, and how the AI hears your voice."
        meta={
          savedAt && Date.now() - savedAt < 4000 ? (
            <span className="text-ink">saved</span>
          ) : null
        }
      />

      <QuietRow
        name="Quiet hours"
        stat="22:00 - 06:00 local: mute the sidebar dot and pause auto-scan"
        action={
          <Button variant="quiet" onClick={toggleQuietHours}>
            {quietHours ? "On" : "Off"}
          </Button>
        }
      />
      <QuietRow
        name="Auto-scan"
        stat={
          autoScanDisabled
            ? "disabled by env - restart the dashboard after editing .env"
            : "every 10 minutes"
        }
        action={
          <Button variant="quiet" disabled={autoScanDisabled} onClick={toggleAutoScan}>
            {autoScan && !autoScanDisabled ? "On" : "Off"}
          </Button>
        }
      />

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
