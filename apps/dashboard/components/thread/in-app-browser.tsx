"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Loader2, X } from "lucide-react";
import { apiGet } from "@/lib/api";
import { displayHost } from "@/lib/linkify";
import { fetchPreviewPath, type LinkPreviewData } from "@/components/thread/link-preview-card";
import { APP_NAME } from "@/lib/branding";

export type InAppBrowserTarget = {
  url: string;
  /** Preview data when opened from a card (already fetched); null from a bare text link. */
  preview: LinkPreviewData | null;
};

/**
 * In-app browser overlay - the Instagram/TikTok webview pattern. Opens a
 * link without leaving the thread:
 *
 *   * TikTok / YouTube links render the provider's own embed player
 *     (their watch pages refuse framing; the players are built for it).
 *   * Sites whose headers allow framing load in a sandboxed iframe.
 *   * Everything else gets the preview + an "Open in browser" panel.
 *
 * "Open in browser" (header + fallback panel) hands the link to the real
 * browser in a new tab. Esc, backdrop click, or the X closes.
 *
 * Body-portalled: the thread page lives under sticky/stacking-context
 * ancestors (TopStatus z-30), so an in-place fixed overlay could lose the
 * z-battle. Same approach as the notification panel (#694).
 */
export function InAppBrowser({
  target,
  onClose
}: {
  target: InAppBrowserTarget | null;
  onClose: () => void;
}) {
  const [fetched, setFetched] = useState<LinkPreviewData | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);

  const preview = target?.preview ?? fetched;

  // Bare text links arrive without preview data. Fetch it here so we know
  // whether the site tolerates iframes before pointing one at it.
  useEffect(() => {
    setFetched(null);
    setFetchFailed(false);
    setFrameLoaded(false);
    if (!target || target.preview) return;
    let cancelled = false;
    apiGet<LinkPreviewData>(fetchPreviewPath(target.url), { ttlMs: 5 * 60_000 })
      .then((data) => {
        if (!cancelled) setFetched(data);
      })
      .catch(() => {
        if (!cancelled) setFetchFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Esc closes; the page behind must not scroll while the overlay is up.
  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [target, onClose]);

  if (!target) return null;

  const href = preview?.finalUrl ?? target.url;
  const host = preview?.host || displayHost(target.url);
  const openExternal = () => {
    window.open(href, "_blank", "noopener,noreferrer");
  };

  const spinner = (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-ink-3" strokeWidth={1.8} />
    </div>
  );

  let body: React.ReactNode;
  if (!preview && !fetchFailed) {
    // Still asking the runner about this URL.
    body = spinner;
  } else if (preview?.embedUrl) {
    const isTikTok = preview.provider === "tiktok";
    body = (
      <div className="flex h-full w-full items-center justify-center bg-paper-2 p-4">
        <iframe
          src={preview.embedUrl}
          title={preview.title ?? host}
          onLoad={() => setFrameLoaded(true)}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          className={
            isTikTok
              ? "h-full max-h-[760px] w-[343px] max-w-full rounded-[12px] border-0 bg-white"
              : "aspect-video max-h-full w-full max-w-[880px] rounded-[12px] border-0 bg-black"
          }
        />
      </div>
    );
  } else if (preview?.embeddable) {
    body = (
      <div className="relative h-full w-full">
        {!frameLoaded ? <div className="absolute inset-0">{spinner}</div> : null}
        <iframe
          src={href}
          title={preview.title ?? host}
          onLoad={() => setFrameLoaded(true)}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-white"
        />
      </div>
    );
  } else {
    // The site refuses framing (or the unfurl failed entirely): show what
    // we know and hand off to the real browser.
    body = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 py-8 text-center">
        {preview?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview.imageUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
            className="max-h-[45%] w-auto max-w-[420px] rounded-xl border border-hairline object-cover"
          />
        ) : null}
        <div className="flex max-w-[480px] flex-col gap-[6px]">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-4">
            {preview?.siteName ?? host}
          </span>
          {preview?.title ? (
            <span className="text-[15px] font-medium leading-snug text-ink">{preview.title}</span>
          ) : null}
          <span className="text-[13px] text-ink-3">
            This site can't be viewed inside {APP_NAME}.
          </span>
        </div>
        <button
          type="button"
          onClick={openExternal}
          className="flex items-center gap-[7px] rounded-full bg-ink px-4 py-[9px] text-[13px] font-medium text-paper transition-opacity duration-calm hover:opacity-90"
        >
          <ExternalLink className="h-[14px] w-[14px]" strokeWidth={1.8} />
          Open in browser
        </button>
      </div>
    );
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${host}`}
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] p-[3vmin] backdrop-blur-md"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-full max-h-[860px] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-hairline bg-paper shadow-pop"
      >
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-4">
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-4">
              {host}
            </span>
            {preview?.title ? (
              <span className="truncate text-[13px] text-ink-2">{preview.title}</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={openExternal}
            className="flex shrink-0 items-center gap-[6px] rounded-full border border-hairline px-3 py-[6px] text-[12px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink"
          >
            <ExternalLink className="h-[13px] w-[13px]" strokeWidth={1.8} />
            Open in browser
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    </div>,
    document.body
  );
}
