"use client";

import type { ThreadMessage } from "@/lib/types";
import { attachmentMediaPath, mediaKindLabel, rewriteLocalMediaUrl } from "@/lib/media-url";
import { PhotoViewer } from "@/components/thread/photo-viewer";
import { PlayableMedia } from "@/components/thread/playable-media";

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
 *
 * URLs are always same-origin `/runner/data/...` paths so phone-accessible
 * clients never load a Mac-only localhost origin.
 */
export function WhatsAppMedia({ attachment }: WhatsAppMediaProps) {
  if (!attachment.guid) {
    return (
      <span className="font-mono text-[12px] text-ink-3">
        [{mediaKindLabel(attachment.kind)}]
      </span>
    );
  }
  const url = rewriteLocalMediaUrl(
    attachmentMediaPath({ guid: attachment.guid, platform: "whatsapp" })
  );

  if (attachment.kind === "photo") {
    return (
      <PhotoViewer
        src={url}
        alt={attachment.rawLabel ?? "WhatsApp photo"}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        className="max-h-[320px] max-w-full rounded-[12px] object-contain"
      />
    );
  }

  if (attachment.kind === "sticker") {
    return (
      <PhotoViewer
        src={url}
        alt={attachment.rawLabel ?? "WhatsApp sticker"}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        className="max-h-[160px] max-w-[160px] object-contain"
      />
    );
  }

  if (attachment.kind === "gif" && attachment.type?.startsWith("image/")) {
    return (
      <PhotoViewer
        src={url}
        alt={attachment.rawLabel ?? "WhatsApp GIF"}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        className="max-h-[320px] max-w-full rounded-[12px] object-contain"
      />
    );
  }

  if (attachment.kind === "video" || attachment.kind === "gif") {
    return (
      <PlayableMedia
        as="video"
        src={url}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        // Autoplay muted GIFs match WhatsApp's UX — they're delivered as
        // MP4 but visually behave like a looping GIF. Browser autoplay
        // policies allow this when muted; we keep autoplay off and loop
        // so the control stays deliberate.
        autoPlay={false}
        loop
        className="max-h-[320px] max-w-full rounded-[12px] bg-transparent"
      />
    );
  }

  if (attachment.kind === "voice_note" || attachment.kind === "audio") {
    return (
      <PlayableMedia
        as="audio"
        src={url}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        className="w-[300px] max-w-full"
      />
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded border border-hairline bg-transparent px-3 py-2 text-[13px] text-ink hover:bg-paper-2"
    >
      <span>📎</span>
      <span>{attachment.rawLabel ?? mediaKindLabel(attachment.kind)}</span>
    </a>
  );
}
