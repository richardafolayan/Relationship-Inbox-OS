import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Centred 920px canvas. The README's master shell measurement. Top
// padding is owned by the (sticky) PageHead so the glass bar sits flush
// against main's top edge once scrolled.
export function Canvas({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mx-auto w-full max-w-[920px] px-12 pb-[120px]", className)} {...rest}>
      {children}
    </div>
  );
}

interface PageHeadProps {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
}

// Eyebrow + 56px title on the left, optional mono meta on the right.
// The header is sticky and glassy: as the canvas scrolls, content slides
// underneath it through a translucent paper-tinted blur, matching the
// thread page's iOS-style sticky bar.
export function PageHead({ eyebrow, title, meta }: PageHeadProps) {
  return (
    <header className="sticky top-0 z-10 -mx-12 mb-10 flex items-end justify-between gap-6 border-b border-hairline bg-[color-mix(in_oklch,var(--paper)_72%,transparent)] px-12 pb-6 pt-14 backdrop-blur-md backdrop-saturate-150">
      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">{eyebrow}</p>
        <h1 className="m-0 font-display text-[56px] font-semibold leading-[1.02] tracking-[-0.035em]">
          {title}
        </h1>
      </div>
      {meta ? (
        <div className="text-right font-mono text-[12px] text-ink-3">{meta}</div>
      ) : null}
    </header>
  );
}

interface SectionDividerProps {
  label: string;
}

// `[label] ─────` divider used to bucket lists.
export function SectionDivider({ label }: SectionDividerProps) {
  return (
    <div className="mb-[18px] mt-14 flex items-center gap-[14px] px-1">
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
