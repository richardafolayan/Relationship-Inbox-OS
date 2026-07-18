"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { apiGetRaw, apiPost } from "@/lib/api";
import {
  remoteActionLabel,
  voiceModelSizeLabel,
  type HostPlatformId
} from "@/lib/host-device";
import { cn } from "@/lib/utils";

type Mode = "off" | "standard" | "enhanced";

interface TranscriptionStatus {
  mode: Mode;
  phase: "idle" | "downloading" | "error";
  installedMode: Mode;
  downloadedBytes: number;
  error: string | null;
}

interface AiStatus {
  enabled: boolean;
  configuredProviders: string[];
}

export function OptionalComponents({
  phoneLayout = false,
  hostPlatform = "mac",
  remoteAvailable = true,
  offlineExplanation
}: {
  phoneLayout?: boolean;
  hostPlatform?: HostPlatformId;
  remoteAvailable?: boolean;
  offlineExplanation?: string;
} = {}) {
  const [transcription, setTranscription] = useState<TranscriptionStatus | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const [nextTranscription, nextAi] = await Promise.all([
      apiGetRaw<TranscriptionStatus>("/runner/data/setup/transcription").catch(() => null),
      apiGetRaw<AiStatus>("/runner/data/ai-status").catch(() => null)
    ]);
    if (nextTranscription) setTranscription(nextTranscription);
    if (nextAi) setAi(nextAi);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (transcription?.phase !== "downloading") return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [transcription?.phase, refresh]);

  const setMode = async (mode: Mode, removeDownloadedModels = false) => {
    setBusy(removeDownloadedModels ? "remove" : mode);
    setNotice("");
    try {
      const result = await apiPost<TranscriptionStatus>("/runner/control/setup/transcription", {
        mode,
        removeDownloadedModels
      });
      setTranscription(result);
      setNotice(
        mode === "off"
          ? removeDownloadedModels
            ? "The local model was removed."
            : "Voice transcription is off."
          : "The model download has started."
      );
    } catch {
      setNotice("That change did not finish. Check the app is running and try again.");
    } finally {
      setBusy(null);
    }
  };

  const setAiEnabled = async (enabled: boolean) => {
    setBusy("ai");
    setNotice("");
    try {
      await apiPost("/runner/control/setup/preferences", { aiEnabled: enabled });
      setAi((current) =>
        current ? { ...current, enabled } : { enabled, configuredProviders: [] }
      );
      setNotice(
        enabled
          ? "AI help is on."
          : "AI help is off. Conversation text will not be sent to an AI service."
      );
    } catch {
      setNotice("That change did not finish. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const options: Array<{ mode: Mode; label: string; size: string; body: string }> = [
    {
      mode: "off",
      label: "Off",
      size: "No download",
      body: "Play voice notes without transcribing them."
    },
    {
      mode: "standard",
      label: "Standard",
      size: phoneLayout ? voiceModelSizeLabel("About 150 MB", hostPlatform) : "About 150 MB",
      body: "Good everyday English transcription."
    },
    {
      mode: "enhanced",
      label: "Enhanced",
      size: phoneLayout ? voiceModelSizeLabel("About 500 MB", hostPlatform) : "About 500 MB",
      body: "A larger local model for better accuracy."
    }
  ];

  const aiOn = ai?.enabled ?? false;
  const downloading = transcription?.phase === "downloading";
  const modeBusy = busy !== null;
  const remoteBlocked = phoneLayout && !remoteAvailable;

  return (
    <section className="mb-7 rounded-[10px] border border-hairline bg-paper p-4 sm:p-5">
      <div>
        <p className="m-0 text-[15.5px] font-medium text-ink">Optional components</p>
        <p className="m-0 mt-1 text-[13px] leading-5 text-ink-3">
          {phoneLayout
            ? "Turn features on or off. Local models download to your Mac storage."
            : "Turn features on or off and remove local downloads whenever you like."}
        </p>
        {phoneLayout ? (
          <p className="m-0 mt-1 text-[12px] leading-[1.4] text-ink-3">
            {remoteActionLabel("voiceModel", hostPlatform)}
          </p>
        ) : null}
      </div>

      {remoteBlocked && offlineExplanation ? (
        <p className="m-0 mt-3 rounded-[7px] border border-hairline bg-paper-2 px-3 py-2 text-[12px] text-ink-2">
          {offlineExplanation}
        </p>
      ) : null}

      <div className="mt-5 border-t border-hairline pt-4">
        <div className="flex min-h-[44px] items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="m-0 text-[13.5px] font-medium text-ink">AI help</p>
            <p className="m-0 mt-0.5 text-[12px] text-ink-3">
              Cloud based. Turning it off improves privacy, but does not free much disk space.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
              {busy === "ai" ? "Saving..." : aiOn ? "On" : "Off"}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={aiOn}
              aria-label="AI help"
              disabled={busy === "ai" || remoteBlocked}
              onClick={() => void setAiEnabled(!aiOn)}
              className={cn(
                "relative h-[24px] w-[44px] shrink-0 rounded-pill transition-colors duration-calm",
                aiOn ? "bg-accent" : "bg-hairline-strong",
                busy === "ai" || remoteBlocked
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-calm",
                  aiOn ? "translate-x-[22px]" : "translate-x-[3px]"
                )}
              />
            </button>
          </div>
        </div>
        {aiOn && ai?.configuredProviders.length === 0 ? (
          <p className="mt-2 text-[12px] text-ink-3">
            AI is on, but it still needs a key. Run the setup assistant above to add one.
          </p>
        ) : null}
      </div>

      <div className="mt-4 border-t border-hairline pt-4">
        <p className="m-0 text-[13.5px] font-medium text-ink">Voice transcription</p>
        <p className="m-0 mt-0.5 text-[12px] text-ink-3">
          {phoneLayout
            ? "Choose one local model. It installs on your Mac, not your phone."
            : "Choose one local model. Only the selected option is active."}
        </p>
        <div
          role="radiogroup"
          aria-label="Voice transcription"
          className="mt-3 flex flex-col gap-1.5"
        >
          {options.map((option) => {
            const selected = transcription?.mode === option.mode;
            const installed =
              option.mode !== "off" && transcription?.installedMode === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={modeBusy || downloading || remoteBlocked}
                onClick={() => void setMode(option.mode)}
                className={cn(
                  "grid min-h-[48px] grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-3 rounded-[10px] px-3 py-3 text-left transition-colors duration-calm disabled:opacity-55",
                  selected
                    ? "bg-paper-2 ring-1 ring-ink/15"
                    : "bg-transparent hover:bg-paper-2/60"
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[2px] grid h-[18px] w-[18px] place-items-center rounded-full border",
                    selected ? "border-ink" : "border-hairline-strong"
                  )}
                >
                  {selected ? <span className="h-[8px] w-[8px] rounded-full bg-ink" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium text-ink">{option.label}</span>
                  <span className="mt-0.5 block text-[12px] leading-4 text-ink-3">{option.body}</span>
                  {installed && option.mode !== "off" ? (
                    <span className="mt-1 block font-mono text-[10.5px] text-ink-3">
                      Installed on this device
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 pt-[2px] font-mono text-[10.5px] text-ink-3">
                  {option.size}
                </span>
              </button>
            );
          })}
        </div>
        {downloading ? (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-2">
            <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {phoneLayout
              ? "Downloading the selected model on your Mac. It turns on when ready."
              : "Downloading the selected model. It turns on when ready."}
          </p>
        ) : null}
        {transcription?.phase === "error" && transcription.error ? (
          <p className="mt-3 text-[12px] text-ink-2">{transcription.error}</p>
        ) : null}
        {transcription?.installedMode !== "off" && transcription?.mode === "off" ? (
          <button
            type="button"
            disabled={modeBusy || remoteBlocked}
            onClick={() => void setMode("off", true)}
            className="mt-3 inline-flex min-h-[40px] items-center gap-1.5 text-[12px] text-ink-2 underline underline-offset-2"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Remove downloaded model
          </button>
        ) : null}
      </div>
      {notice ? (
        <p
          className="m-0 mt-4 rounded-[7px] bg-paper-2 px-3 py-2 text-[12px] text-ink-2"
          aria-live="polite"
        >
          {notice}
        </p>
      ) : null}
    </section>
  );
}
