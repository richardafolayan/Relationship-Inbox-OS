"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe } from "lucide-react";
import { apiGet } from "@/lib/api";
import { displayHost } from "@/lib/linkify";

// Mirrors the runner's LinkPreview shape (services/link-preview.ts).
export type LinkPreviewData = {
  status: "ok" | "error";
  url: string;
  finalUrl: string;
  host: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  embeddable: boolean;
  provider: "tiktok" | "youtube" | null;
  embedUrl: string | null;
};

// Module-level cache: the timeline re-renders constantly (SSE deltas +
// polling), so cards must come back already-resolved instead of flashing
// their skeleton on every pass. apiGet has its own response cache too;
// this one just skips the async hop for mounted cards.
const previewByUrl = new Map<string, LinkPreviewData>();

export function fetchPreviewPath(url: string): string {
  return `/runner/data/link-preview?url=${encodeURIComponent(url)}`;
}

/**
 * iMessage-style unfurl card for a URL inside a message bubble. Fetches
 * lazily - only once the card scrolls near the viewport - so a long
 * thread full of links does not fan out unfurl requests on first paint.
 * Click opens the in-app browser overlay; cmd/ctrl-click goes straight
 * to a new tab.
 */
export function LinkPreviewCard({
  url,
  onOpen
}: {
  url: string;
  onOpen: (url: string, preview: LinkPreviewData | null) => void;
}) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(() => previewByUrl.get(url) ?? null);
  const [failed, setFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (preview || failed) return;
    const node = containerRef.current;
    if (!node) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiGet<LinkPreviewData>(fetchPreviewPath(url), { ttlMs: 5 * 60_000 });
        previewByUrl.set(url, data);
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [url, preview, failed]);

  const open = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey) {
      window.open(preview?.finalUrl ?? url, "_blank", "noopener,noreferrer");
      return;
    }
    onOpen(url, preview);
  };

  // Unfurl failed (site down, blocked, not HTML): a quiet host row that
  // still opens the in-app browser, which falls back gracefully.
  if (failed || (preview && preview.status === "error")) {
    return (
      <div ref={containerRef} className="w-[280px] max-w-full">
        <button
          type="button"
          onClick={open}
          className="flex w-full items-center gap-2 rounded-xl border border-hairline bg-paper px-3 py-[10px] text-left transition-colors duration-calm hover:border-hairline-strong"
        >
          <Globe className="h-[14px] w-[14px] shrink-0 text-ink-4" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{displayHost(url)}</span>
          <ExternalLink className="h-[13px] w-[13px] shrink-0 text-ink-4" strokeWidth={1.8} />
        </button>
      </div>
    );
  }

  // Still resolving: host + shimmer, sized like the finished card's text
  // block so the swap does not jolt the timeline.
  if (!preview) {
    return (
      <div
        ref={containerRef}
        className="w-[280px] max-w-full rounded-xl border border-hairline bg-paper px-3 py-[10px]"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4">
          {displayHost(url)}
        </span>
        <div className="mt-[8px] h-[10px] w-3/4 animate-pulse rounded-full bg-paper-2" />
        <div className="mt-[6px] h-[10px] w-1/2 animate-pulse rounded-full bg-paper-2" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-[280px] max-w-full">
      <button
        type="button"
        onClick={open}
        title={preview.finalUrl}
        className="block w-full overflow-hidden rounded-xl border border-hairline bg-paper text-left transition-colors duration-calm hover:border-hairline-strong"
      >
        {preview.imageUrl && !imageFailed ? (
          <div className="aspect-video w-full overflow-hidden bg-paper-2">
            {/* Plain img on purpose: preview thumbnails come from arbitrary
                external hosts, which next/image would need configured
                domains for. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview.imageUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImageFailed(true)}
              className="h-full w-full object-cover"
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-[3px] px-3 py-[10px]">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4">
            {preview.siteName ?? preview.host}
          </span>
          {preview.title ? (
            <span className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">
              {preview.title}
            </span>
          ) : (
            <span className="truncate text-[13px] text-ink-2">{preview.host}</span>
          )}
          {preview.description ? (
            <span className="line-clamp-2 text-[12px] leading-snug text-ink-3">
              {preview.description}
            </span>
          ) : null}
        </div>
      </button>
    </div>
  );
}
