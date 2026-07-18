import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Centred 920px canvas. The README's master shell measurement. Top
// padding is owned by the (sticky) PageHead so the glass bar sits flush
// against main's top edge once scrolled. Gutters breathe with the
// viewport (20 → 32 → 48px) and the canvas widens on big screens so a
// large monitor isn't a thin strip of content; the bottom padding also
// clears the phone dock + home indicator.
export function Canvas({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[920px] px-4 pb-[calc(76px+env(safe-area-inset-bottom))] sm:px-8 sm:pb-[96px] md:pb-[120px] lg:px-12 3xl:max-w-[1080px]",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

interface PageHeadProps {
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  meta?: ReactNode;
}

// Compact page header: title + optional one-line subtitle on the left,
// meta on the right (same baseline as the title; stacks underneath on
// phone widths). Sticky + glassy, no decorative bottom rule - content
// sections own their own dividers. The negative margins mirror the
// Canvas gutters at every breakpoint so the glass runs edge to edge.
export function PageHead({ eyebrow, title, subtitle, meta }: PageHeadProps) {
  return (
    <header className="sticky top-0 z-20 -mx-4 mb-4 flex items-start justify-between gap-3 border-b border-hairline/70 bg-[color-mix(in_oklch,var(--paper)_96%,transparent)] px-4 pb-2.5 pt-3 backdrop-blur-xl backdrop-saturate-150 sm:-mx-8 sm:mb-6 sm:items-baseline sm:gap-6 sm:border-b-0 sm:px-8 sm:pb-3 sm:pt-6 lg:-mx-12 lg:px-12">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-0.5 hidden font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 sm:block">{eyebrow}</p>
        ) : null}
        <div className="flex flex-col gap-y-1">
          <h1 className="m-0 font-display text-[23px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[28px]">
            {title}
          </h1>
          {subtitle ? (
            <p className="m-0 line-clamp-2 max-w-[60ch] text-[12px] leading-[1.35] text-ink-2 sm:line-clamp-none sm:text-[13px]">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {meta ? (
        <div className="max-w-[42%] shrink-0 text-right font-mono text-[10.5px] leading-[1.35] text-ink-3 sm:max-w-none sm:text-[12px]">{meta}</div>
      ) : null}
    </header>
  );
}

interface SectionDividerProps {
  label: string;
  // `tight` trims the leading gap for the first divider in a list, where
  // the full `mt-14` would leave a dead band under the page controls.
  tight?: boolean;
}

// `[label] ─────` divider used to bucket lists.
export function SectionDivider({ label, tight }: SectionDividerProps) {
  return (
    <div
      className={cn(
        "mb-[18px] flex items-center gap-[14px] px-1",
        tight ? "mt-7" : "mt-14"
      )}
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">{label}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

interface CaughtUpProps {
  title: string;
  body?: string;
}

// Dashed-border empty state. Used on Today / Inbox / At-Risk when the
// filtered set is empty.
export function CaughtUp({ title, body }: CaughtUpProps) {
  return (
    <div className="mt-6 rounded-card border border-dashed border-hairline-strong px-5 py-10 text-center text-ink-3 sm:mt-10 sm:px-6 sm:py-16">
      <h4 className="m-0 mb-2 font-display text-[24px] font-semibold tracking-[-0.022em] text-ink sm:text-[28px]">
        {title}
      </h4>
      {body ? <p className="m-0 text-[14px]">{body}</p> : null}
    </div>
  );
}

interface QuietRowProps {
  name: string;
  stat?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
}

// Three-column quiet row used on Platforms / Settings / People stub.
export function QuietRow({ name, stat, status, action }: QuietRowProps) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-hairline px-1 py-4 last:border-b last:border-hairline sm:grid-cols-[1fr_auto_auto] sm:gap-6 sm:py-[22px]">
      <div>
        <p className="m-0 font-display text-[18px] font-medium tracking-[-0.012em] text-ink">{name}</p>
        {stat ? <p className="mt-1 font-mono text-[12px] text-ink-3">{stat}</p> : null}
      </div>
      {status ? <div className="text-right">{status}</div> : <span />}
      {action ? <div className="col-span-2 sm:col-span-1">{action}</div> : <span />}
    </div>
  );
}
