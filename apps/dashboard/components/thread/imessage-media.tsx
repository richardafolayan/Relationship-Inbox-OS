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
  /**
   * Source attachment kind. Drives copy: "voice message" for audio
   * sources, "video" for a video whose audio track was extracted and
   * sent to OpenAI's `/v1/audio/transcriptions`. Defaults to voice
   * copy so the existing call-sites need no change.
   */
  attachmentKind?: "voice_note" | "audio" | "video";
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
export function VoiceMessageTranscript({
  messageId,
  transcription,
  attachmentKind
}: VoiceMessageTranscriptProps) {
  const [local, setLocal] = useState<ThreadMessage["audioTranscription"]>(transcription ?? null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isVideo = attachmentKind === "video";
  const transcriptLabel = isVideo ? "video transcript" : "voice message transcript";
  const pendingCopy = isVideo ? "Transcribing video..." : "Transcribing voice message...";
  const unavailableCopy = isVideo ? "Video unavailable" : "Voice message unavailable";
  const failedHintCopy = isVideo
    ? "Video could not be transcribed."
    : "Voice message could not be transcribed.";
  const transcribeButtonLabel = isVideo ? "Transcribe video" : "Transcribe voice message";

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
    // Truth-based: only show `Improving transcript...` when the
    // runner reports a higher-tier task is actually queued or
    // running. Backed by the service's in-memory pending-tiers map.
    // The previous time-window heuristic could lie (it lingered on
    // single-tier installs and lied during long-running max tiers
    // that had already finished); the field below is derived from
    // real pipeline state.
    const isImproving = local.isImproving === true;
    // Refinement tooltip: GPT-5-nano corrected the transcript using
    // the local model attempts + nearby messages. Doesn't change the
    // visible text; just provides provenance for the curious.
    const refined =
      local.selectedTier === "refinement" &&
      (local.refinementConfidence === "medium" ||
        local.refinementConfidence === "high");
    return (
      <span className="block whitespace-pre-wrap text-[12px] leading-[1.45] text-ink-3">
        <span
          className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3"
          title={refined ? "Refined from local transcript" : undefined}
        >
          {transcriptLabel}
        </span>
        <span className="ml-[6px]">{local.transcript}</span>
        {isImproving ? (
          <span className="mt-[2px] block text-[11px] italic text-ink-3">
            Improving transcript...
          </span>
        ) : null}
      </span>
    );
  }

  if (local?.status === "pending" || running) {
    return (
      <span className="block text-[12px] italic leading-[1.45] text-ink-3">
        {pendingCopy}
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
    // Quiet "unavailable" line with a small "Try again" affordance.
    // iCloud sometimes hasn't finished downloading the audio at the
    // moment the runner first looked; a manual retry asks the runner
    // to check again now. The endpoint passes `force: true` so dedup
    // doesn't block the second look.
    return (
      <span className="block text-[12px] leading-[1.45] text-ink-3">
        <span className="mr-[6px]">{unavailableCopy}</span>
        <button
          type="button"
          onClick={trigger}
          className="inline-flex items-center rounded-[3px] border border-hairline px-[6px] py-[1px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 hover:bg-paper-2"
        >
          Try again
        </button>
      </span>
    );
  }

  // No usable transcript yet (null, failed, other skips, or empty).
  // Offer the on-demand action; failed / errored states render a small
  // "Try again" affordance instead of a fresh "Transcribe" link.
  const offerRetry = local?.status === "failed" || error !== null;
  const buttonLabel = offerRetry ? "Try again" : transcribeButtonLabel;
  const hint = error ? error : local?.status === "failed" ? failedHintCopy : null;

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
  // LinkedIn voice notes set the message URN (`urn:li:msg_message:...`)
  // as the attachment guid; the runner serves them from a separate
  // endpoint that reads the captured bytes off disk. iMessage guids are
  // UUID-shaped (no `urn:` prefix), so the runtime check is unambiguous
  // without needing a separate `platform` prop here.
  const isLinkedInUrn = attachment.guid.startsWith("urn:li:");
  const url = isLinkedInUrn
    ? `/runner/data/linkedin-voice-message/${encodeURIComponent(attachment.guid)}`
    : `/runner/data/imessage-attachment/${encodeURIComponent(attachment.guid)}`;

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
