"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const platforms = ["LINKEDIN", "INSTAGRAM", "TIKTOK"] as const;
const aiProviders = ["openai", "glm"] as const;
const aiProviderLabels: Record<(typeof aiProviders)[number], string> = {
  openai: "OpenAI",
  glm: "GLM (Z.AI)"
};

// How long the "Saved" banner stays before fading out. Long enough to
// register, short enough to not stick around if the operator is making
// rapid edits.
const SAVE_FEEDBACK_MS = 4000;

interface AiStatus {
  activeProvider: "openai" | "glm";
  activeModel: string;
  configuredProviders: Array<"openai" | "glm">;
  activeProviderConfigured: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [saving, setSaving] = useState(false);
  // Inline feedback for the Save button. Without this, clicking Save
  // gives no signal at all that the runner accepted (or rejected) the
  // change — operators end up clicking it again to be sure, and any
  // failure lands silently in the dev console.
  const [saveStatus, setSaveStatus] = useState<
    | { kind: "success"; at: number }
    | { kind: "error"; message: string }
    | null
  >(null);
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetToken, setResetToken] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetStatus, setResetStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Refetch both side by side. ai-status is needed alongside settings
  // so the warning can flag "you've selected GLM but Z_AI_API_KEY is
  // missing" before the operator wonders why every reply comes back as
  // the canned default.
  const refreshAll = () => {
    void apiGet<AppSettings>("/runner/data/settings").then(setSettings);
    void apiGet<AiStatus>("/runner/data/ai-status")
      .then(setAiStatus)
      .catch(() => setAiStatus(null));
  };

  useEffect(() => {
    refreshAll();
  }, []);

  // Clean up the auto-fade timer if the component unmounts mid-fade.
  useEffect(() => () => {
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
  }, []);

  if (!settings) {
    return <Card>Loading settings...</Card>;
  }

  const save = async (partial: Partial<AppSettings>) => {
    setSaving(true);
    setSaveStatus(null);
    if (saveStatusTimer.current) {
      clearTimeout(saveStatusTimer.current);
      saveStatusTimer.current = null;
    }
    try {
      const next = await apiPost<AppSettings>("/runner/control/settings", partial);
      setSettings(next);
      // Re-fetch ai-status so the "key missing" warning reflects the
      // newly-saved provider — the runner's config doesn't change but
      // the active provider switching can flip the warning on/off.
      void apiGet<AiStatus>("/runner/data/ai-status")
        .then(setAiStatus)
        .catch(() => undefined);
      setSaveStatus({ kind: "success", at: Date.now() });
      saveStatusTimer.current = setTimeout(() => setSaveStatus(null), SAVE_FEEDBACK_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save settings";
      // Errors stay until the next save attempt — operator should see
      // these every time.
      setSaveStatus({ kind: "error", message });
    } finally {
      setSaving(false);
    }
  };

  const closeResetModal = () => {
    setShowResetModal(false);
    setResetToken("");
    setResetConfirm("");
    setResetBusy(false);
  };

  const submitLinkedInReset = async () => {
    setResetBusy(true);
    setResetStatus(null);
    try {
      await apiPost(
        "/runner/admin/reset",
        {
          platform: "LINKEDIN",
          confirm: "RESET"
        },
        {
          headers: {
            "x-admin-reset-token": resetToken
          }
        }
      );
      setResetStatus({
        type: "success",
        message: "LinkedIn inbox data cleared. Run a fresh scan to rebuild."
      });
      closeResetModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reset failed";
      setResetStatus({
        type: "error",
        message
      });
      setResetBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="text-sm text-slate-500">Configure scan cadence, SLAs, and runtime behaviour for our local runner.</p>
      </div>

      <Card className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Scan interval (seconds)</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={10}
              max={600}
              value={settings.scanIntervalSeconds}
              onChange={(event) => setSettings({ ...settings, scanIntervalSeconds: Number(event.target.value) })}
              className="w-full"
            />
            <Input
              type="number"
              className="w-28"
              value={settings.scanIntervalSeconds}
              onChange={(event) => setSettings({ ...settings, scanIntervalSeconds: Number(event.target.value) })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Amber threshold (hours)</label>
            <Input
              type="number"
              value={settings.amberHours}
              onChange={(event) => setSettings({ ...settings, amberHours: Number(event.target.value) })}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Red threshold (hours)</label>
            <Input
              type="number"
              value={settings.redHours}
              onChange={(event) => setSettings({ ...settings, redHours: Number(event.target.value) })}
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Enabled platforms</p>
          <div className="flex flex-wrap gap-2">
            {platforms.map((platform) => {
              const active = settings.enabledPlatforms.includes(platform);
              return (
                <Button
                  key={platform}
                  variant={active ? "primary" : "secondary"}
                  onClick={() => {
                    const enabledPlatforms = active
                      ? settings.enabledPlatforms.filter((item) => item !== platform)
                      : [...settings.enabledPlatforms, platform];
                    setSettings({ ...settings, enabledPlatforms });
                  }}
                >
                  {platform}
                </Button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">AI provider</p>
          <div className="flex flex-wrap gap-2">
            {aiProviders.map((provider) => {
              const active = (settings.aiProvider ?? "openai") === provider;
              const configured = aiStatus?.configuredProviders.includes(provider) ?? true;
              return (
                <Button
                  key={provider}
                  variant={active ? "primary" : "secondary"}
                  onClick={() => setSettings({ ...settings, aiProvider: provider })}
                  title={configured ? undefined : `${aiProviderLabels[provider]} has no API key configured. Set ${provider === "glm" ? "Z_AI_API_KEY" : "OPENAI_API_KEY"} in .env and restart the runner.`}
                >
                  {aiProviderLabels[provider]}
                  {configured ? null : " ⚠"}
                </Button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Active provider for summaries, suggested replies, and the outreach/genuine classifier. The runner default is seeded by AI_PROVIDER in .env; this overrides it without a restart.
          </p>
          {/* Loud warning when the active provider has no key. Without
              this the operator just sees canned default replies coming
              back forever and has no clue why — a silent fallback in
              modelJson is the failure mode. */}
          {aiStatus && !aiStatus.activeProviderConfigured ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <p className="font-medium">
                  {aiProviderLabels[aiStatus.activeProvider]} is selected but has no API key configured.
                </p>
                <p className="mt-1 text-amber-900/80">
                  Every AI call will fall back to the canned default reply until you set{" "}
                  <code>{aiStatus.activeProvider === "glm" ? "Z_AI_API_KEY" : "OPENAI_API_KEY"}</code>{" "}
                  in <code>.env</code> and click <strong>Restart runner</strong> in the topbar.
                </p>
              </div>
            </div>
          ) : null}
          {(settings.aiProvider ?? "openai") === "glm" ? (
            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium">GLM model (optional)</label>
              <Input
                type="text"
                placeholder="glm-4.7-flash"
                value={settings.glmModel ?? ""}
                onChange={(event) => setSettings({ ...settings, glmModel: event.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500">
                Leave blank to use the Z_AI_MODEL env default. Free-tier flash variants: glm-4.7-flash, glm-4.5-flash.
              </p>
            </div>
          ) : null}
        </div>

        <details className="group rounded-lg border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 marker:text-slate-400">
            Advanced
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">Max messages per thread</label>
                <Input
                  type="number"
                  value={settings.maxMessagesPerThread}
                  onChange={(event) => setSettings({ ...settings, maxMessagesPerThread: Number(event.target.value) })}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Recent thread sweep count</label>
                <Input
                  type="number"
                  value={settings.recentThreadSweepCount}
                  onChange={(event) => setSettings({ ...settings, recentThreadSweepCount: Number(event.target.value) })}
                />
              </div>
            </div>
            <Button
              variant={settings.demoMode ? "primary" : "secondary"}
              onClick={() => setSettings({ ...settings, demoMode: !settings.demoMode })}
            >
              Demo mode: {settings.demoMode ? "On" : "Off"}
            </Button>
          </div>
        </details>

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={saving}
            onClick={() =>
              void save({
                scanIntervalSeconds: settings.scanIntervalSeconds,
                amberHours: settings.amberHours,
                redHours: settings.redHours,
                headless: settings.headless,
                maxMessagesPerThread: settings.maxMessagesPerThread,
                enabledPlatforms: settings.enabledPlatforms,
                demoMode: settings.demoMode,
                recentThreadSweepCount: settings.recentThreadSweepCount,
                aiProvider: settings.aiProvider,
                // Send empty string as undefined so the runner falls back to
                // the env default rather than persisting "" as a model id.
                glmModel: settings.glmModel?.trim() ? settings.glmModel.trim() : undefined
              })
            }
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save settings"
            )}
          </Button>
          {/* Inline status — success fades after SAVE_FEEDBACK_MS, errors
              stick until the next save attempt so the operator notices. */}
          {saveStatus?.kind === "success" ? (
            <span
              role="status"
              aria-live="polite"
              className="flex items-center gap-1 text-sm text-emerald-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              Saved
            </span>
          ) : null}
          {saveStatus?.kind === "error" ? (
            <span
              role="alert"
              aria-live="polite"
              className="flex items-center gap-1 text-sm text-rose-700"
            >
              <AlertCircle className="h-4 w-4" />
              {saveStatus.message}
            </span>
          ) : null}
        </div>
      </Card>

      <Card className="space-y-3 border-rose-200 bg-rose-50">
        <div>
          <h3 className="text-lg font-semibold text-rose-900">Danger zone</h3>
          <p className="mt-1 text-sm text-rose-800/80">
            Per-platform session resets live on the Platforms page. This wipes LinkedIn data locally.
          </p>
        </div>
        {resetStatus ? (
          <div
            className={
              resetStatus.type === "success"
                ? "rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                : "rounded-lg border border-rose-300 bg-rose-100 px-3 py-2 text-sm text-rose-900"
            }
          >
            {resetStatus.message}
          </div>
        ) : null}
        <Button
          variant="danger"
          onClick={() => {
            setShowResetModal(true);
            setResetStatus(null);
          }}
        >
          Clear LinkedIn inbox and rebuild
        </Button>
      </Card>

      {showResetModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4">
          <Card className="w-full max-w-lg space-y-4 border-rose-300">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Confirm LinkedIn reset</h3>
              <p className="mt-1 text-sm text-slate-600">
                This will remove LinkedIn threads/messages in the local DB. Type <code>RESET</code> and enter your admin token.
              </p>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Admin reset token</label>
              <Input
                type="password"
                value={resetToken}
                onChange={(event) => setResetToken(event.target.value)}
                placeholder="Enter ADMIN_RESET_TOKEN"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Type RESET to confirm</label>
              <Input
                value={resetConfirm}
                onChange={(event) => setResetConfirm(event.target.value)}
                placeholder="RESET"
                autoComplete="off"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={closeResetModal}
                disabled={resetBusy}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={resetBusy || resetConfirm !== "RESET" || resetToken.trim().length === 0}
                onClick={() => {
                  void submitLinkedInReset();
                }}
              >
                {resetBusy ? "Resetting..." : "Confirm reset"}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
