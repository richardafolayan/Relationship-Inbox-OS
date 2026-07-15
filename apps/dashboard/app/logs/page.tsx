"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { AuditLogRow } from "@/lib/types";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

// Activity - receipts list. The redesign drops the per-row "OK -" outcome
// column entirely: success is a tiny green tick at the start, only
// errors get a colour. Identical events that arrive back-to-back collapse
// into a single "{N} events · start → end pairs" row that can be expanded.
// Timestamps left-align in a fixed 80px column for scannability.

function prettyAction(action: string): string {
  let label = action.replace(/^(POST|GET|PUT|DELETE|PATCH)_/, "");
  label = label.replace(/_(PERSONID|THREADID|JOBID|REQUESTID)(?=_|$)/g, "");
  return label
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function platformLabel(platform: string | undefined): string {
  if (!platform) return "";
  switch (platform) {
    case "LINKEDIN":
      return "linkedin";
    case "IMESSAGE":
      return "imessage";
    case "INSTAGRAM":
      return "instagram";
    case "TIKTOK":
      return "tiktok";
    case "GOOGLE_MESSAGES":
      return "google messages";
    default:
      return platform.toLowerCase();
  }
}

function formatRelativeAbs(timestamp: string): { rel: string; abs: string } {
  const ts = Date.parse(timestamp);
  const abs = Number.isFinite(ts) ? new Date(ts).toLocaleString() : timestamp;
  if (!Number.isFinite(ts)) return { rel: timestamp, abs };
  const diffMs = Date.now() - ts;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { rel: `${seconds}s ago`, abs };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { rel: `${minutes}m ago`, abs };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { rel: `${hours}h ago`, abs };
  // Yesterday / older: render the wall-clock time only, the date is in
  // the day divider above.
  return {
    rel: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    abs
  };
}

function dayKey(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return "unknown";
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dayLabel(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return "Unknown";
  const date = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const candidate = new Date(date);
  candidate.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - candidate.getTime()) / 86_400_000);
  const month = candidate.toLocaleDateString([], { month: "long" });
  const day = candidate.getDate();
  if (diffDays === 0) return `Today · ${month} ${day}`;
  if (diffDays === 1) return `Yesterday · ${month} ${day}`;
  return candidate.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
}

interface DisplayRow {
  kind: "single";
  log: AuditLogRow;
}

interface GroupRow {
  kind: "group";
  baseAction: string;
  rows: AuditLogRow[];
  representative: AuditLogRow;
}

type Row = DisplayRow | GroupRow;

// Collapse runs of the same OK action into a single row when there are
// 3+ in a row. Failures always render individually so the operator can
// inspect them. Maintains chronological order within each day.
function collapseRuns(logs: AuditLogRow[]): Row[] {
  const out: Row[] = [];
  let i = 0;
  while (i < logs.length) {
    const log = logs[i]!;
    if (log.status !== "OK") {
      out.push({ kind: "single", log });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (
      j < logs.length &&
      logs[j]!.status === "OK" &&
      prettyAction(logs[j]!.action) === prettyAction(log.action)
    ) {
      j += 1;
    }
    const span = logs.slice(i, j);
    if (span.length >= 3) {
      out.push({ kind: "group", baseAction: prettyAction(log.action), rows: span, representative: log });
    } else {
      for (const item of span) {
        out.push({ kind: "single", log: item });
      }
    }
    i = j;
  }
  return out;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const rows = await apiGet<AuditLogRow[]>("/runner/data/logs?limit=300").catch(
      () => [] as AuditLogRow[]
    );
    setLogs(rows);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  // Group rows by day, then collapse runs within each day. Yields a flat
  // list of (day-label, rows[]) pairs in reverse-chronological order.
  const dayGroups = useMemo(() => {
    const grouped = new Map<string, AuditLogRow[]>();
    for (const log of logs) {
      const key = dayKey(log.timestamp);
      const bucket = grouped.get(key) ?? [];
      bucket.push(log);
      grouped.set(key, bucket);
    }
    return Array.from(grouped.entries()).map(([key, bucket]) => ({
      key,
      label: dayLabel(bucket[0]?.timestamp ?? ""),
      rows: collapseRuns(bucket)
    }));
  }, [logs]);

  const toggleGroup = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Canvas>
      <PageHead
        eyebrow="Receipts"
        title="Activity"
        meta={
          <span>
            <strong className="font-medium text-ink">{logs.length}</strong> events ·{" "}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="hover:text-ink"
            >
              open drawer
            </button>
          </span>
        }
      />

      {logs.length === 0 ? (
        <CaughtUp title="Nothing logged yet." body="Every scan, send, and selector check will appear here." />
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-hairline">
          {dayGroups.map((day) => (
            <div key={day.key}>
              <div className="border-b border-hairline bg-paper-2 px-[18px] py-[8px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                {day.label}
              </div>
              {day.rows.map((row, idx) =>
                row.kind === "single" ? (
                  <ActivityRow
                    key={row.log.id}
                    log={row.log}
                    isLast={idx === day.rows.length - 1}
                  />
                ) : (
                  <GroupSummary
                    key={row.representative.id}
                    group={row}
                    expanded={expanded.has(row.representative.id)}
                    onToggle={() => toggleGroup(row.representative.id)}
                    isLast={idx === day.rows.length - 1}
                  />
                )
              )}
            </div>
          ))}
        </div>
      )}

      <ReceiptsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        rows={logs}
        title="System receipts"
      />
    </Canvas>
  );
}

