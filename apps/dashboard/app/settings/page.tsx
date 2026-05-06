"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const platforms = ["LINKEDIN", "INSTAGRAM", "TIKTOK"] as const;

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetToken, setResetToken] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetStatus, setResetStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    void apiGet<AppSettings>("/runner/data/settings").then(setSettings);
  }, []);

  if (!settings) {
    return <Card>Loading settings...</Card>;
  }

  const save = async (partial: Partial<AppSettings>) => {
    setSaving(true);
    const next = await apiPost<AppSettings>("/runner/control/settings", partial);
    setSettings(next);
    setSaving(false);
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
              recentThreadSweepCount: settings.recentThreadSweepCount
            })
          }
        >
          Save settings
        </Button>
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
