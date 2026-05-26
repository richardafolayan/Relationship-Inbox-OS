"use client";

import type { ThreadMessage } from "@/lib/types";

interface IMessageMediaProps {
  attachment: ThreadMessage["attachments"][number];
}

interface VoiceMessageTranscriptProps {
  transcription: NonNullable<ThreadMessage["audioTranscription"]>;
}

/**
 * Quiet status line rendered under a voice / audio attachment when the
 * runner has run a transcription for the message. Stays visually
 * secondary (12px, ink-3, no badge) so it never competes with the audio
 * control or the message text. Skipped silently when the transcription
 * was deliberately skipped (no api key, file too big, etc.) since the
 * user already sees the audio control and the skip is internal noise.
 */
export function VoiceMessageTranscript({ transcription }: VoiceMessageTranscriptProps) {
  if (transcription.status === "transcribed" && transcription.transcript && transcription.transcript.trim().length > 0) {
    return (
      <span className="block whitespace-pre-wrap text-[12px] leading-[1.45] text-ink-3">
        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
          voice message transcript
        </span>
        <span className="ml-[6px]">{transcription.transcript}</span>
      </span>
    );
  }
  if (transcription.status === "pending") {
    return (
      <span className="block text-[12px] italic leading-[1.45] text-ink-3">
        Transcribing voice message...
      </span>
    );
  }
  if (transcription.status === "failed") {
    return (
      <span className="block text-[12px] leading-[1.45] text-ink-3">
        Voice message could not be transcribed
      </span>
    );
  }
  return null;
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
