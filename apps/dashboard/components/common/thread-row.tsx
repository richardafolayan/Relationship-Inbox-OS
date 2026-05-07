"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import type { InboxRow } from "@/lib/types";
import { PLATFORM_LABEL, initials, toDisplayRisk, type DisplayRisk } from "@/lib/risk";
import { formatRelative } from "@/lib/time";

interface ThreadRowProps {
  row: InboxRow;
  onArchive?: (row: InboxRow) => void;
  onMarkDone?: (row: InboxRow) => void;
}

const dotClass: Record<DisplayRisk, string> = {
  overdue: "bg-risk-overdue",
  waiting: "bg-risk-waiting",
  fresh: "bg-risk-fresh"
};

// Single canonical row used on Today / Inbox / At-Risk. 32px avatar,
// stacked name + preview, right-aligned risk dot + label. Whole row links
// into the thread. Hover deepens the background to paper-2 and reveals
// optional inline actions (archive / mark done).
export function ThreadRow({ row, onArchive, onMarkDone }: ThreadRowProps) {
  const risk = toDisplayRisk(row.riskLevel);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${row.preview}` : row.preview;
  const rightLabel =
    risk === "overdue"
      ? "overdue"
      : risk === "waiting"
        ? "waiting"
        : formatRelative(row.lastInboundAt ?? row.lastMessageAt);

  const category = row.category?.toLowerCase();
  const categoryLabel =
    category === "genuine" ? "genuine" : category === "outreach" ? "outreach" : null;
  const needsReply =
    row.lastMessageDirection === "IN" && row.unreadCount > 0 && !row.archivedAt;

  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Link
      href={`/thread/${row.id}`}
      className="group relative grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] transition-colors duration-calm last:border-b last:border-hairline hover:bg-paper-2"
    >
      <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[12px] font-semibold text-white">
        {initials(row.personName)}
      </span>
      <span className="min-w-0">
        <span className="mb-1 flex items-baseline gap-[10px]">
          <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">{row.personName}</span>
          <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
            {PLATFORM_LABEL[row.platform]}
          </span>
          {categoryLabel ? (
            <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
              · {categoryLabel}
            </span>
          ) : null}
          {needsReply ? (
            <span className="font-mono text-[11px] tracking-[0.02em] text-risk-overdue">
              · needs reply
            </span>
          ) : null}
        </span>
        <span className="block max-w-[52ch] truncate text-[14px] text-ink-3">{previewBody}</span>
      </span>
      <span className="flex items-center gap-[10px] font-mono text-[11px] tracking-[0.02em] text-ink-3">
        {(onArchive || onMarkDone) ? (
          <span className="hidden items-center gap-[10px] group-hover:flex">
            {onArchive ? (
              <button
                type="button"
                onClick={(event) => {
                  stop(event);
                  onArchive(row);
                }}
                className="font-mono text-[11px] tracking-[0.02em] text-ink-3 transition-colors hover:text-ink"
              >
                archive
              </button>
            ) : null}
            {onMarkDone ? (
              <button
                type="button"
                onClick={(event) => {
                  stop(event);
                  onMarkDone(row);
                }}
                className="font-mono text-[11px] tracking-[0.02em] text-ink-3 transition-colors hover:text-ink"
              >
                mark done
              </button>
            ) : null}
            <span className="h-3 w-px bg-hairline" aria-hidden />
          </span>
        ) : null}
        <span className={`h-[6px] w-[6px] rounded-full ${dotClass[risk]}`} aria-hidden />
        <span className={risk === "overdue" ? "font-medium text-risk-overdue" : undefined}>
          {rightLabel}
        </span>
      </span>
    </Link>
  );
}
