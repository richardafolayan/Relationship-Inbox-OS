"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

type ReadFilter = "all" | "unread" | "read";
type CategoryFilter = "all" | "genuine" | "outreach";

// All inbox — same chrome as Today, body bucketed by risk. The runner's
// /data/inbox already returns the rows pre-sorted; we just split them
// into three sections and skip empty buckets. Filters apply BEFORE
// bucketing so an empty section stays hidden.
export default function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

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

  const rows = data?.rows ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (hiddenIds.has(row.id)) return false;
      if (readFilter === "unread" && row.unreadCount <= 0) return false;
      if (readFilter === "read" && row.unreadCount > 0) return false;
      if (categoryFilter !== "all") {
        if ((row.category ?? "").toLowerCase() !== categoryFilter) return false;
      }
      if (q) {
        const haystack = `${row.personName} ${row.preview} ${row.platform}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [rows, query, readFilter, categoryFilter, hiddenIds]);

  const overdue = useMemo(() => filtered.filter((r) => r.riskLevel === "RED"), [filtered]);
  const waiting = useMemo(() => filtered.filter((r) => r.riskLevel === "AMBER"), [filtered]);
  const fresh = useMemo(() => filtered.filter((r) => r.riskLevel === "GREEN"), [filtered]);

  const buckets = [
    { key: "overdue", label: "Overdue — they’ve waited longest", items: overdue },
    { key: "waiting", label: "Waiting on you", items: waiting },
    { key: "fresh", label: "Fresh, no rush", items: fresh }
  ];
  const degraded = platforms.find((p) => p.status === "DEGRADED");

  const handleArchive = useCallback(
    (row: InboxRow) => {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.add(row.id);
        return next;
      });
      runAction(apiPost(`/runner/control/thread/${row.id}/archive`, {}), setError, refresh);
    },
    [refresh]
  );

  const handleMarkDone = useCallback(
    (row: InboxRow) => {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.add(row.id);
        return next;
      });
      runAction(apiPost(`/runner/control/thread/${row.id}/mark-done`, {}), setError, refresh);
    },
    [refresh]
  );

  return (
    <Canvas>
      <PageHead
        eyebrow="All conversations"
        title="Inbox."
        meta={
          <span>
            {filtered.length}
            {filtered.length !== rows.length ? ` of ${rows.length}` : ""} threads
          </span>
        }
      />

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

      {/* Inbox-local refinement strip. Mono caption styling matches the
          rest of the redesign — hairline borders, low contrast, no shouty
          colors. Each control filters BEFORE bucketing. */}
      {loaded && rows.length ? (
        <div className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-hairline px-1 py-3">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter visible threads…"
            className="min-w-[220px] flex-1 bg-transparent font-mono text-[12px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <FilterToggle<ReadFilter>
            value={readFilter}
            onChange={setReadFilter}
            options={[
              { value: "all", label: "all" },
              { value: "unread", label: "unread" },
              { value: "read", label: "read" }
            ]}
          />
          <FilterToggle<CategoryFilter>
            value={categoryFilter}
            onChange={setCategoryFilter}
            options={[
              { value: "all", label: "all" },
              { value: "genuine", label: "genuine" },
              { value: "outreach", label: "outreach" }
            ]}
          />
        </div>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <CaughtUp title="You’re caught up." body="No conversations need you right now." />
      ) : filtered.length === 0 ? (
        <CaughtUp title="Nothing matches." body="Try clearing the filter above." />
      ) : (
        buckets.map((bucket) =>
          bucket.items.length ? (
            <section key={bucket.key}>
              <SectionDivider label={bucket.label} />
              <div className="flex flex-col">
                {bucket.items.map((row) => (
                  <ThreadRow
                    key={row.id}
                    row={row}
                    onArchive={handleArchive}
                    onMarkDone={handleMarkDone}
                  />
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

interface FilterToggleProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}

// Triple-state toggle rendered as `all · unread · read`. Active value is
// inked, others sit at ink-3. Dots are literal middle dots.
function FilterToggle<T extends string>({ value, onChange, options }: FilterToggleProps<T>) {
  return (
    <div className="flex items-center gap-[6px] font-mono text-[11px] tracking-[0.02em]">
      {options.map((option, index) => (
        <span key={option.value} className="flex items-center gap-[6px]">
          {index > 0 ? <span className="text-ink-3" aria-hidden>·</span> : null}
          <button
            type="button"
            onClick={() => onChange(option.value)}
            className={
              option.value === value
                ? "text-ink"
                : "text-ink-3 transition-colors hover:text-ink"
            }
          >
            {option.label}
          </button>
        </span>
      ))}
    </div>
  );
}
