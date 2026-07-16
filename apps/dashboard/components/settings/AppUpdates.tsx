"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGetRaw, apiPost } from "@/lib/api";
import { APP_NAME, LEGACY_APP_NAME } from "@/lib/branding";

// Calm "App updates" card for the Settings > Pilot area. The runner starts a
// detached updater so pilots do not need a terminal or a manual restart.

interface UpdateCheck {
  applyMode?: "automatic" | "replace_app";
  automaticUpdates: boolean;
  configured: boolean;
  currentVersion: string;
  currentReleaseNotes: string[];
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes: string[];
  error?: string;
}

interface AppVersion {
  version: string;
  releaseNotes?: string[];
}

interface StageResponse {
  ok: boolean;
  updating?: boolean;
  fromVersion?: string;
  toVersion?: string;
  reason?: string;
  message?: string;
}

interface SettingsResponse {
  automaticUpdates: boolean;
}

export function AppUpdates() {
  const [info, setInfo] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState("");
  const [updating, setUpdating] = useState(false);
  const [runnerStarting, setRunnerStarting] = useState(false);
  const [runnerOffline, setRunnerOffline] = useState(false);
  const [started, setStarted] = useState<{ from: string; to: string; message?: string } | null>(null);
  const [error, setError] = useState("");
  const [installHelp, setInstallHelp] = useState("");
  const [automaticUpdates, setAutomaticUpdates] = useState(true);
  const [savingAutomaticUpdates, setSavingAutomaticUpdates] = useState(false);
  const [automaticUpdatesMsg, setAutomaticUpdatesMsg] = useState("");

  const check = useCallback(async (manual: boolean) => {
    setChecking(true);
    setError("");
    setRunnerOffline(false);
    if (manual) setCheckMsg("Checking…");
    try {
      const res = await apiGetRaw<UpdateCheck>("/runner/system/update-check");
      setInfo({
        ...res,
        currentReleaseNotes: Array.isArray(res.currentReleaseNotes) ? res.currentReleaseNotes : []
      });
      setAutomaticUpdates(res.automaticUpdates);
      if (res.error) {
        setError("Couldn’t check the update feed. Try again in a moment.");
      }
      if (manual) {
        setCheckMsg(
          res.error
            ? ""
            : res.updateAvailable
            ? ""
            : res.configured
              ? "You’re up to date."
              : "Updates aren’t set up yet."
        );
      }
    } catch {
      try {
        const version = await apiGetRaw<AppVersion>("/runner/system/version");
        setInfo({
          configured: false,
          automaticUpdates,
          currentVersion: version.version,
          currentReleaseNotes: version.releaseNotes ?? [],
          latestVersion: version.version,
          updateAvailable: false,
          releaseNotes: []
        });
        setError(`Couldn’t check for updates. Restart ${APP_NAME}, then try again.`);
      } catch {
        setRunnerOffline(true);
        setInfo(null);
        setError("Couldn’t reach the local runner. Use Start runner, then try again.");
      }
    } finally {
      setChecking(false);
    }
  }, [automaticUpdates]);

  useEffect(() => {
    void check(false);
  }, [check]);

  const prepareUpdate = useCallback(async () => {
    if (info?.applyMode === "replace_app") {
      setInstallHelp(
        `Quit ${APP_NAME}, open the latest DMG, drag ${APP_NAME} into Applications and choose Replace, then reopen it. If an app named ${LEGACY_APP_NAME} is still in Applications, remove it. Your messages and settings are kept.`
      );
      return;
    }
    setUpdating(true);
    setError("");
    try {
      const res = await apiPost<StageResponse>("/runner/system/update", {});
      if (res.ok) {
        setStarted({
          from: res.fromVersion ?? info?.currentVersion ?? "",
          to: res.toVersion ?? info?.latestVersion ?? "",
          message: res.message
        });
      } else {
        setError(res.message ?? "Couldn’t start the update. Try Check for updates again.");
      }
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "";
      setError(message || "Couldn’t start the update. Try again in a moment.");
    } finally {
      setUpdating(false);
    }
  }, [info]);

  const startRunner = useCallback(async () => {
    setRunnerStarting(true);
    setError("");
    try {
      const response = await fetch("/api/local-runner/start", { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.reason ?? `Request failed: ${response.status}`);
      }
      setCheckMsg("Runner is starting. Checking again…");
      window.setTimeout(() => void check(true), 2500);
      window.setTimeout(() => void check(true), 6000);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "";
      setError(message || `Couldn’t start the runner. Try reopening ${APP_NAME}.`);
    } finally {
      setRunnerStarting(false);
    }
  }, [check]);

  const toggleAutomaticUpdates = useCallback(async () => {
    const next = !automaticUpdates;
    setSavingAutomaticUpdates(true);
    setAutomaticUpdatesMsg("Saving…");
    setError("");
    try {
      const saved = await apiPost<SettingsResponse>("/runner/control/settings", {
        automaticUpdates: next
      });
      setAutomaticUpdates(saved.automaticUpdates);
      setInfo((current) => current ? { ...current, automaticUpdates: saved.automaticUpdates } : current);
      setAutomaticUpdatesMsg("Saved");
      window.setTimeout(() => setAutomaticUpdatesMsg(""), 1800);
    } catch {
      setAutomaticUpdatesMsg("");
      setError("Couldn’t save automatic update settings. Try again.");
    } finally {
      setSavingAutomaticUpdates(false);
    }
  }, [automaticUpdates]);

  const version = info?.currentVersion ?? "…";

  return (
    <div className="rounded-row border border-hairline bg-paper-2 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-ink">
            App version <span className="font-mono text-ink-2">v{version}</span>
          </p>
          {info?.updateAvailable ? (
            <p className="text-[13px] text-ink">
              Update available{" "}
              <span className="font-mono text-accent-ink">v{info.latestVersion}</span>
            </p>
          ) : checkMsg ? (
            <p className="text-[12px] text-ink-3" aria-live="polite">
              {checkMsg}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void check(true)}
            disabled={checking}
            className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper hover:text-ink disabled:opacity-60"
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
          {runnerOffline ? (
            <button
              type="button"
              onClick={() => void startRunner()}
              disabled={runnerStarting}
              className="inline-flex items-center rounded-pill border border-hairline-strong px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:bg-paper disabled:opacity-60"
            >
              {runnerStarting ? "Starting runner…" : "Start runner"}
            </button>
          ) : null}
          {info?.updateAvailable && !started ? (
            <button
              type="button"
              onClick={() => void prepareUpdate()}
              disabled={updating}
              className="inline-flex items-center rounded-pill border border-hairline-strong px-[14px] py-[8px] text-[12.5px] font-medium text-accent-ink transition-colors duration-calm hover:bg-paper disabled:opacity-60"
            >
              {updating ? "Updating app…" : info.applyMode === "replace_app" ? "Show update steps" : "Update app"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-5 border-t border-hairline pt-4">
        <div>
          <p className="text-[13px] font-medium text-ink">Install updates automatically</p>
          <p className="mt-1 max-w-[58ch] text-[12px] leading-relaxed text-ink-3">
            {APP_NAME} checks shortly after opening and once an hour. When an update is ready,
            it installs it and reopens with your messages and settings kept.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="min-w-[42px] text-right font-mono text-[11px] text-ink-3" aria-live="polite">
            {automaticUpdatesMsg || (automaticUpdates ? "On" : "Off")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={automaticUpdates}
            aria-label="Install updates automatically"
            onClick={() => void toggleAutomaticUpdates()}
            disabled={savingAutomaticUpdates || info?.applyMode === "replace_app"}
            className={`relative h-[20px] w-[36px] shrink-0 rounded-pill transition-colors duration-calm ${
              automaticUpdates ? "bg-accent" : "bg-hairline-strong"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <span
              aria-hidden
              className={`absolute left-0 top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-calm ${
                automaticUpdates ? "translate-x-[18px]" : "translate-x-[2px]"
              }`}
            />
          </button>
        </div>
      </div>

      {info?.currentReleaseNotes.length || (info?.updateAvailable && info.releaseNotes.length) ? (
        <div className="mt-4 grid gap-3 border-t border-hairline pt-4 sm:grid-cols-2">
          {info.currentReleaseNotes.length ? (
            <div>
              <p className="text-[12px] font-medium text-ink">What’s new in v{info.currentVersion}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-2">
                {info.currentReleaseNotes.slice(0, 4).map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {info.updateAvailable && info.releaseNotes.length ? (
            <div>
              <p className="text-[12px] font-medium text-ink">Coming in v{info.latestVersion}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-2">
                {info.releaseNotes.slice(0, 4).map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {started ? (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-2" aria-live="polite">
          {started.message ?? "Update started."} v{started.from} to v{started.to}. This
          page may disconnect for a moment while {APP_NAME} reopens.
          Your messages and settings are kept.
        </p>
      ) : null}

      {installHelp ? (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-2" aria-live="polite">
          {installHelp}
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-row border border-hairline bg-paper px-3 py-2 text-[12px] leading-relaxed text-ink-2" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
