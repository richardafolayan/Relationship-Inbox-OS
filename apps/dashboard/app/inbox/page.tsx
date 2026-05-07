"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

type FilterMode = "all" | "unread" | "needs_reply" | "genuine";

const FILTERS: { key: FilterMode; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "needs_reply", label: "Needs reply" },
  { key: "genuine", label: "Genuine" }
];

function applyFilter(row: InboxRow, mode: FilterMode): boolean {
  switch (mode) {
    case "unread":
      return row.unreadCount > 0;
    case "needs_reply":
      return row.needsReply;
    case "genuine":
      return row.category === "genuine";
    default:
      return true;
  }
}

export default function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");

  const refresh = useCallback(async () => {
    const [inbox, platformRows, logRows] = await Promise.all([
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => []),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=100").catch(() => [])
    ]);
    if (inbox) setData(inbox);
    setPlatforms(platformRows ?? []);
    setLogs(logRows ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      window.removeEventListener("runner-resync", onResync);
      clearInterval(timer);
    };
  }, [refresh]);

  const allRows = data?.rows ?? [];
  const summary = data?.summary;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((row) => {
      if (!applyFilter(row, filter)) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [allRows, query, filter]);

  const overdue = useMemo(() => visible.filter((r) => r.riskLevel === "RED"), [visible]);
  const waiting = useMemo(() => visible.filter((r) => r.riskLevel === "AMBER"), [visible]);
  const fresh = useMemo(() => visible.filter((r) => r.riskLevel === "GREEN"), [visible]);

  const buckets = [
    { key: "overdue", label: "Overdue — they’ve waited longest", items: overdue },
    { key: "waiting", label: "Waiting on you", items: waiting },
    { key: "fresh", label: "Fresh, no rush", items: fresh }
  ];
  const degraded = platforms.find((p) => p.status === "DEGRADED");
  const oldestPending = summary?.oldestPendingInboundAt
    ? formatRelative(summary.oldestPendingInboundAt)
    : "—";

  return (
    <Canvas>
      <PageHead
        eyebrow="All conversations"
        title="Inbox"
        subtitle="Every active thread, sectioned by urgency. Search and filter to find one fast."
        meta={<span>{visible.length} of {allRows.length} threads</span>}
      />

      {summary ? (
        <div className="mb-6 grid grid-cols-3 gap-3">
          <KpiTile label="Unread" value={summary.unreadThreads} />
          <KpiTile label="At risk" value={summary.atRiskThreads} tone={summary.atRiskThreads > 0 ? "warn" : "ok"} />
          <KpiTile label="Oldest pending inbound" value={oldestPending} small />
        </div>
      ) : null}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="relative flex min-w-0 flex-1 items-center">
          <Search className="absolute left-3 h-[14px] w-[14px] text-ink-3" strokeWidth={1.6} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people, keywords…"
            className="w-full rounded-[10px] border border-hairline bg-paper py-[8px] pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
          />
        </label>
        <div className="flex shrink-0 rounded-[10px] border border-hairline bg-paper p-[2px]">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-[8px] px-3 py-[6px] text-[12px] tracking-[-0.005em] transition-colors duration-calm",
                filter === f.key ? "bg-ink text-paper font-medium" : "text-ink-2 hover:text-ink"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {degraded ? (
        <DegradedBanner
          platform={degraded.platform}
          stage={degraded.lastScanFailure?.stage}
          reason={degraded.lastScanFailure?.reason}
          requestId={degraded.lastScanFailure?.requestId}
          errorSummary={degraded.lastScanFailure?.errorSummary ?? degraded.lastError ?? undefined}
          screenshotFile={degraded.lastScanFailure?.screenshotFile}
          domDumpFile={
            degraded.lastScanFailure?.domDumpFile ??
            logs.find((log) => log.platform === degraded.platform && log.domDumpFile)?.domDumpFile
          }
          onRunSelectorTests={() =>
            runAction(
              apiPost("/runner/control/platform/test-selectors", { platform: degraded.platform }),
              setError,
              refresh
            )
          }
          onOpenReceipts={() => setReceiptsOpen(true)}
        />
      ) : null}

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : visible.length === 0 ? (
        <CaughtUp
          title={query || filter !== "all" ? "Nothing matches that filter." : "You’re caught up."}
          body={query || filter !== "all" ? "Clear the filter or try a different search." : "No conversations need you right now."}
        />
      ) : (
        buckets.map((bucket) =>
          bucket.items.length ? (
            <section key={bucket.key}>
              <SectionDivider label={bucket.label} />
              <div className="flex flex-col">
                {bucket.items.map((row) => (
                  <ThreadRow key={row.id} row={row} />
                ))}
              </div>
            </section>
          ) : null
        )
      )}

      <ReceiptsDrawer
        open={receiptsOpen}
        onClose={() => setReceiptsOpen(false)}
        rows={logs}
        title="Inbox receipts"
      />
    </Canvas>
  );
}

function KpiTile({
  label,
  value,
  small,
  tone = "ok"
}: {
  label: string;
  value: number | string;
  small?: boolean;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="rounded-card border border-hairline bg-paper px-4 py-3">
      <p className="m-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{label}</p>
      <p
        className={cn(
          "m-0 mt-[2px] font-display font-semibold tracking-[-0.02em]",
          small ? "text-[18px]" : "text-[26px]",
          tone === "warn" ? "text-risk-overdue" : "text-ink"
        )}
      >
        {value}
      </p>
    </div>
  );
}
