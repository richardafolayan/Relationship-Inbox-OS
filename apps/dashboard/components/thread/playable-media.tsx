"use client";

import { useEffect, useState } from "react";
import { MediaFallbackCard } from "@/components/thread/media-fallback";
import {
  mediaKindLabel,
  rewriteLocalMediaUrl,
  withMediaRetryParam
} from "@/lib/media-url";

interface PlayableMediaProps {
  src: string;
  kind: string | null | undefined;
  filename?: string | null;
  /** "video" or "audio" element. */
  as: "video" | "audio";
  className: string;
  autoPlay?: boolean;
  loop?: boolean;
}

/**
 * Video / audio element with the same failed-media fallback as photos.
 * Localhost origins are rewritten; load failures show type, filename,
 * Retry, and Open instead of a silent dead control.
 */
export function PlayableMedia({
  src,
  kind,
  filename,
  as,
  className,
  autoPlay,
  loop
}: PlayableMediaProps) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const safeSrc = withMediaRetryParam(rewriteLocalMediaUrl(src), attempt);
  const kindLabel = mediaKindLabel(kind);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!safeSrc || failed) {
    return (
      <MediaFallbackCard
        kindLabel={kindLabel}
        filename={filename}
        href={safeSrc || null}
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (as === "video") {
    return (
      <video
        key={attempt}
        src={safeSrc}
        controls
        autoPlay={autoPlay}
        loop={loop}
        preload="none"
        className={className}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <audio
      key={attempt}
      src={safeSrc}
      controls
      preload="none"
      className={className}
      onError={() => setFailed(true)}
    >
      <a href={safeSrc}>Download</a>
    </audio>
  );
}
