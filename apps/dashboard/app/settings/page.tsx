"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import type { AppSettings, HealthResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Canvas, PageHead, QuietRow } from "@/components/common/canvas";

interface AiStatus {
  activeProvider: "openai" | "glm";
  activeModel: string;
  configuredProviders: Array<"openai" | "glm">;
  activeProviderConfigured: boolean;
}

const AUTO_SCAN_KEY = "linkedin_dashboard_autoscan_enabled";
const QUIET_HOURS_KEY = "inbox_quiet_hours";

// Settings — leading with the four primary toggles in the calm row
// pattern (Quiet hours, Auto-scan, Headless browser, Demo data). The
// advanced surface (scan thresholds, AI provider, danger-zone reset,
// runner restart) sits behind a quiet expander so it stays out of the
// way until the operator asks for it.
export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [autoScan, setAutoScan] = useState(false);
  const [quietHours, setQuietHours] = useState(false);
  const [autoScanDisabled, setAutoScanDisabled] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    const [settingsData, aiData] = await Promise.all([
      apiGet<AppSettings>("/runner/data/settings").catch(() => null),
      apiGet<AiStatus>("/runner/data/ai-status").catch(() => null)
    ]);
    if (settingsData) setSettings(settingsData);
    setAiStatus(aiData);
  }, []);

  useEffect(() => {
    void refreshAll();
    setAutoScanDisabled(
      resolveAutoScanDisabled({
        nodeEnv: process.env.NODE_ENV,
        disableAutoScan: process.env.NEXT_PUBLIC_DISABLE_AUTOSCAN,
        legacyDisableAutoScan: process.env.NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN
      })
    );
    setAutoScan(window.localStorage.getItem(AUTO_SCAN_KEY) === "true");
    setQuietHours(window.localStorage.getItem(QUIET_HOURS_KEY) === "1");
  }, [refreshAll]);

  const updateRunner = async (partial: Partial<AppSettings>) => {
    setSaving(true);
    setError(null);
    try {
      const next = await apiPost<AppSettings>("/runner/control/settings", partial);
      setSettings(next);
      setSavedAt(Date.now());
      // Refresh ai-status after settings change so the missing-key warning
      // reflects the active provider.
      void apiGet<AiStatus>("/runner/data/ai-status")
        .then(setAiStatus)
        .catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

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

  const toggleHeadless = () => {
    if (!settings) return;
    void updateRunner({ headless: !settings.headless });
  };

  const toggleDemo = () => {
    if (!settings) return;
    void updateRunner({ demoMode: !settings.demoMode });
  };

  const restartRunner = async () => {
    if (!window.confirm("Restart the runner? Any in-flight scan or send will be cancelled.")) {
      return;
    }
    try {
      await apiPost("/runner/control/system/restart", {});
      // The runner exits ~250ms after the 202; poll back up.
      const startedAt = Date.now();
      while (Date.now() - startedAt < 90_000) {
        const ok = await apiGet<HealthResponse>("/runner/health")
          .then(() => true)
          .catch(() => false);
        if (ok) {
          window.location.reload();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      setError("Runner did not come back within 90s.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restart failed");
    }
  };

  if (!settings) {
    return (
      <Canvas>
        <PageHead eyebrow="Preferences" title="Settings." />
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      </Canvas>
    );
  }

  return (
    <Canvas>
      <PageHead
        eyebrow="Preferences"
        title="Settings."
        meta={
          savedAt && Date.now() - savedAt < 4000 ? (
            <span className="text-ink">saved</span>
          ) : null
        }
      />

      {error ? (
        <p className="mb-4 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      <QuietRow
        name="Quiet hours"
        stat="after 22:00, mute the sidebar dot"
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
            ? "disabled by env — restart the dashboard after editing .env"
            : "every 10 minutes"
        }
        action={
          <Button variant="quiet" disabled={autoScanDisabled} onClick={toggleAutoScan}>
            {autoScan && !autoScanDisabled ? "On" : "Off"}
          </Button>
        }
      />
      <QuietRow
        name="Headless browser"
        stat="scan invisibly in the background"
        action={
          <Button variant="quiet" disabled={saving} onClick={toggleHeadless}>
            {settings.headless ? "On" : "Off"}
          </Button>
        }
      />
      <QuietRow
        name="Demo data"
        stat="seed sample threads & receipts"
        action={
          <Button variant="quiet" disabled={saving} onClick={toggleDemo}>
            {settings.demoMode ? "On" : "Off"}
          </Button>
        }
      />

      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
        className="mt-10"
      >
        <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 hover:text-ink">
          Advanced
        </summary>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <label className="block">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              Scan interval (seconds)
            </span>
            <Input
              type="number"
              className="mt-2"
              value={settings.scanIntervalSeconds}
              onChange={(event) =>
                setSettings({ ...settings, scanIntervalSeconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="block">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              Waiting threshold (hours)
            </span>
            <Input
              type="number"
              className="mt-2"
              value={settings.amberHours}
              onChange={(event) =>
                setSettings({ ...settings, amberHours: Number(event.target.value) })
              }
            />
          </label>
          <label className="block">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              Overdue threshold (hours)
            </span>
            <Input
              type="number"
              className="mt-2"
              value={settings.redHours}
              onChange={(event) =>
                setSettings({ ...settings, redHours: Number(event.target.value) })
              }
            />
          </label>
          <label className="block">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              Max messages per thread
            </span>
            <Input
              type="number"
              className="mt-2"
              value={settings.maxMessagesPerThread}
              onChange={(event) =>
                setSettings({ ...settings, maxMessagesPerThread: Number(event.target.value) })
              }
            />
          </label>
        </div>

        <div className="mt-6">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
            AI provider
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {(["openai", "glm"] as const).map((provider) => {
              const active = (settings.aiProvider ?? "openai") === provider;
              const configured = aiStatus?.configuredProviders.includes(provider) ?? true;
              return (
                <Button
                  key={provider}
                  variant={active ? "primary" : "quiet"}
                  onClick={() => setSettings({ ...settings, aiProvider: provider })}
                >
                  {provider === "openai" ? "OpenAI" : "GLM (Z.AI)"}
                  {configured ? null : " ·"}
                </Button>
              );
            })}
          </div>
          {aiStatus && !aiStatus.activeProviderConfigured ? (
            <p className="mt-3 font-mono text-[11px] text-risk-overdue">
              {aiStatus.activeProvider === "glm" ? "GLM" : "OpenAI"} is selected but no API key is
              configured. Set{" "}
              <code>{aiStatus.activeProvider === "glm" ? "Z_AI_API_KEY" : "OPENAI_API_KEY"}</code>{" "}
              in <code>.env</code> and restart the runner.
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={saving}
            onClick={() =>
              void updateRunner({
                scanIntervalSeconds: settings.scanIntervalSeconds,
                amberHours: settings.amberHours,
                redHours: settings.redHours,
                maxMessagesPerThread: settings.maxMessagesPerThread,
                aiProvider: settings.aiProvider,
                glmModel: settings.glmModel?.trim() ? settings.glmModel.trim() : undefined
              })
            }
          >
            Save advanced
          </Button>
          <Button variant="quiet" onClick={() => void restartRunner()}>
            Restart runner
          </Button>
        </div>
      </details>
    </Canvas>
  );
}
