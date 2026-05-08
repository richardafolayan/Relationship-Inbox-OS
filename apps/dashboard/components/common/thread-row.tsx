"use client";

import Link from "next/link";
import type { InboxRow } from "@/lib/types";
import { PLATFORM_LABEL, initials, toDisplayRisk, avatarTone, type DisplayRisk } from "@/lib/risk";
import { formatRelative } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";

interface ThreadRowProps {
  row: InboxRow;
}

const riskTextClass: Record<DisplayRisk, string> = {
  overdue: "text-risk-overdue font-medium",
  waiting: "text-risk-waiting font-medium",
  fresh: "text-ink-2"
};

export function ThreadRow({ row }: ThreadRowProps) {
  const risk = toDisplayRisk(row.riskLevel);
  const cleanPreview = normalizePreview(row.preview);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${cleanPreview}` : cleanPreview;
  const rightLabel =
    risk === "overdue"
      ? "Overdue"
      : risk === "waiting"
        ? "Waiting"
        : formatRelative(row.lastInboundAt ?? row.lastMessageAt);

  return (
    <Link
      href={`/thread/${row.id}`}
      className="grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] transition-colors duration-calm last:border-b last:border-hairline hover:bg-paper-2"
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-full font-display text-[12px] font-semibold text-white"
        style={{ background: avatarTone(row.personName) }}
      >
        {initials(row.personName)}
      </span>
      <span className="min-w-0">
        <span className="mb-1 flex items-baseline gap-[10px]">
          <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">{row.personName}</span>
          <span className="rounded bg-paper-2 px-[6px] py-[1px] text-[10px] font-medium uppercase tracking-[0.04em] text-ink-2">
            {PLATFORM_LABEL[row.platform]}
          </span>
        </span>
        <span className="block max-w-[52ch] truncate text-[14px] text-ink-2">{previewBody}</span>
      </span>
      <span className={`text-[12px] tracking-[-0.005em] ${riskTextClass[risk]}`}>
        {rightLabel}
      </span>
    </Link>
  );
}
