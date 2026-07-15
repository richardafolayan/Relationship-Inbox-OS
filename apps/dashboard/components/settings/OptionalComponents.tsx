"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Download, Trash2 } from "lucide-react";
import { apiGetRaw, apiPost } from "@/lib/api";
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

export function OptionalComponents() {
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

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (transcription?.phase !== "downloading") return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [transcription?.phase, refresh]);

  const setMode = async (mode: Mode, removeDownloadedModels = false) => {
    setBusy(removeDownloadedModels ? "remove" : mode);
    setNotice("");
    try {
      const result = await apiPost<TranscriptionStatus>("/runner/control/setup/transcription", { mode, removeDownloadedModels });
      setTranscription(result);
      setNotice(mode === "off" ? removeDownloadedModels ? "The local model was removed." : "Voice transcription is off." : "The model download has started.");
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
    { mode: "standard", label: "Standard", size: "About 150 MB", body: "Good everyday English transcription." },
    { mode: "enhanced", label: "Enhanced", size: "About 500 MB", body: "A larger local model for better accuracy." }
  ];

  return (
    <section className="mb-7 rounded-[10px] border border-hairline bg-paper p-4 sm:p-5">
      <div>
        <p className="m-0 text-[15.5px] font-medium text-ink">Optional components</p>
        <p className="m-0 mt-1 text-[13px] leading-5 text-ink-3">Turn features on or off and remove local downloads whenever you like.</p>
      </div>

      <div className="mt-5 border-t border-hairline pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="m-0 text-[13.5px] font-medium text-ink">AI help</p><p className="m-0 mt-0.5 text-[12px] text-ink-3">Cloud based. Turning it off improves privacy, but does not free much disk space.</p></div>
          <button type="button" disabled={busy === "ai"} onClick={() => void setAiEnabled(!(ai?.enabled ?? false))} className={cn("rounded-pill px-3 py-2 text-[12px] font-medium", ai?.enabled ? "bg-ink text-paper" : "border border-hairline text-ink-2")}>{busy === "ai" ? "Saving..." : ai?.enabled ? "On" : "Off"}</button>
        </div>
        {ai?.enabled && ai.configuredProviders.length === 0 ? <p className="mt-2 text-[12px] text-ink-3">AI is on, but it still needs a key. Run the setup assistant above to add one.</p> : null}
      </div>

      <div className="mt-4 border-t border-hairline pt-4">
        <p className="m-0 text-[13.5px] font-medium text-ink">Voice transcription</p>
        <div className="mt-3 grid gap-2 lg:grid-cols-3">{options.map((option) => {
          const selected = transcription?.mode === option.mode;
          return <button key={option.mode} type="button" disabled={busy !== null || transcription?.phase === "downloading"} onClick={() => void setMode(option.mode)} className={cn("rounded-[8px] border p-3 text-left disabled:opacity-55", selected ? "border-accent bg-accent/5" : "border-hairline bg-paper-2/35")}><span className="flex items-center justify-between gap-2 text-[13px] font-medium text-ink"><span className="flex items-center gap-1.5">{selected ? <Check className="h-3.5 w-3.5 text-accent" /> : null}{option.label}</span><span className="font-mono text-[10px] text-ink-3">{option.size}</span></span><span className="mt-1 block text-[11.5px] leading-4 text-ink-3">{option.body}</span></button>;
        })}</div>
        {transcription?.phase === "downloading" ? <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-2"><Download className="h-3.5 w-3.5" />Downloading the selected model. It turns on when ready.</p> : null}
        {transcription?.installedMode !== "off" && transcription?.mode === "off" ? <button type="button" disabled={busy !== null} onClick={() => void setMode("off", true)} className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-ink-2 underline underline-offset-2"><Trash2 className="h-3.5 w-3.5" />Remove downloaded model</button> : null}
      </div>
      {notice ? <p className="m-0 mt-4 rounded-[7px] bg-paper-2 px-3 py-2 text-[12px] text-ink-2" aria-live="polite">{notice}</p> : null}
    </section>
  );
}
