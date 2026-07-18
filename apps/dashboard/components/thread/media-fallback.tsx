"use client";

interface MediaFallbackCardProps {
  kindLabel: string;
  filename?: string | null;
  href?: string | null;
  onRetry: () => void;
}

/**
 * Intentional failed-media card. Replaces the browser broken-image glyph
 * (Safari's question mark between rules) with a calm, actionable surface:
 * type, filename when known, clear failed state, Retry, and Open when a
 * downloadable URL still exists.
 */
export function MediaFallbackCard({
  kindLabel,
  filename,
  href,
  onRetry
}: MediaFallbackCardProps) {
  return (
    <div
      className="flex w-full max-w-[320px] flex-col gap-2 rounded-[12px] border border-hairline bg-paper-2 px-3 py-3"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          {kindLabel}
        </span>
        {filename ? (
          <span className="truncate text-[13px] leading-[1.4] text-ink" title={filename}>
            {filename}
          </span>
        ) : null}
        <span className="text-[12px] leading-[1.45] text-ink-3">
          Could not load this attachment
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center rounded-[3px] border border-hairline bg-paper px-[8px] py-[3px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-2 hover:bg-paper-2"
        >
          Retry
        </button>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-[3px] border border-hairline bg-transparent px-[8px] py-[3px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 hover:bg-paper"
          >
            Open
          </a>
        ) : null}
      </div>
    </div>
  );
}
