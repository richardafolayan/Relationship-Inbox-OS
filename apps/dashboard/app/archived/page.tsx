"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { InboxRow } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { PLATFORM_LABEL } from "@/lib/risk";
import { PersonAvatar } from "@/components/common/person-avatar";
import { normalizePreview } from "@/lib/preview";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { cn } from "@/lib/utils";

interface ArchivedResponse {
  rows: InboxRow[];
}

type ReasonFilter = "all" | "handled" | "snoozed" | "ghosted";

const REASON_FILTERS: { key: ReasonFilter; label: string }[] = [
  { key: "all", label: "any" },
  { key: "handled", label: "handled" },
  { key: "snoozed", label: "snoozed" },
  { key: "ghosted", label: "ghosted" }
];

function archiveReason(row: InboxRow): { key: ReasonFilter; label: string } {
  // Inferred from row signals: scheduledSendAt → snoozed; outbound-last → handled;
  // long inbound-pending with no further activity → ghosted; default → handled.
  if (row.scheduledSendAt) return { key: "snoozed", label: "snoozed · waiting on send" };
  if (row.lastMessageDirection === "OUT") return { key: "handled", label: "handled" };
  // Ghosted heuristic: archived but the last message was inbound and over
  // 30 days old when archived.
  if (row.archivedAt && row.lastInboundAt) {
    const archivedTs = Date.parse(row.archivedAt);
    const inboundTs = Date.parse(row.lastInboundAt);
    if (Number.isFinite(archivedTs) && Number.isFinite(inboundTs)) {
      const ageMs = archivedTs - inboundTs;
      if (ageMs > 30 * 86_400_000) {
        return { key: "ghosted", label: "ghosted · no reply" };
      }
    }
  }
  return { key: "handled", label: "handled" };
}

function monthKey(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return "unknown";
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function monthLabel(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return "Unknown";
  return new Date(ts).toLocaleDateString([], { month: "long", year: "numeric" });
}

// Archived - search-first, month-grouped rows. Each row carries its
// archive reason (handled / snoozed / ghosted) and a hover-only Restore
// affordance. Section 08 of the redesign doc.
export default function ArchivedPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState<ReasonFilter>("all");

  const refresh = useCallback(async () => {
    try {
      const response = await apiGet<ArchivedResponse>("/runner/data/archived");
      setRows(response.rows);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to load archived threads");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const r = archiveReason(row).key;
      if (reason !== "all" && r !== reason) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q) ||
        PLATFORM_LABEL[row.platform].includes(q)
      );
    });
  }, [rows, query, reason]);

  const monthly = useMemo(() => {
    const buckets = new Map<string, { label: string; rows: InboxRow[] }>();
    for (const row of visible) {
      const ts = row.archivedAt ?? row.lastMessageAt ?? "";
      const key = monthKey(ts);
      const bucket = buckets.get(key) ?? { label: monthLabel(ts), rows: [] };
      bucket.rows.push(row);
      buckets.set(key, bucket);
    }
    // Most recent month first
    return Array.from(buckets.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, value]) => ({ key, ...value }));
  }, [visible]);

  const oldestMonthLabel = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    let oldest = rows[0]!.archivedAt ?? rows[0]!.lastMessageAt ?? "";
    for (const row of rows) {
      const ts = row.archivedAt ?? row.lastMessageAt ?? "";
      if (ts && (!oldest || ts < oldest)) oldest = ts;
    }
    return monthLabel(oldest);
  }, [rows]);

  const isEmpty = !rows || rows.length === 0;

  return (
    <Canvas>
      <PageHead
        eyebrow="Done & dusted"
        title="Archived"
        meta={
          rows && rows.length > 0 ? (
            <span>
              <strong className="font-medium text-ink">{rows.length}</strong> threads
              {oldestMonthLabel ? (
                <>
                  <br />
                  oldest {oldestMonthLabel}
                </>
              ) : null}
            </span>
          ) : null
        }
      />

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {isEmpty ? (
        <CaughtUp title="No archived threads yet." body="Threads you mark as handled land here." />
      ) : (
        <>
          <div className="mb-[22px] flex flex-wrap items-center gap-[10px] rounded-[12px] border border-hairline px-4 py-[11px] text-ink-3">
            <Search className="h-[15px] w-[15px]" strokeWidth={1.6} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search archived threads by person, channel, or phrase…"
              className="flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
            />
            {REASON_FILTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setReason(entry.key)}
                className={cn(
                  "rounded-pill border px-[10px] py-[3px] font-mono text-[11px] transition-colors duration-calm",
                  reason === entry.key
                    ? "border-ink bg-ink text-paper"
                    : "border-hairline text-ink-3 hover:border-hairline-strong hover:text-ink"
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <CaughtUp
              title="Nothing matches that filter."
              body="Clear the filter or try a different phrase."
            />
          ) : (
            monthly.map((month) => (
              <section key={month.key} className="mb-[28px]">
                <header className="mb-[8px] flex items-baseline gap-[10px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
                  <span>{month.label}</span>
                  <span aria-hidden className="h-px flex-1 bg-hairline" />
                  <span>{month.rows.length} threads</span>
                </header>
                <div className="flex flex-col">
                  {month.rows.map((row) => (
                    <ArchivedRowItem
                      key={row.id}
                      row={row}
                      onOpen={() => router.push(`/thread/${row.id}`)}
                      onRestore={() =>
                        runAction(
                          apiPost(`/runner/control/thread/${row.id}/unarchive`, {}),
                          setError,
                          refresh
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </Canvas>
  );
}

interface ArchivedRowItemProps {
  row: InboxRow;
  onOpen: () => void;
  onRestore: () => void;
}

function ArchivedRowItem({ row, onOpen, onRestore }: ArchivedRowItemProps) {
  const reason = archiveReason(row);
  const when = formatRelative(row.archivedAt ?? row.lastMessageAt);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group grid grid-cols-[28px_1fr_auto_auto] items-center gap-[14px] border-b border-hairline px-1 py-[11px] text-left text-[13.5px] transition-colors duration-calm hover:bg-paper-2"
    >
      <PersonAvatar
        name={row.personName}
        avatarUrl={row.personAvatarUrl}
        size={28}
        className="text-[11px]"
      />
      <span className="min-w-0 truncate">
        <span className="font-medium text-ink">{row.personName}</span>
        <span className="ml-[10px] text-[12.5px] text-ink-3">{reason.label}</span>
      </span>
      <span className="font-mono text-[11px] text-ink-3">
        {when} · {PLATFORM_LABEL[row.platform]}
      </span>
      <span
        onClick={(event) => {
          event.stopPropagation();
          onRestore();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onRestore();
          }
        }}
        className="font-mono text-[11px] text-ink-4 opacity-0 transition-opacity duration-calm hover:text-accent-ink group-hover:opacity-100 group-focus:opacity-100"
      >
        restore ↑
      </span>
    </button>
  );
}
