"use client";

import type { ThreadMessage } from "@/lib/types";

interface IMessageMediaProps {
  attachment: ThreadMessage["attachments"][number];
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
    // width — `w-full` then resolves to 0 and the player collapses to a
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
