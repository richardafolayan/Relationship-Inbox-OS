"use client";

import { X } from "lucide-react";

// Small calm card shown on first run that asks the pilot tester whether
// they'd like the 2-minute walkthrough. NOT a takeover — same paper
// surface and hairline border as PilotWelcomeCard so it sits naturally
// at the top of Today. Buttons trigger the tour start; the parent owns
// the seen-flag bookkeeping so the card can vanish once dismissed.
export function PilotTourInviteCard({
  onStart,
  onSkip
}: {
  onStart: () => void;
  onSkip: () => void;
}) {
  return (
    <section
      data-testid="pilot-tour-invite"
      data-tour="pilot-tour-invite"
      className="relative mb-8 overflow-hidden rounded-card border border-hairline bg-paper p-6 shadow-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 100% 0%, color-mix(in oklch, var(--accent) 9%, transparent), transparent 55%)"
        }}
      />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <p className="m-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            Pilot · walkthrough
          </p>
          <button
            type="button"
            onClick={onSkip}
            aria-label="Skip the walkthrough for now"
            title="Skip for now"
            className="-mr-1 -mt-1 grid h-7 w-7 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
          </button>
        </div>

        <h2 className="m-0 mt-2 max-w-[34ch] font-display text-[22px] font-semibold leading-[1.2] tracking-[-0.02em]">
          Want a 2-minute walkthrough?
        </h2>

        <p className="m-0 mt-3 max-w-[58ch] text-[13.5px] leading-[1.55] text-ink-2">
          I&rsquo;ll show you how to find what needs a reply, catch up
          quickly, and clear a thread. It uses demo conversations only.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-[10px]">
          <button
            type="button"
            onClick={onStart}
            className="inline-flex items-center rounded-pill bg-ink px-[16px] py-[8px] text-[12.5px] font-medium text-paper transition-colors duration-calm hover:bg-[oklch(28%_0.01_80)]"
          >
            Start demo
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[7px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
          >
            Skip for now
          </button>
        </div>
      </div>
    </section>
  );
}
