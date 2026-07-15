"use client";

import type { ThreadMessage } from "@/lib/types";
import { PhotoViewer } from "@/components/thread/photo-viewer";

export function GoogleMessagesMedia({
  attachment
}: {
  attachment: ThreadMessage["attachments"][number];
}) {
  if (!attachment.guid) return null;
  const url = `/runner/data/google-messages-attachment/${encodeURIComponent(attachment.guid)}`;
  if (attachment.kind === "photo" || attachment.kind === "sticker" || attachment.kind === "gif") {
    return <PhotoViewer src={url} alt={attachment.rawLabel ?? "Google Messages photo"} className="max-h-[320px] max-w-full rounded-[12px] object-contain" />;
  }
  if (attachment.kind === "video") {
    return <video src={url} controls preload="metadata" className="max-h-[320px] max-w-full rounded-[12px] bg-ink" />;
  }
  if (attachment.kind === "audio" || attachment.kind === "voice_note") {
    return <audio src={url} controls preload="metadata" className="w-full max-w-[320px]" />;
  }
  return <a href={url} target="_blank" rel="noreferrer" className="text-[12px] underline underline-offset-2">Open attachment</a>;
}
