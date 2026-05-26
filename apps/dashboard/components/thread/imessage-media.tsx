"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api";
import type { ThreadMessage } from "@/lib/types";

interface IMessageMediaProps {
  attachment: ThreadMessage["attachments"][number];
}

interface VoiceMessageTranscriptProps {
  messageId: string;
  transcription: ThreadMessage["audioTranscription"];
}

interface TranscribeResponse {
  ok: boolean;
  transcription: NonNullable<ThreadMessage["audioTranscription"]> | null;
}

/**
 * Quiet status line and on-demand action for the voice / audio
 * attachment on this message. Shows the transcript when one exists,
 * a pending hint while OpenAI is running, a failure line when the run
 * was unsuccessful, and a calm "Transcribe voice message" button
 * otherwise. Stays visually secondary (12px, ink-3, no badge) so it
 * never competes with the audio control.
 */
export function VoiceMessageTranscript({ messageId, transcription }: VoiceMessageTranscriptProps) {
  const [local, setLocal] = useState<ThreadMessage["audioTranscription"]>(transcription ?? null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function trigger() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const response = await apiPost<TranscribeResponse>(
        `/runner/control/message/${encodeURIComponent(messageId)}/transcribe`,
        {}
      );
      if (response.transcription) {
        setLocal(response.transcription);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not transcribe right now."
      );
    } finally {
      setRunning(false);
    }
  }

  if (
    local &&
    local.status === "transcribed" &&
    local.transcript &&
    local.transcript.trim().length > 0
  ) {
    return (
      <span className="block whitespace-pre-wrap text-[12px] leading-[1.45] text-ink-3">
        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
          voice message transcript
        </span>
        <span className="ml-[6px]">{local.transcript}</span>
      </span>
    );
  }

  if (local?.status === "pending" || running) {
    return (
      <span className="block text-[12px] italic leading-[1.45] text-ink-3">
        Transcribing voice message...
      </span>
    );
  }

  // Apple expires audio messages after the user-configurable retention
  // window. If the file was already gone by the time the runner reached
  // it, there's no audio left to transcribe and the transcribe button
  // would just produce the same skip on every click. Show a calm one-
  // liner instead and stay out of the operator's way. Match the stable
  // "missing_file" code plus the older free-text reasons used by
  // backfill rows written before this code existed.
  if (
    local?.status === "skipped" &&
    typeof local.errorMessage === "string" &&
    /^missing_file$|missing on disk|not found on disk/i.test(local.errorMessage)
  ) {
    return (
      <span className="block text-[12px] leading-[1.45] text-ink-3">
        Voice message unavailable
      </span>
    );
  }

  // No usable transcript yet (null, failed, other skips, or empty).
  // Offer the on-demand action; failed / errored states render a small
  // "Try again" affordance instead of a fresh "Transcribe" link.
  const offerRetry = local?.status === "failed" || error !== null;
  const buttonLabel = offerRetry ? "Try again" : "Transcribe voice message";
  const hint = error
    ? error
    : local?.status === "failed"
      ? "Voice message could not be transcribed."
      : null;

  return (
    <span className="block text-[12px] leading-[1.45] text-ink-3">
      {hint ? <span className="mr-[6px]">{hint}</span> : null}
      <button
        type="button"
        onClick={trigger}
        className="inline-flex items-center rounded-[3px] border border-hairline px-[6px] py-[1px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 hover:bg-paper-2"
      >
        {buttonLabel}
      </button>
    </span>
  );
}

/**
 * Render a single iMessage attachment inline. Photos as <img>, videos as
 * <video controls>, voice notes / audio as <audio controls>, everything
 * else as a download link. The runner endpoint streams the binary and
 * does on-the-fly heic→jpg / caf→m4a conversion when needed.
 */
export function IMessageMedia({ attachment }: IMessageMediaProps) {
  if (!attachment.guid) {
    return (
      <span className="font-mono text-[12px] text-ink-3">
        [{labelFor(attachment.kind)}]
      </span>
    );
  }
  const url = `/runner/data/imessage-attachment/${encodeURIComponent(attachment.guid)}`;

  if (attachment.kind === "photo" || attachment.kind === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={attachment.rawLabel ?? "iMessage photo"}
          className="max-h-[320px] max-w-full rounded-[12px] object-contain"
          loading="lazy"
        />
      </a>
    );
  }

  if (attachment.kind === "video") {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-[320px] max-w-full rounded-[12px] bg-ink"
      />
    );
  }

  if (attachment.kind === "voice_note" || attachment.kind === "audio") {
    // Explicit width so the native audio control shows up even when the
    // parent bubble uses `flex flex-col items-end` (which has no definite
    // width - `w-full` then resolves to 0 and the player collapses to a
    // sliver). max-w-full keeps it shrinking on mobile.
    return (
      <audio
        src={url}
        controls
        preload="metadata"
        className="w-[300px] max-w-full"
      >
        <a href={url}>Download</a>
      </audio>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded bg-paper-2 px-3 py-2 text-[13px] text-ink hover:bg-paper-3"
    >
      <span>📎</span>
      <span>{attachment.rawLabel ?? labelFor(attachment.kind)}</span>
    </a>
  );
}

function labelFor(kind: ThreadMessage["attachments"][number]["kind"]): string {
  switch (kind) {
    case "voice_note": return "Voice note";
    case "photo": return "Photo";
    case "video": return "Video";
    case "audio": return "Audio";
    case "pdf": return "PDF";
    case "sticker": return "Sticker";
    default: return "Attachment";
  }
}
