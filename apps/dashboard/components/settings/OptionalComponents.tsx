"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Download, Trash2 } from "lucide-react";
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
  hostPlatform = null,
  remoteAvailable = true,
  offlineExplanation
}: {
  phoneLayout?: boolean;
  hostPlatform?: HostPlatformId | null;
  remoteAvailable?: boolean;
  offlineExplanation?: string;
} = {}) {
  const [transcription, setTranscription] = useState<TranscriptionStatus | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const remoteBlocked = !remoteAvailable;

  const refresh = useCallback(async () => {
    const [nextTranscription, nextAi] = await Promise.all([
      apiGetRaw<TranscriptionStatus>("/runner/data/setup/transcription").catch(() => null),
      apiGetRaw<AiStatus>("/runner/data/ai-status").catch(() => null)
    ]);
    if (nextTranscription) setTranscription(nextTranscription);
    if (nextAi) setAi(nextAi);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (transcription?.phase !== "downloading") return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [transcription?.phase, refresh]);

  const setMode = async (mode: Mode, removeDownloadedModels = false) => {
    if (remoteBlocked) {
      setNotice(offlineExplanation || "Unavailable while your Mac is offline.");
      return;
    }
    setBusy(removeDownloadedModels ? "remove" : mode);
    setNotice("");
    try {
      const result = await apiPost<TranscriptionStatus>("/runner/control/setup/transcription", { mode, removeDownloadedModels });
      setTranscription(result);
      setNotice(
        mode === "off"
          ? removeDownloadedModels
            ? "The local model was removed."
            : "Voice transcription is off."
          : phoneLayout
            ? "The model download has started on your Mac."
            : "The model download has started."
      );
    } catch {
      setNotice("That change did not finish. Check the app is running and try again.");
    } finally {
      setBusy(null);
    }
  };

  const setAiEnabled = async (enabled: boolean) => {
    if (remoteBlocked) {
      setNotice(offlineExplanation || "Unavailable while your Mac is offline.");
      return;
    }
    setBusy("ai");
    setNotice("");
    try {
      await apiPost("/runner/control/setup/preferences", { aiEnabled: enabled });
      setAi((current) => current ? { ...current, enabled } : { enabled, configuredProviders: [] });
      setNotice(enabled ? "AI help is on." : "AI help is off. Conversation text will not be sent to an AI service.");
    } catch {
      setNotice("That change did not finish. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const options: Array<{ mode: Mode; label: string; size: string; body: string }> = [
    { mode: "off", label: "Off", size: "No download", body: "Play voice notes without transcribing them." },
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

      {phoneLayout && remoteBlocked && offlineExplanation ? (
        <p className="m-0 mt-3 rounded-[7px] border border-hairline bg-paper-2 px-3 py-2 text-[12px] text-ink-2">
          {offlineExplanation}
        </p>
      ) : null}

      <div className="mt-5 border-t border-hairline pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[13.5px] font-medium text-ink">AI help</p>
            <p className="m-0 mt-0.5 text-[12px] text-ink-3">
              Cloud based. Turning it off improves privacy, but does not free much disk space.
            </p>
          </div>
          <button
            type="button"
            disabled={busy === "ai" || remoteBlocked}
            onClick={() => void setAiEnabled(!(ai?.enabled ?? false))}
            className={cn(
              "rounded-pill px-3 py-2 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-50",
              ai?.enabled ? "bg-ink text-paper" : "border border-hairline text-ink-2"
            )}
          >
            {busy === "ai" ? "Saving..." : ai?.enabled ? "On" : "Off"}
          </button>
        </div>
        {ai?.enabled && ai.configuredProviders.length === 0 ? (
          <p className="mt-2 text-[12px] text-ink-3">
            AI is on, but it still needs a key. Run the setup assistant above to add one.
          </p>
        ) : null}
      </div>

      <div className="mt-4 border-t border-hairline pt-4">
        <p className="m-0 text-[13.5px] font-medium text-ink">Voice transcription</p>
        {phoneLayout ? (
          <p className="m-0 mt-0.5 text-[12px] text-ink-3">
            Models install on your Mac. Download size uses Mac storage, not phone storage.
          </p>
        ) : null}
        <div className="mt-3 grid gap-2 lg:grid-cols-3">
          {options.map((option) => {
            const selected = transcription?.mode === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                disabled={busy !== null || transcription?.phase === "downloading" || remoteBlocked}
                onClick={() => void setMode(option.mode)}
                className={cn(
                  "rounded-[8px] border p-3 text-left disabled:cursor-not-allowed disabled:opacity-55",
                  selected ? "border-accent bg-accent/5" : "border-hairline bg-paper-2/35"
                )}
              >
                <span className="flex items-center justify-between gap-2 text-[13px] font-medium text-ink">
                  <span className="flex items-center gap-1.5">
                    {selected ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
                    {option.label}
                  </span>
                  <span className="max-w-[55%] text-right font-mono text-[10px] leading-[1.3] text-ink-3">
                    {option.size}
                  </span>
                </span>
                <span className="mt-1 block text-[11.5px] leading-4 text-ink-3">{option.body}</span>
              </button>
            );
          })}
        </div>
        {transcription?.phase === "downloading" ? (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-2">
            <Download className="h-3.5 w-3.5" />
            {phoneLayout
              ? "Downloading the selected model on your Mac. It turns on when ready."
              : "Downloading the selected model. It turns on when ready."}
          </p>
        ) : null}
        {transcription?.installedMode !== "off" && transcription?.mode === "off" ? (
          <button
            type="button"
            disabled={busy !== null || remoteBlocked}
            onClick={() => void setMode("off", true)}
            className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-ink-2 underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove downloaded model
          </button>
        ) : null}
      </div>
      {notice ? (
        <p className="m-0 mt-4 rounded-[7px] bg-paper-2 px-3 py-2 text-[12px] text-ink-2" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
