"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import { apiGet, apiPost } from "@/lib/api";
import type { AppSettings, HealthResponse, OperatorProfile } from "@/lib/types";
import type { AiProvider } from "@inbox-os/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Canvas, PageHead } from "@/components/common/canvas";
import { cn } from "@/lib/utils";

interface AiStatus {
  activeProvider: AiProvider;
  activeModel: string;
  configuredProviders: AiProvider[];
  activeProviderConfigured: boolean;
}

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

const PROVIDER_MODEL_FIELD: Record<AiProvider, "glmModel" | "geminiModel" | null> = {
  openai: null,
  glm: null,
  gemini: null
};

const PROVIDER_MODEL_PLACEHOLDER: Record<AiProvider, string> = {
  openai: "",
  glm: "glm-4.7-flash",
  gemini: "gemma-4-31b-it"
};

const PROVIDER_MODEL_HINT: Record<AiProvider, string> = {
  openai: "",
  glm: "Leave blank to use the Z_AI_MODEL env default.",
  gemini: "Leave blank to use the GEMINI_MODEL env default."
};

const AUTO_SCAN_KEY = "linkedin_dashboard_autoscan_enabled";
const QUIET_HOURS_KEY = "inbox_quiet_hours";

const PLATFORMS = ["LINKEDIN"] as const;
type Platform = (typeof PLATFORMS)[number];

// Settings - grouped by intent (Capture / Privacy / AI & output / Danger).
// Real toggles instead of "On" pill-buttons. Danger zone is visually
// quarantined at the bottom. Section 09 of the redesign doc.
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

  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>({ about: "", interests: "" });
  const [operatorProfileStatus, setOperatorProfileStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const operatorProfileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        <PageHead eyebrow="Preferences" title="Settings" />
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      </Canvas>
    );
  }

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

      {error ? (
        <p className="mb-4 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

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
        <SettingRow
          name="Headless browser"
          desc="Run scans invisibly in the background. Disable to watch the runner work in a visible window."
          trailing={
            <Toggle
              on={settings.headless}
              disabled={saving}
              onChange={toggleHeadless}
              label="Headless browser"
            />
          }
        />
        <SettingRow
          name="Demo data"
          desc="Seed sample threads and receipts. Useful when running offline."
          trailing={
            <Toggle
              on={settings.demoMode}
              disabled={saving}
              onChange={toggleDemo}
              label="Demo data"
            />
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
        <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 hover:text-ink">
          AI &amp; output · advanced
        </summary>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              return (
                <Button
                  key={provider}
                  variant={active ? "primary" : "quiet"}
                  onClick={() => setSettings({ ...settings, aiProvider: provider })}
                >
                  {PROVIDER_LABELS[provider]}
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
          {(() => {
            const activeProvider: AiProvider = settings.aiProvider ?? "openai";
            const field = PROVIDER_MODEL_FIELD[activeProvider];
            if (!field) return null;
            return (
              <div className="mt-3">
                <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                  {PROVIDER_LABELS[activeProvider]} model
                </p>
                <Input
                  type="text"
                  placeholder={PROVIDER_MODEL_PLACEHOLDER[activeProvider]}
                  value={settings[field] ?? ""}
                  onChange={(event) => setSettings({ ...settings, [field]: event.target.value })}
                />
                <p className="mt-1 font-mono text-[11px] text-ink-3">
                  {PROVIDER_MODEL_HINT[activeProvider]}
                </p>
              </div>
            );
          })()}
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
                aiProvider: settings.aiProvider,
                glmModel: settings.glmModel?.trim() ? settings.glmModel.trim() : undefined,
                geminiModel: settings.geminiModel?.trim() ? settings.geminiModel.trim() : undefined
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

      <section className="mt-12">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-risk-overdue">
          Danger zone
        </p>
        <DangerRow
          name="Wipe LinkedIn inbox and rebuild"
          desc="Wipes LinkedIn threads and messages locally. Next scan rebuilds. Cannot be undone."
          action={
            <DangerButton
              onClick={() => {
                setResetStatus(null);
                setResetPlatform("LINKEDIN");
                setResetOpen(true);
              }}
            >
              Wipe
            </DangerButton>
          }
        />
        <DangerRow
          name="Wipe iMessage inbox and rebuild"
          desc="Wipes iMessage threads and messages locally. Next scan rebuilds. Cannot be undone."
          action={
            <DangerButton
              onClick={() => {
                setResetStatus(null);
                setResetPlatform("IMESSAGE");
                setResetOpen(true);
              }}
            >
              Wipe
            </DangerButton>
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
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-risk-overdue">
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

function DangerRow({
  name,
  desc,
  action
}: {
  name: string;
  desc: string;
  action: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-6 border-t border-hairline px-1 py-[16px] last:border-b last:border-hairline">
      <div>
        <p className="m-0 mb-[4px] text-[14.5px] font-medium text-ink">{name}</p>
        <p className="m-0 max-w-[54ch] text-[12.5px] leading-[1.5] text-ink-3" style={{ textWrap: "pretty" }}>
          {desc}
        </p>
      </div>
      <div>{action}</div>
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

function DangerButton({
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
      className="rounded-pill border border-[color-mix(in_oklch,var(--risk-overdue)_40%,var(--hairline))] bg-transparent px-[14px] py-[7px] font-mono text-[12px] text-risk-overdue transition-colors duration-calm hover:bg-[color-mix(in_oklch,var(--risk-overdue)_8%,var(--paper))]"
    >
      {children}
    </button>
  );
}
