"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { MediaFallbackCard } from "@/components/thread/media-fallback";
import {
  mediaKindLabel,
  rewriteLocalMediaUrl,
  withMediaRetryParam
} from "@/lib/media-url";

interface PhotoViewerProps {
  alt: string;
  className: string;
  src: string;
  /** Coarse attachment kind for the failed-media card label. */
  kind?: string | null;
  /** Filename / raw label shown when the image fails to load. */
  filename?: string | null;
}

export function PhotoViewer({ alt, className, src, kind, filename }: PhotoViewerProps) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const safeSrc = withMediaRetryParam(rewriteLocalMediaUrl(src), attempt);
  const kindLabel = mediaKindLabel(kind ?? "photo");
  const displayName = filename ?? alt;

  useEffect(() => {
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!safeSrc || failed) {
    return (
      <MediaFallbackCard
        kindLabel={kindLabel}
        filename={displayName}
        href={safeSrc || null}
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block cursor-zoom-in"
        aria-label={`Open ${alt}`}
      >
        <img
          key={attempt}
          src={safeSrc}
          alt={alt}
          className={className}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-[80] grid place-items-center bg-black/85 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-4 top-4 inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-black shadow-lg hover:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Close
          </button>
          <img
            key={`full-${attempt}`}
            src={safeSrc}
            alt={alt}
            className="max-h-full max-w-full rounded-[12px] object-contain"
            onError={() => setFailed(true)}
          />
        </div>
      ) : null}
    </>
  );
}
