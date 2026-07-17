import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Centred 920px canvas. The README's master shell measurement. Top
// padding is owned by the (sticky) PageHead so the glass bar sits flush
// against the primary scroller once scrolled. Gutters breathe with the
// viewport (20 → 32 → 48px) and the canvas widens on big screens so a
// large monitor isn't a thin strip of content. Phone bottom padding is
// modest: the MobileDock owns its shell row and safe-area, so pages no
// longer reserve ~132px for a fixed overlay.
export function Canvas({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[920px] px-5 pb-8 sm:px-8 md:pb-[120px] lg:px-12 3xl:max-w-[1080px]",
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
    <header className="sticky top-0 z-10 -mx-5 mb-6 flex flex-col gap-1 bg-[color-mix(in_oklch,var(--paper)_95%,transparent)] px-5 pb-3 pt-4 backdrop-blur-md backdrop-saturate-150 sm:-mx-8 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 sm:px-8 sm:pt-6 lg:-mx-12 lg:px-12">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{eyebrow}</p>
        ) : null}
        <div className="flex flex-col gap-y-1">
          <h1 className="m-0 font-display text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[28px]">
            {title}
          </h1>
          {subtitle ? (
            <p className="m-0 max-w-[60ch] text-[13px] text-ink-2">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {meta ? (
        <div className="shrink-0 font-mono text-[12px] text-ink-3 sm:text-right">{meta}</div>
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
    <div className="mt-10 rounded-card border border-dashed border-hairline-strong px-6 py-16 text-center text-ink-3">
      <h4 className="m-0 mb-2 font-display text-[28px] font-semibold tracking-[-0.022em] text-ink">
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
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-6 border-t border-hairline px-1 py-[22px] last:border-b last:border-hairline">
      <div>
        <p className="m-0 font-display text-[18px] font-medium tracking-[-0.012em] text-ink">{name}</p>
        {stat ? <p className="mt-1 font-mono text-[12px] text-ink-3">{stat}</p> : null}
      </div>
      {status ? <div>{status}</div> : <span />}
      {action ? <div>{action}</div> : <span />}
    </div>
  );
}
