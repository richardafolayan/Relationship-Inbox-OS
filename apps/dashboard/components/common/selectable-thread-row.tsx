"use client";

import Link from "next/link";
import type { InboxRow } from "@/lib/types";
import { PLATFORM_LABEL, initials, toDisplayRisk, type DisplayRisk } from "@/lib/risk";
import { formatRelative } from "@/lib/time";

const dotClass: Record<DisplayRisk, string> = {
  overdue: "bg-risk-overdue",
  waiting: "bg-risk-waiting",
  fresh: "bg-risk-fresh"
};

interface SelectableThreadRowProps {
  row: InboxRow;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string, event: { shiftKey: boolean }) => void;
}

// Mirror of ThreadRow with select-mode behaviour. When selectMode is on
// the entire row toggles selection instead of navigating; the avatar
// slot becomes a checkbox so the row's visual rhythm doesn't shift.
// Kept separate from ThreadRow so /today and /at-risk continue to use
// the simpler link row.
export function SelectableThreadRow({ row, selectMode, selected, onToggle }: SelectableThreadRowProps) {
  const risk = toDisplayRisk(row.riskLevel);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${row.preview}` : row.preview;
  const rightLabel =
    risk === "overdue"
      ? "overdue"
      : risk === "waiting"
        ? "waiting"
        : formatRelative(row.lastInboundAt ?? row.lastMessageAt);

  const inner = (
    <>
      {selectMode ? (
        <span
          aria-hidden
          className={`grid h-8 w-8 place-items-center rounded-full border ${selected ? "border-accent bg-accent text-white" : "border-hairline-strong bg-paper text-ink-3"}`}
        >
          {selected ? (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 8.5l3 3 7-7" />
            </svg>
          ) : null}
        </span>
      ) : (
        <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[12px] font-semibold text-white">
          {initials(row.personName)}
        </span>
      )}
      <span className="min-w-0">
        <span className="mb-1 flex items-baseline gap-[10px]">
          <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">{row.personName}</span>
          <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
            {PLATFORM_LABEL[row.platform]}
          </span>
        </span>
        <span className="block max-w-[52ch] truncate text-[14px] text-ink-3">{previewBody}</span>
      </span>
      <span className="flex items-center gap-[10px] font-mono text-[11px] tracking-[0.02em] text-ink-3">
        <span className={`h-[6px] w-[6px] rounded-full ${dotClass[risk]}`} aria-hidden />
        <span className={risk === "overdue" ? "font-medium text-risk-overdue" : undefined}>
          {rightLabel}
        </span>
      </span>
    </>
  );

  const className = `grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] transition-colors duration-calm last:border-b last:border-hairline ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`;

  if (selectMode) {
    return (
      <button
        type="button"
        className={`${className} text-left`}
        aria-pressed={selected}
        onClick={(event) => onToggle(row.id, { shiftKey: event.shiftKey })}
      >
        {inner}
      </button>
    );
  }

  return (
    <Link
      href={`/thread/${row.id}`}
      className={className}
      onClick={(event) => {
        // Cmd/Ctrl-click enters select mode without losing the inbox.
        // (Shift-click is reserved by the browser for "open in new
        //  window" on links and can't be reliably intercepted.)
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          onToggle(row.id, { shiftKey: event.shiftKey });
        }
      }}
    >
      {inner}
    </Link>
  );
}
