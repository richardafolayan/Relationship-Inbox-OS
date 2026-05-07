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
const ALL_PLATFORMS = ["LINKEDIN", "INSTAGRAM", "TIKTOK"] as const;
type PlatformKey = (typeof ALL_PLATFORMS)[number];

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [autoScan, setAutoScan] = useState(false);
  const [quietHours, setQuietHours] = useState(false);
  const [autoScanDisabled, setAutoScanDisabled] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    const [settingsData, aiData, healthData] = await Promise.all([
      apiGet<AppSettings>("/runner/data/settings").catch(() => null),
      apiGet<AiStatus>("/runner/data/ai-status").catch(() => null),
      apiGet<HealthResponse>("/runner/health").catch(() => null)
    ]);
    if (settingsData) setSettings(settingsData);
    setAiStatus(aiData);
    setHealth(healthData);
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
    const timer = setInterval(() => {
      void apiGet<HealthResponse>("/runner/health")
        .then(setHealth)
        .catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
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

  const togglePlatform = (platform: PlatformKey) => {
    if (!settings) return;
    const current = new Set(settings.enabledPlatforms);
    if (current.has(platform)) {
      current.delete(platform);
    } else {
      current.add(platform);
    }
    const next = ALL_PLATFORMS.filter((p) => current.has(p));
    void updateRunner({ enabledPlatforms: next });
  };

  const clearLinkedInInbox = async () => {
    const token = window.prompt(
      "Paste your admin reset token (ADMIN_RESET_TOKEN env on the runner) to confirm — this wipes the LinkedIn inbox locally and cannot be undone."
    );
    if (!token) return;
    setResetBusy(true);
    setResetMessage(null);
    try {
      await apiPost(
        "/runner/admin/reset",
        { platform: "LINKEDIN", confirm: "RESET" },
        { headers: { "x-admin-reset-token": token } }
      );
      setResetMessage("LinkedIn inbox cleared. Run a fresh scan to rebuild.");
    } catch (err) {
      setResetMessage(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetBusy(false);
    }
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
        name="Runner"
        stat={
          health
            ? `${health.runnerStatus.toLowerCase()} · ${health.connectedPlatforms} platform${
                health.connectedPlatforms === 1 ? "" : "s"
              } connected`
            : "status unknown"
        }
        action={
          <Button variant="quiet" onClick={() => void restartRunner()}>
            Restart
          </Button>
        }
      />
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
            Enabled platforms
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {ALL_PLATFORMS.map((platform) => {
              const active = settings.enabledPlatforms.includes(platform);
              return (
                <Button
                  key={platform}
                  variant={active ? "primary" : "quiet"}
                  disabled={saving}
                  onClick={() => togglePlatform(platform)}
                >
                  {platform}
                </Button>
              );
            })}
          </div>
          <p className="mt-2 font-mono text-[11px] text-ink-3">
            Only LinkedIn is fully tested. Toggle others on at your own risk.
          </p>
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
        </div>

        <div className="mt-10 border-t border-hairline pt-6">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.06em] text-risk-overdue">
            Danger zone
          </p>
          <p className="mb-3 text-[13px] text-ink-3">
            Wipes the LinkedIn inbox locally so the next scan rebuilds from scratch. Useful when
            parser drift has corrupted threads. Cannot be undone.
          </p>
          <Button
            variant="danger"
            disabled={resetBusy}
            onClick={() => void clearLinkedInInbox()}
          >
            {resetBusy ? "Clearing…" : "Clear LinkedIn inbox and rebuild"}
          </Button>
          {resetMessage ? (
            <p className="mt-3 font-mono text-[11px] text-ink-3">{resetMessage}</p>
          ) : null}
        </div>
      </details>
    </Canvas>
  );
}
