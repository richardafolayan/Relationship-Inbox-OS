"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import type { AppSettings, HealthResponse, OperatorProfile } from "@/lib/types";
import type { AiProvider } from "@inbox-os/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Canvas, PageHead, QuietRow } from "@/components/common/canvas";

interface AiStatus {
  activeProvider: AiProvider;
  activeModel: string;
  configuredProviders: AiProvider[];
  activeProviderConfigured: boolean;
}

// Explicit ordering for the provider toggle. Don't iterate Object.keys on
// the records below - TS doesn't guarantee insertion order at the type
// level even when V8 does at runtime. Adding a new provider goes here
// alongside the matching entries in the records.
const AI_PROVIDERS: AiProvider[] = ["openai", "glm", "gemini"];

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "ChatGPT",
  glm: "GLM",
  gemini: "Gemini"
};

const PROVIDER_KEY_ENV: Record<AiProvider, string> = {
  openai: "OPENAI_API_KEY",
  glm: "Z_AI_API_KEY",
  gemini: "GEMINI_API_KEY"
};

// Which `AppSettings` field a model-override input writes to for each
// provider. `null` means the provider has no per-account model override
// - the runner uses the env-default model instead. All three providers
// are now `null`: operators flagged the per-provider model UI as
// confusing (Gemini and GLM had inputs but ChatGPT didn't, asymmetric).
// To change a provider's model, set the corresponding env var
// (OPENAI_MODEL / Z_AI_MODEL / GEMINI_MODEL) and restart. Existing
// saved values on `glmModel` / `geminiModel` columns are preserved on
// save (the UI just doesn't expose editing them) so we don't quietly
// blow away any operator's prior override.
// (Previously: per-provider model lookup tables drove a settings input
// the operator flagged as confusing. The tables now all resolve to null
// so the input never rendered, but the dead lookup + IIFE + save-body
// passthroughs were still walked on every render. Removed entirely —
// operators now change a provider's model via env vars and a restart.)

const AUTO_SCAN_KEY = "linkedin_dashboard_autoscan_enabled";
const QUIET_HOURS_KEY = "inbox_quiet_hours";

