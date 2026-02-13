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

        <div className="flex flex-wrap gap-2">
          <Button variant={settings.headless ? "primary" : "secondary"} onClick={() => setSettings({ ...settings, headless: !settings.headless })}>
            Headless: {settings.headless ? "On" : "Off"}
          </Button>
          <Button variant={settings.demoMode ? "primary" : "secondary"} onClick={() => setSettings({ ...settings, demoMode: !settings.demoMode })}>
            Demo Mode: {settings.demoMode ? "On" : "Off"}
          </Button>
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
        <h3 className="text-lg font-semibold text-rose-900">Danger zone</h3>
        <div className="flex flex-wrap gap-2">
          {platforms.map((platform) => (
            <Button
              key={platform}
              variant="danger"
              onClick={() => {
                if (!confirm(`Reset ${platform} session?`)) {
                  return;
                }
                void apiPost("/runner/control/platform/reset-session", { platform });
              }}
            >
              Reset {platform} session
            </Button>
          ))}
        </div>
        <Button
          variant="danger"
          onClick={() => {
            if (!confirm("Clear the local database? This cannot be undone.")) {
              return;
            }
            void apiPost("/runner/control/system/clear-db", {});
          }}
        >
          Clear DB
        </Button>
      </Card>
    </div>
  );
}
