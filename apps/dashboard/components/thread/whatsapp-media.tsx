"use client";

import type { ThreadMessage } from "@/lib/types";

interface WhatsAppMediaProps {
  attachment: ThreadMessage["attachments"][number];
}

/**
 * Render a single WhatsApp attachment inline. The runner persists
 * downloaded media under whatsappMediaDir and serves it from
 * /runner/data/whatsapp-attachment/:guid — this component just renders
 * the right tag (img / video / audio / link) based on `kind`.
 *
 * Mirrors components/thread/imessage-media.tsx so the two platforms feel
 * consistent in the timeline. Sticker rendering matches photo: a small
 * inline image with a slightly tighter cap so it doesn't dwarf text
 * bubbles, since stickers tend to be square and dense.
 */
export function WhatsAppMedia({ attachment }: WhatsAppMediaProps) {
  if (!attachment.guid) {
    return (
      <span className="font-mono text-[12px] text-ink-3">
        [{labelFor(attachment.kind)}]
      </span>
    );
  }
  const url = `/runner/data/whatsapp-attachment/${encodeURIComponent(attachment.guid)}`;

  if (attachment.kind === "photo") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={attachment.rawLabel ?? "WhatsApp photo"}
          className="max-h-[320px] max-w-full rounded-[12px] object-contain"
          loading="lazy"
        />
      </a>
    );
  }

  if (attachment.kind === "sticker") {
    return (
      <img
        src={url}
        alt={attachment.rawLabel ?? "WhatsApp sticker"}
        // Stickers feel weird at full size — cap tighter so they read as
        // a sticker, not a regular photo.
        className="max-h-[160px] max-w-[160px] object-contain"
        loading="lazy"
      />
    );
  }

  if (attachment.kind === "video") {
    return (
      <video
        src={url}
        controls
        // Autoplay muted GIFs match WhatsApp's UX — they're delivered as
        // MP4 but visually behave like a looping GIF. Browser autoplay
        // policies allow this when muted.
        autoPlay={false}
        loop
        preload="metadata"
        className="max-h-[320px] max-w-full rounded-[12px] bg-ink"
      />
    );
  }

  if (attachment.kind === "voice_note" || attachment.kind === "audio") {
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
