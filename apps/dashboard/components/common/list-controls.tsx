"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared list-control primitives for the redesigned list pages (Inbox,
// Archived). The consolidated filter bar — ghost search + status tabs + a
// compact Sort / Filters / Select cluster — is the same family across
// these screens, so the reusable atoms live here.

// "tool" button styling for the bar cluster (Sort / Filters / Select).
export const TOOL_CLASS =
  "inline-flex min-h-[40px] items-center gap-[6px] rounded-[8px] px-[10px] py-[6px] text-[12px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-0";

// ---- Inline glyphs (drawn directly to match the prototype's tool icons
// without adding icon-name dependencies) ----
export function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.9}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}
export function ChevronGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} className="opacity-50">
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d="M5 12l5 5 9-10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function SortGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function FilterGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <path d="M3 5h18M6 12h12M10 19h4" strokeLinecap="round" />
    </svg>
  );
}
export function SelectGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Close an open popover/menu on outside-click or Escape.
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

// Sort: a small menu-button. Generic over the option key so each page can
// supply its own sort modes.
export function SortMenu<K extends string>({
  value,
  options,
  onChange
}: {
  value: K;
  options: readonly { key: K; label: string }[];
  onChange: (value: K) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const label = options.find((o) => o.key === value)?.label ?? "";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(TOOL_CLASS, open ? "bg-paper-2 text-ink" : "")}
        aria-expanded={open}
      >
        <SortGlyph />
        <span className="font-mono">{label}</span>
        <ChevronGlyph />
      </button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[180px] max-w-[calc(100vw-32px)] rounded-[12px] border border-hairline bg-paper p-[6px] shadow-pop">
          {options.map((o) => {
            const sel = value === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => {
                  onChange(o.key);
                  setOpen(false);
                }}
                className={cn(
                  "flex min-h-[42px] w-full items-center gap-2 rounded-[7px] px-[10px] py-[7px] text-left text-[13px] transition-colors duration-calm hover:bg-paper-2 sm:min-h-0",
                  sel ? "text-ink" : "text-ink-2 hover:text-ink"
                )}
              >
                <span className="flex-1">{o.label}</span>
                <span className={cn("text-accent-ink", sel ? "opacity-100" : "opacity-0")}>
                  <CheckGlyph />
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// A labelled group of segmented options inside the Filters popover.
export function PopSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="m-0 mb-[10px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{label}</p>
      <div className="flex flex-wrap gap-[6px]">{children}</div>
    </div>
  );
}

// One segmented option button inside the Filters popover.
export function PopOpt({
  selected,
  onClick,
  children
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-[8px] border px-[11px] py-[5px] text-[12px] transition-colors duration-calm",
        selected
          ? "border-ink bg-ink text-paper"
          : "border-hairline text-ink-2 hover:border-hairline-strong hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}
