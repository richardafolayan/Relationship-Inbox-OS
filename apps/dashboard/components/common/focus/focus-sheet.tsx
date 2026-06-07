"use client";

import { useEffect, type ReactNode } from "react";
import { Moon, X } from "lucide-react";

// Shared modal shell for the Focus Reply Buffer sheets (setup + review).
// Matches the app's calm overlay treatment: a blurred ink scrim, a paper
// card with a moon eyebrow, a title + sub, a close affordance, and a footer
// action row. Closes on backdrop click and Escape.
export function FocusSheet({
  open,
  onClose,
  eyebrow,
  title,
  sub,
  children,
  footer
}: {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-ink/30 px-5 py-[7vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-card border border-hairline-strong bg-paper shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative px-6 pt-[22px]">
          <p className="flex items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-accent-ink">
            <Moon className="h-[13px] w-[13px]" strokeWidth={1.7} />
            {eyebrow}
          </p>
          <h3 className="m-0 mt-2 font-display text-[19px] font-semibold tracking-[-0.018em] text-ink">
            {title}
          </h3>
          {sub ? (
            <p
              className="m-0 mt-1 max-w-[52ch] text-[13px] leading-[1.5] text-ink-2"
              style={{ textWrap: "pretty" }}
            >
              {sub}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-[18px] top-[18px] grid h-6 w-6 place-items-center rounded-[6px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <X className="h-[14px] w-[14px]" strokeWidth={1.8} />
          </button>
        </div>
        <div className="px-6 pb-2 pt-4">{children}</div>
        {footer ? (
          <div className="flex items-center gap-[10px] px-6 pb-5 pt-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
