"use client";

import { useMemo } from "react";
import { Moon, Info } from "lucide-react";
import { focusRailIdleLine, formatUntil, isFocusAckCandidate } from "@/lib/focus";
import { openFocusReview, openFocusSetup, useFocusWindow } from "@/lib/use-focus-window";
import type { InboxRow } from "@/lib/types";

// The Focus Reply Buffer card for the Today right rail. Focus off: a quiet
// start entry. Focus on: the active banner with a live count of covered
// contacts who messaged while heads-down, and the review / edit / end actions.
// `rows` is Today's already-fetched inbox so the count matches the page.
// Quiet hours deliberately does NOT gate these offers: an explicitly started
// window is the operator asking for them, and nothing sends without a tap.
export function FocusRailCard({ rows }: { rows: InboxRow[] }) {
  const { focusWindow, settings, active, endFocus } = useFocusWindow();

  const openCount = useMemo(() => {
    if (!active) return 0;
    return rows.filter((row) => isFocusAckCandidate(row, focusWindow, settings)).length;
  }, [rows, focusWindow, settings, active]);

  if (!active) {
    return (
      <section className="rounded-[14px] border border-hairline bg-paper p-[18px]">
        <p className="mb-[10px] flex items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-accent-ink">
          <Moon className="h-[13px] w-[13px]" strokeWidth={1.7} />
          Focus
        </p>
        <p className="m-0 text-[14px] font-medium leading-[1.3] text-ink">
          Heading into a block of focused work?
        </p>
        <p className="m-0 mt-[6px] text-[12.5px] leading-[1.5] text-ink-3">
          Protect the time. People who message will know you’ve seen them, and you reply properly
          after.
        </p>
        <button
          type="button"
          onClick={() => openFocusSetup()}
          className="mt-[14px] inline-flex w-full items-center justify-center rounded-pill border border-hairline bg-paper px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
        >
          Start a focus window
        </button>
      </section>
    );
  }

  const untilLabel = formatUntil(focusWindow.endsAt);

  return (
    <section
      className="rounded-[16px] border p-[18px]"
      style={{
        borderColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
        background:
          "radial-gradient(120% 100% at 100% 0%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%), var(--paper)"
      }}
    >
      <p className="mb-[10px] flex items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-accent-ink">
        <Moon className="h-[13px] w-[13px]" strokeWidth={1.7} />
        Focus block
        {settings.reasonLabel && focusWindow.reason ? (
          <span className="text-ink-3">· {focusWindow.reason}</span>
        ) : null}
      </p>
      <h2 className="m-0 font-display text-[17px] font-semibold leading-[1.25] tracking-[-0.018em] text-ink">
        {untilLabel ? `Focus block active until ${untilLabel}.` : "Focus block active."}
      </h2>
      <p className="m-0 mt-[8px] text-[13px] leading-[1.5] text-ink-2">
        {openCount > 0 ? (
          <>
            <strong className="font-semibold text-accent-ink">
              {openCount} {openCount === 1 ? "message" : "messages"}
            </strong>{" "}
            arrived while you’ve been heads-down. They haven’t heard back yet.
          </>
        ) : (
          focusRailIdleLine(focusWindow)
        )}
      </p>
      <div className="mt-[14px] flex flex-col gap-[8px]">
        {openCount > 0 ? (
          <button
            type="button"
            onClick={() => openFocusReview()}
            className="inline-flex items-center justify-center rounded-pill bg-accent px-[14px] py-[8px] text-[12.5px] font-medium text-white transition-opacity duration-calm hover:opacity-90"
          >
            Review acknowledgements
          </button>
        ) : null}
        <div className="flex gap-[8px]">
          <button
            type="button"
            onClick={() => openFocusSetup({ editNote: true })}
            className="inline-flex flex-1 items-center justify-center rounded-pill border border-hairline bg-paper px-[12px] py-[7px] text-[12px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink"
          >
            Edit note
          </button>
          <button
            type="button"
            onClick={() => void endFocus()}
            className="inline-flex flex-1 items-center justify-center rounded-pill border border-hairline bg-paper px-[12px] py-[7px] text-[12px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink"
          >
            End focus
          </button>
        </div>
      </div>
      <p className="m-0 mt-[14px] flex items-start gap-[8px] border-t border-hairline pt-[12px] text-[12px] leading-[1.5] text-ink-3">
        <Info className="mt-[1px] h-[13px] w-[13px] shrink-0 text-accent" strokeWidth={1.7} />
        <span>
          This only buys you breathing room. It doesn’t replace the real reply, which still waits in
          your list.
        </span>
      </p>
    </section>
  );
}