// Settings - leading with the four primary toggles in the calm row
// pattern (Quiet hours, Auto-scan, Headless browser, Demo data). The
// advanced surface (scan thresholds, AI provider, danger-zone reset,
// runner restart) sits behind a quiet expander so it stays out of the
// way until the operator asks for it.
//
// Only LinkedIn is shipped today. Instagram/TikTok still flow through
// the runner so their settings can persist, but we don't render toggles
// for them on this page until the adapter work lands (issue #93).
const PLATFORMS = ["LINKEDIN"] as const;
type Platform = (typeof PLATFORMS)[number];

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

  // Operator self-description. Two free-text fields the AI prompts read
  // (apps/runner/src/services/ai.ts → operatorProfileFragment) so suggested
  // replies and voice rewrites stay in the operator's domain. Saved with
  // the same debounce-then-PATCH pattern Notes uses on the People page.
  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>({ about: "", interests: "" });
  const [operatorProfileStatus, setOperatorProfileStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const operatorProfileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Danger-zone reset modal state. Mirrors the main-branch flow: an
  // admin token + literal "RESET" string, both required before the
  // confirm button enables. `resetPlatform` switches the same modal
  // between LinkedIn and iMessage targets so we don't duplicate the
  // dialog markup per platform.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPlatform, setResetPlatform] = useState<"LINKEDIN" | "IMESSAGE">("LINKEDIN");
  const [resetToken, setResetToken] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetStatus, setResetStatus] = useState<
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  const refreshAll = useCallback(async () => {
    const [settingsData, aiData, operatorData] = await Promise.all([
      apiGet<AppSettings>("/runner/data/settings").catch(() => null),
      apiGet<AiStatus>("/runner/data/ai-status").catch(() => null),
      apiGet<OperatorProfile>("/runner/data/operator-profile").catch(() => null)
    ]);
    if (settingsData) setSettings(settingsData);
    setAiStatus(aiData);
    if (operatorData) setOperatorProfile(operatorData);
  }, []);

  // Tear down the debounce timer if the page unmounts mid-save.
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

  const togglePlatform = (platform: Platform) => {
    if (!settings) return;
    const enabled = settings.enabledPlatforms.includes(platform);
    const enabledPlatforms = enabled
      ? settings.enabledPlatforms.filter((item) => item !== platform)
      : [...settings.enabledPlatforms, platform];
    setSettings({ ...settings, enabledPlatforms });
  };

  const closeResetModal = () => {
    if (resetBusy) return;
    setResetOpen(false);
    setResetToken("");
    setResetConfirm("");
  };

  const submitReset = async () => {
    setResetBusy(true);
    setResetStatus(null);
    try {
      const result = await apiPost<unknown>(
        "/runner/admin/reset",
        { platform: resetPlatform, confirm: "RESET" },
        { headers: { "x-admin-reset-token": resetToken } }
      );
      setResetStatus({
        kind: "success",
        message: `${resetPlatform === "LINKEDIN" ? "LinkedIn" : "iMessage"} inbox cleared. ${JSON.stringify(result)}`
      });
      setResetOpen(false);
      setResetToken("");
      setResetConfirm("");
    } catch (err) {
      setResetStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Reset failed"
      });
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
        <PageHead
          eyebrow="Preferences"
          title="Settings"
          subtitle="Configure scan cadence, SLAs, and runtime behaviour for the local runner."
        />
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      </Canvas>
    );
  }

  return (
    <Canvas>
      <PageHead
        eyebrow="Preferences"
        title="Settings"
        subtitle="Configure scan cadence, SLAs, and runtime behaviour for the local runner."
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
            {AI_PROVIDERS.map((provider) => {
              const active = (settings.aiProvider ?? "openai") === provider;
              const configured = aiStatus?.configuredProviders.includes(provider) ?? true;
              return (
                <Button
                  key={provider}
                  variant={active ? "primary" : "quiet"}
                  onClick={() => setSettings({ ...settings, aiProvider: provider })}
                >
                  {PROVIDER_LABELS[provider]}
                  {configured ? null : " ·"}
                </Button>
              );
            })}
          </div>
          {aiStatus && !aiStatus.activeProviderConfigured ? (
            <p className="mt-3 font-mono text-[11px] text-risk-overdue">
              {PROVIDER_LABELS[aiStatus.activeProvider]} is selected but no API key is
              configured. Set <code>{PROVIDER_KEY_ENV[aiStatus.activeProvider]}</code> in{" "}
              <code>.env</code> and restart the runner.
            </p>
          ) : null}
        </div>

        <div className="mt-6">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
            Enabled platforms
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {PLATFORMS.map((platform) => {
              const active = settings.enabledPlatforms.includes(platform);
              return (
                <Button
                  key={platform}
                  variant={active ? "primary" : "quiet"}
                  onClick={() => togglePlatform(platform)}
                >
                  {platform}
                </Button>
              );
            })}
          </div>
          <p className="mt-2 font-mono text-[11px] text-ink-3">
            Saved with the rest of advanced settings. Instagram and TikTok are coming later.
          </p>
          {/* Per-provider model override was removed (PROVIDER_MODEL_FIELD
              entries all resolved to null). To change a provider's model,
              set OPENAI_MODEL / Z_AI_MODEL / GEMINI_MODEL in .env and restart
              via the button below. */}
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
                enabledPlatforms: settings.enabledPlatforms,
                aiProvider: settings.aiProvider
                // glmModel / geminiModel are no longer editable from the UI
                // (see the comment above next to PROVIDER_MODEL_FIELD's
                // removal). The runner echoes whatever was last saved, so
                // omitting them here preserves the existing value without
                // entrenching whatever the dead UI happened to have on
                // first save.
              })
            }
          >
            Save settings
          </Button>
          <Button variant="quiet" onClick={() => void restartRunner()}>
            Restart runner
          </Button>
        </div>

      </details>

      <section className="mt-12 border-t border-hairline pt-6">
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.08em] text-[oklch(45%_0.18_28)]">
          Danger zone
        </p>
        <QuietRow
          name="Clear LinkedIn inbox and rebuild"
          stat="wipes LinkedIn threads/messages locally - next scan rebuilds"
          action={
            <Button
              variant="danger"
              onClick={() => {
                setResetStatus(null);
                setResetPlatform("LINKEDIN");
                setResetOpen(true);
              }}
            >
              Reset…
            </Button>
          }
        />
        <QuietRow
          name="Clear iMessage inbox and rebuild"
          stat="wipes iMessage threads/messages locally - next scan rebuilds"
          action={
            <Button
              variant="danger"
              onClick={() => {
                setResetStatus(null);
                setResetPlatform("IMESSAGE");
                setResetOpen(true);
              }}
            >
              Reset…
            </Button>
          }
        />
        {resetStatus ? (
          <p
            className={
              resetStatus.kind === "success"
                ? "mt-3 font-mono text-[11px] text-ink-2"
                : "mt-3 font-mono text-[11px] text-risk-overdue"
            }
          >
            {resetStatus.message}
          </p>
        ) : null}
      </section>

      {resetOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4"
          role="dialog"
          aria-modal="true"
          onClick={closeResetModal}
        >
          <div
            className="w-full max-w-lg space-y-4 rounded-xl border border-hairline bg-paper p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-[oklch(45%_0.18_28)]">
                Danger zone
              </p>
              <p className="mt-2 font-display text-[18px] font-medium tracking-[-0.012em] text-ink">
                Confirm {resetPlatform === "LINKEDIN" ? "LinkedIn" : "iMessage"} reset
              </p>
              <p className="mt-2 font-mono text-[12px] text-ink-3">
                This removes {resetPlatform === "LINKEDIN" ? "LinkedIn" : "iMessage"} threads and messages from the local DB. Type{" "}
                <code className="text-ink">RESET</code> and provide the admin token to proceed.
              </p>
            </div>

            <label className="block">
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                Admin reset token
              </span>
              <Input
                type="password"
                className="mt-2"
                value={resetToken}
                onChange={(event) => setResetToken(event.target.value)}
                placeholder="ADMIN_RESET_TOKEN"
                autoComplete="off"
              />
            </label>

            <label className="block">
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                Type RESET to confirm
              </span>
              <Input
                className="mt-2"
                value={resetConfirm}
                onChange={(event) => setResetConfirm(event.target.value)}
                placeholder="RESET"
                autoComplete="off"
              />
            </label>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="quiet" onClick={closeResetModal} disabled={resetBusy}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={
                  resetBusy || resetConfirm !== "RESET" || resetToken.trim().length === 0
                }
                onClick={() => void submitReset()}
              >
                {resetBusy ? "Resetting…" : "Confirm reset"}
              </Button>
            </div>

            {resetStatus?.kind === "error" ? (
              <p className="font-mono text-[11px] text-risk-overdue">{resetStatus.message}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </Canvas>
  );
}