function ActivityRow({ log, isLast }: { log: AuditLogRow; isLast: boolean }) {
  const isFail = log.status !== "OK";
  const { rel, abs } = formatRelativeAbs(log.timestamp);
  const meta = [platformLabel(log.platform), log.stage ?? null].filter(Boolean).join(" · ");
  return (
    <div
      className={`grid grid-cols-[80px_1fr_auto] items-center gap-4 px-[18px] py-[10px] text-[13px] ${
        isLast ? "" : "border-b border-hairline"
      } cursor-default hover:bg-paper-2`}
    >
      <span title={abs} className="font-mono text-[11px] text-ink-3">
        {rel}
      </span>
      <div className="flex min-w-0 items-center gap-[10px]">
        <span
          aria-hidden
          className={`grid h-[14px] w-[14px] place-items-center ${
            isFail ? "text-risk-overdue" : "text-risk-fresh"
          }`}
        >
          {isFail ? <Clock className="h-[12px] w-[12px]" strokeWidth={2} /> : <Check className="h-[12px] w-[12px]" strokeWidth={2.4} />}
        </span>
        <span
          className={`truncate ${isFail ? "text-risk-overdue" : "text-ink"}`}
          title={log.action}
        >
          {prettyAction(log.action)}
        </span>
      </div>
      <span
        className={`font-mono text-[10.5px] tracking-[0.02em] ${
          isFail ? "text-risk-overdue" : "text-ink-3"
        }`}
      >
        {meta || "general"}
      </span>
    </div>
  );
}

function GroupSummary({
  group,
  expanded,
  onToggle,
  isLast
}: {
  group: GroupRow;
  expanded: boolean;
  onToggle: () => void;
  isLast: boolean;
}) {
  const first = group.rows[0]!;
  const { rel } = formatRelativeAbs(first.timestamp);
  return (
    <>
      <div
        className={`grid cursor-default grid-cols-[80px_1fr_auto] items-center gap-4 px-[18px] py-[10px] text-[13px] ${
          isLast && !expanded ? "" : "border-b border-hairline"
        } hover:bg-paper-2`}
      >
        <span className="font-mono text-[11px] text-ink-3">{rel}</span>
        <div className="flex min-w-0 items-center gap-[10px]">
          <span aria-hidden className="grid h-[14px] w-[14px] place-items-center text-risk-fresh">
            <Check className="h-[12px] w-[12px]" strokeWidth={2.4} />
          </span>
          <span className="truncate text-ink">{group.baseAction}</span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="font-mono text-[10.5px] tracking-[0.02em] text-ink-3 hover:text-ink"
        >
          {group.rows.length} events · expand {expanded ? "▴" : "▾"}
        </button>
      </div>
      {expanded
        ? group.rows.map((log, i) => (
            <ActivityRow
              key={log.id}
              log={log}
              isLast={isLast && i === group.rows.length - 1}
            />
          ))
        : null}
    </>
  );
}
