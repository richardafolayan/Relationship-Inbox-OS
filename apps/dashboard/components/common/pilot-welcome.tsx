"use client";

import { X } from "lucide-react";

// A calm product note for pilot testers — not a landing page. Used in two
// places: as a dismissible first-run card on Today, and (without onDismiss)
// as a static panel in Settings so it stays findable after dismissal.
export function PilotWelcomeCard({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <section
      data-testid="pilot-welcome"
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
            Pilot · welcome
          </p>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss welcome card"
              title="Dismiss"
              className="-mr-1 -mt-1 grid h-7 w-7 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
            >
              <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
            </button>
          ) : null}
        </div>

        <h2 className="m-0 mt-2 max-w-[34ch] font-display text-[22px] font-semibold leading-[1.2] tracking-[-0.02em]">
          Relationship Inbox OS helps you reply properly.
        </h2>

        <p className="m-0 mt-3 text-[13.5px] leading-[1.55] text-ink-2">It shows:</p>
        <ul className="m-0 mt-2 flex list-none flex-col gap-[7px] p-0 text-[13.5px] leading-[1.5] text-ink">
          {["Who is waiting", "What they said", "What you still need to address"].map((item) => (
            <li key={item} className="flex items-center gap-[10px]">
              <span aria-hidden className="inline-block h-[5px] w-[5px] rounded-full bg-accent" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <p className="m-0 mt-4 border-t border-hairline pt-4 text-[13px] leading-[1.6] text-ink-2">
          You write the reply. AI help is optional, and nothing sends unless you choose to send it.
        </p>

        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="mt-4 inline-flex items-center rounded-pill border border-hairline px-[14px] py-[7px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
          >
            Got it
          </button>
        ) : null}
      </div>
    </section>
  );
}
