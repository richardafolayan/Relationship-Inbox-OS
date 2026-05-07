"use client";

import Link from "next/link";
import type { InboxRow } from "@/lib/types";
import { PLATFORM_LABEL, initials, toDisplayRisk, type DisplayRisk } from "@/lib/risk";
import { formatRelative } from "@/lib/time";

interface ThreadRowProps {
  row: InboxRow;
}

const dotClass: Record<DisplayRisk, string> = {
  overdue: "bg-risk-overdue",
  waiting: "bg-risk-waiting",
  fresh: "bg-risk-fresh"
};

// Single canonical row used on Today / Inbox / At-Risk. 32px avatar,
// stacked name + preview, right-aligned risk dot + label. Whole row links
// into the thread. Hover deepens the background to paper-2.
export function ThreadRow({ row }: ThreadRowProps) {
  const risk = toDisplayRisk(row.riskLevel);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${row.preview}` : row.preview;
  const showCountdown =
    (risk === "overdue" || risk === "waiting") &&
    row.slaCountdown &&
    row.slaCountdown !== "No SLA";
  const rightLabel = showCountdown
    ? row.slaCountdown
    : risk === "overdue"
      ? "overdue"
      : risk === "waiting"
        ? "waiting"
        : formatRelative(row.lastInboundAt ?? row.lastMessageAt);

  return (
    <Link
      href={`/thread/${row.id}`}
      className="grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] transition-colors duration-calm last:border-b last:border-hairline hover:bg-paper-2"
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
        </span>
        <span className="block max-w-[52ch] truncate text-[14px] text-ink-3">{previewBody}</span>
      </span>
      <span className="flex items-center gap-[10px] font-mono text-[11px] tracking-[0.02em] text-ink-3">
        <span className={`h-[6px] w-[6px] rounded-full ${dotClass[risk]}`} aria-hidden />
        <span className={risk === "overdue" ? "font-medium text-risk-overdue" : undefined}>
          {rightLabel}
        </span>
      </span>
    </Link>
  );
}
