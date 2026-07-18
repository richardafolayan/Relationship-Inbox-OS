"use client";

import type { ThreadMessage } from "@/lib/types";
import { attachmentMediaPath, mediaKindLabel, rewriteLocalMediaUrl } from "@/lib/media-url";
import { PhotoViewer } from "@/components/thread/photo-viewer";
import { PlayableMedia } from "@/components/thread/playable-media";

export function GoogleMessagesMedia({
  attachment
}: {
  attachment: ThreadMessage["attachments"][number];
}) {
  if (!attachment.guid) return null;
  const url = rewriteLocalMediaUrl(
    attachmentMediaPath({ guid: attachment.guid, platform: "google_messages" })
  );
  if (attachment.kind === "photo" || attachment.kind === "sticker" || attachment.kind === "gif") {
    return (
      <PhotoViewer
        src={url}
        alt={attachment.rawLabel ?? "Google Messages photo"}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        className="max-h-[320px] max-w-full rounded-[12px] object-contain"
      />
    );
  }
  if (attachment.kind === "video") {
    return (
      <PlayableMedia
        as="video"
        src={url}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        className="max-h-[320px] max-w-full rounded-[12px] bg-ink"
      />
    );
  }
  if (attachment.kind === "audio" || attachment.kind === "voice_note") {
    return (
      <PlayableMedia
        as="audio"
        src={url}
        kind={attachment.kind}
        filename={attachment.rawLabel}
        className="w-full max-w-[320px]"
      />
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-[12px] underline underline-offset-2"
    >
      {attachment.rawLabel ?? mediaKindLabel(attachment.kind)}
    </a>
  );
}
