"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGetRaw, apiPost } from "@/lib/api";

// Calm "App updates" card for the Settings > Pilot area. The runner starts a
// detached updater so pilots do not need a terminal or a manual restart.

interface UpdateCheck {
  configured: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes: string[];
  error?: string;
}

interface StageResponse {
  ok: boolean;
  updating?: boolean;
  fromVersion?: string;
  toVersion?: string;
  reason?: string;
  message?: string;
}

export function AppUpdates() {
  const [info, setInfo] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState("");
  const [updating, setUpdating] = useState(false);
  const [started, setStarted] = useState<{ from: string; to: string; message?: string } | null>(null);
  const [error, setError] = useState("");

  const check = useCallback(async (manual: boolean) => {
    setChecking(true);
    setError("");
    if (manual) setCheckMsg("Checking…");
    try {
      const res = await apiGetRaw<UpdateCheck>("/runner/system/update-check");
      setInfo(res);
      if (manual) {
        setCheckMsg(
          res.updateAvailable
            ? ""
            : res.configured
              ? "You’re up to date."
              : "Updates aren’t set up yet."
        );
      }
    } catch {
      setError("Couldn’t check for updates. Is the app running?");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check(false);
  }, [check]);

  const prepareUpdate = useCallback(async () => {
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
        setError("Couldn’t start the update. Try Check for updates again.");
      }
    } catch {
      setError("Couldn’t start the update. Is the app running?");
    } finally {
      setUpdating(false);
    }
  }, [info]);

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
          {info?.updateAvailable && !started ? (
            <button
              type="button"
              onClick={() => void prepareUpdate()}
              disabled={updating}
              className="inline-flex items-center rounded-pill border border-hairline-strong px-[14px] py-[8px] text-[12.5px] font-medium text-accent-ink transition-colors duration-calm hover:bg-paper disabled:opacity-60"
            >
              {updating ? "Updating app…" : "Update app"}
            </button>
          ) : null}
        </div>
      </div>

      {info?.updateAvailable && info.releaseNotes.length ? (
        <ul className="mt-3 list-disc pl-5 text-[12px] text-ink-2">
          {info.releaseNotes.slice(0, 4).map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}

      {started ? (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-2" aria-live="polite">
          {started.message ?? "Update started."} v{started.from} to v{started.to}. This
          page may disconnect for a moment while Relationship Inbox OS reopens.
          Your messages and settings are kept.
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 text-[12px] text-risk-overdue" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
