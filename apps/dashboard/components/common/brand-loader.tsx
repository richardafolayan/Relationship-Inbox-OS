// Branded loading mark for unavoidable waits: the "Tovi" wordmark with
// three staggered coral pulse dots (the app's existing in-progress motion,
// see .animate-pulse-dot in globals.css). Purely functional - it exists so a
// genuine load reads as the app working rather than a blank stare.
//
// It reveals itself only after a short delay (CSS animation-delay via
// .brand-loader-reveal): paints that resolve from cache within ~150ms never
// show it, so fast paths stay flash-free. Pure server component - no hooks,
// no client bundle.

import { APP_NAME } from "@/lib/branding";

const DOT_DELAYS_MS = [0, 160, 320] as const;

export function BrandLoader({ className = "" }: { className?: string }) {
  return (
    <div
      className={`brand-loader-reveal flex items-center gap-[10px] ${className}`}
      role="status"
      aria-label="Loading"
    >
      <span className="font-display text-[13px] font-semibold tracking-[-0.01em] text-ink-2">
        {APP_NAME}
      </span>
      <span className="flex items-center gap-[4px]" aria-hidden>
        {DOT_DELAYS_MS.map((delay) => (
          <span
            key={delay}
            className="animate-pulse-dot h-[5px] w-[5px] rounded-full bg-accent"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
