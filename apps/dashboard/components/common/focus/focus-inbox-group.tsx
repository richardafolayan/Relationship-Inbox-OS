"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Moon, Send } from "lucide-react";
import { formatRelative } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";
import { PersonAvatar } from "@/components/common/person-avatar";
import { isFocusAckCandidate, noteForRow } from "@/lib/focus";
import { sendAcknowledgement, useFocusWindow } from "@/lib/use-focus-window";
import type { InboxRow } from "@/lib/types";

function rowKey(row: InboxRow): string {
  return row.personId ?? row.id;
}

// The Inbox "During your focus block" group: covered threads that received an
// inbound since the window opened, each with a one-tap "Send quick note". Same
// eligibility helper as every other focus surface, so the sets never diverge.
export function FocusInboxGroup({
  rows,
  onChanged
}: {
  rows: InboxRow[];
  onChanged?: () => void;
}) {
  const { focusWindow, settings, templates, active, markAcked } = useFocusWindow();
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const candidates = useMemo(() => {
    if (!active) return [];
    return rows.filter(
      (row) => sent.has(rowKey(row)) || isFocusAckCandidate(row, focusWindow, settings)
    );
  }, [rows, focusWindow, settings, active, sent]);

  const send = useCallback(
    async (row: InboxRow) => {
      const key = rowKey(row);
      // Re-check at click time: the window can lapse between render and tap,
      // and a note promising "till X" must never go out after X.
      if (busyKey || !active) return;
      setBusyKey(key);
      try {
        await sendAcknowledgement(row.id, noteForRow(row, focusWindow, templates));
        await markAcked(row.personId);
        setSent((prev) => new Set(prev).add(key));
        onChanged?.();
      } catch {
        // Leave the row actionable for a retry.
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, active, focusWindow, templates, markAcked, onChanged]
  );

  if (!active || candidates.length === 0) return null;

  const waiting = candidates.filter((row) => !sent.has(rowKey(row))).length;

  return (
    <section className="mb-1">
      <div className="flex items-center gap-[10px] px-1 pb-[8px] pt-[16px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-accent-ink">
        <Moon className="h-[13px] w-[13px]" strokeWidth={1.7} />
        During your focus block
        <span className="ml-auto text-ink-4">
          {waiting === 0 ? "all acknowledged" : `${waiting} waiting`}
        </span>
      </div>
      {candidates.map((row) => {
        const key = rowKey(row);
        const isSent = sent.has(key);
        return (
          <Link
            key={key}
            href={`/thread/${row.id}`}
            className="grid grid-cols-[30px_1fr_auto] items-center gap-[14px] border-t border-hairline px-1 py-[12px] transition-colors duration-calm last:border-b last:border-hairline hover:bg-paper-2/40"
          >
            <PersonAvatar name={row.personName} avatarUrl={row.personAvatarUrl} size={30} />
            <div className="min-w-0">
              <div className="flex items-baseline gap-[10px]">
                <span className="shrink-0 text-[13.5px] font-medium text-ink">{row.personName}</span>
                <span className="shrink-0 rounded-[5px] bg-accent-soft px-[7px] py-[3px] font-mono text-[9px] uppercase tracking-[0.04em] text-accent-ink">
                  Arrived during focus
                </span>
              </div>
              <span className="block truncate text-[13px] text-ink-3">
                {normalizePreview(row.preview)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10.5px] text-ink-3">
                {formatRelative(row.lastInboundAt)}
              </span>
              {isSent ? (
                <span className="inline-flex items-center gap-[6px] rounded-pill px-[4px] py-[5px] text-[12px] text-risk-fresh">
                  <Check className="h-[13px] w-[13px]" strokeWidth={2} />
                  Note sent
                </span>
              ) : (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void send(row);
                  }}
                  disabled={busyKey === key}
                  className="inline-flex items-center gap-[6px] whitespace-nowrap rounded-pill border px-[12px] py-[5px] text-[12px] text-accent-ink transition-colors duration-calm hover:bg-accent-soft disabled:opacity-50"
                  style={{ borderColor: "color-mix(in srgb, var(--accent) 30%, transparent)" }}
                >
                  <Send className="h-[12px] w-[12px]" strokeWidth={1.7} />
                  {busyKey === key ? "Sending…" : "Send quick note"}
                </button>
              )}
            </div>
          </Link>
        );
      })}
    </section>
  );
}
