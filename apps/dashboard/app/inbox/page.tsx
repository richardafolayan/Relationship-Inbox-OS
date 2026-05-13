"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { apiGet, apiPost, runAction, ApiRequestError } from "@/lib/api";
import { runActionWithFeedback } from "@/lib/feedback";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { SelectableThreadRow } from "@/components/common/selectable-thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

type FilterMode = "all" | "unread" | "needs_reply" | "waiting_on_them" | "genuine" | "outreach";
type PlatformFilter = "all" | "LINKEDIN" | "IMESSAGE";
type SortMode = "recent" | "oldest" | "name";

const FILTERS: { key: FilterMode; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "needs_reply", label: "Needs reply" },
  { key: "waiting_on_them", label: "Waiting on them" },
  { key: "genuine", label: "Genuine" },
  { key: "outreach", label: "Outreach" }
];

const PLATFORM_FILTERS: { key: PlatformFilter; label: string }[] = [
  { key: "all", label: "All platforms" },
  { key: "LINKEDIN", label: "LinkedIn" },
  { key: "IMESSAGE", label: "iMessage" }
];

const SORT_MODES: { key: SortMode; label: string }[] = [
  { key: "recent", label: "Recent first" },
  { key: "oldest", label: "Oldest first" },
  { key: "name", label: "By name (A-Z)" }
];

function applyFilter(row: InboxRow, mode: FilterMode): boolean {
  switch (mode) {
    case "unread":
      return row.unreadCount > 0;
    case "needs_reply":
      return row.needsReply;
    case "waiting_on_them":
      // Operator sent the last message and the other party hasn't replied
      // yet. Excludes archived rows so closed-out conversations don't pile
      // into the "I'm waiting on them" surface.
      return row.lastMessageDirection === "OUT" && !row.archivedAt;
    case "genuine":
      return row.category === "genuine";
    case "outreach":
      return row.category === "outreach";
    default:
      return true;
  }
}

function applyPlatformFilter(row: InboxRow, platform: PlatformFilter): boolean {
  if (platform === "all") return true;
  return row.platform === platform;
}

function applySort(items: InboxRow[], sort: SortMode): InboxRow[] {
  // Defensive copy: caller's buckets are useMemo'd; mutating in place
  // would trip the "did this change?" check on the next render.
  const copy = [...items];
  switch (sort) {
    case "oldest":
      return copy.sort((a, b) => {
        const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        return aTs - bTs;
      });
    case "name":
      return copy.sort((a, b) => a.personName.localeCompare(b.personName));
    case "recent":
    default:
      return copy.sort((a, b) => {
        const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        return bTs - aTs;
      });
  }
}

// All inbox - same chrome as Today, body bucketed by risk. The runner's
// /data/inbox already returns the rows pre-sorted; we just split them
// into three sections and skip empty buckets. Search + status filter +
// platform filter narrow the visible set before bucketing.
//
// Multi-select: cmd/ctrl-click any row to enter select mode and toggle
// selection (or use the explicit Select button). While ≥1 row is
// selected, a sticky bottom action bar surfaces bulk Mark done / Snooze
// / Rescan / Clear. Esc clears selection. Cmd/Ctrl+A selects all
// currently-visible rows (post-filter).
export default function InboxPage() {
  // Next.js requires useSearchParams consumers to sit under a Suspense
  // boundary so the static prerender doesn't error on /inbox.
  return (
    <Suspense fallback={null}>
      <InboxPageContent />
    </Suspense>
  );
}

function InboxPageContent() {
  const searchParams = useSearchParams();
  // Inbound deep-links from other pages:
  //   /inbox?q=<text>      pre-fills the search box (used by the thread
  //                        participant popover to look up other 1:1 threads).
  //   /inbox?person=<id>   filters to threads belonging to a single person
  //                        (used by the people list "open in inbox" link).
  // Both URLs were silently no-ops before this page started reading the
  // query string.
  const initialQuery = searchParams?.get("q") ?? "";
  const initialPersonId = searchParams?.get("person") ?? null;

  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [personFilter, setPersonFilter] = useState<string | null>(initialPersonId);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  // Multi-select state. selectedIds preserves insertion order so
  // shift-click range can find the anchor (last selected) deterministically.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Toggle to put the row list into checkbox-and-toggle mode without
  // requiring a modifier-click; useful when discovering the feature.
  const [forceSelectMode, setForceSelectMode] = useState(false);
  const lastToggledRef = useRef<string | null>(null);
  // Removed-locally so bulk actions feel instant; reconciled against
  // server data on the next refresh, mirroring /today.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [inbox, platformRows, logRows] = await Promise.all([
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => []),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=100").catch(() => [])
    ]);
    if (inbox) {
      setData(inbox);
      // Drop optimistic IDs the server has caught up on (same logic as /today).
      const stillPending = new Set(
        inbox.rows.filter((row) => row.needsReply !== false).map((row) => row.id)
      );
      setRemovedIds((prev) => {
        const next = new Set<string>();
        prev.forEach((id) => {
          if (stillPending.has(id)) next.add(id);
        });
        return next;
      });
    }
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

  // Filter chain: query + status + platform produce `visible`; bulk
  // optimistic-removal further narrows to `rows`. Buckets, flatVisibleIds,
  // and select-all all derive from `rows` so selection respects both
  // filters and in-flight bulk actions. Empty-state detection uses
  // `visible` (not `rows`) so a mid-flight bulk removal doesn't briefly
  // flip the page to "Nothing matches".
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((row) => {
      // Person-filter from /inbox?person=<id> takes precedence over other
      // filters so a deep-link from the People list shows exactly that
      // person's threads. The filter chip can be cleared in the UI to fall
      // back to normal filtering.
      if (personFilter && row.personId !== personFilter) return false;
      if (!applyPlatformFilter(row, platformFilter)) return false;
      if (!applyFilter(row, filter)) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [allRows, query, filter, platformFilter, personFilter]);

  const personFilterName = useMemo(() => {
    if (!personFilter) return null;
    return allRows.find((row) => row.personId === personFilter)?.personName ?? null;
  }, [allRows, personFilter]);

  const rows = useMemo(
    () => visible.filter((row) => !removedIds.has(row.id)),
    [visible, removedIds]
  );
  const overdue = useMemo(
    () => applySort(rows.filter((r) => r.riskLevel === "RED"), sortMode),
    [rows, sortMode]
  );
  const waiting = useMemo(
    () => applySort(rows.filter((r) => r.riskLevel === "AMBER"), sortMode),
    [rows, sortMode]
  );
  const fresh = useMemo(
    () => applySort(rows.filter((r) => r.riskLevel === "GREEN"), sortMode),
    [rows, sortMode]
  );

  const buckets = [
    { key: "overdue", label: "Overdue - they’ve waited longest", items: overdue },
    { key: "waiting", label: "Waiting on you", items: waiting },
    { key: "fresh", label: "Fresh, no rush", items: fresh }
  ];
  const degraded = platforms.find((p) => p.status === "DEGRADED");
  const oldestPending = summary?.oldestPendingInboundAt
    ? formatRelative(summary.oldestPendingInboundAt)
    : "-";

  const flatVisibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectMode = forceSelectMode || selectedIds.length > 0;

  const toggleId = useCallback(
    (id: string, opts: { shiftKey: boolean }) => {
      setSelectedIds((prev) => {
        const set = new Set(prev);
        if (opts.shiftKey && lastToggledRef.current && lastToggledRef.current !== id) {
          // Range select between anchor and target on the visible flat list.
          const anchor = lastToggledRef.current;
          const a = flatVisibleIds.indexOf(anchor);
          const b = flatVisibleIds.indexOf(id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (const rangeId of flatVisibleIds.slice(lo, hi + 1)) set.add(rangeId);
            lastToggledRef.current = id;
            return Array.from(set);
          }
        }
        if (set.has(id)) {
          set.delete(id);
        } else {
          set.add(id);
        }
        lastToggledRef.current = id;
        return Array.from(set);
      });
    },
    [flatVisibleIds]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setForceSelectMode(false);
    lastToggledRef.current = null;
  }, []);

  // ⌘A / ctrl-A selects all visible rows when in select mode; Esc clears.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectMode) {
        clearSelection();
        return;
      }
      if (selectMode && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(flatVisibleIds);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, flatVisibleIds, clearSelection]);

  const [archivingOutreach, setArchivingOutreach] = useState(false);

  const archiveAllOutreach = useCallback(async () => {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Archive ${ids.length} outreach thread${ids.length === 1 ? "" : "s"}? You can unarchive any of them from the Archived view.`
    );
    if (!ok) return;
    setArchivingOutreach(true);
    setRemovedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    const results = await Promise.allSettled(
      ids.map((id) => apiPost(`/runner/control/thread/${id}/archive`, {}))
    );
    const failedIds = new Set<string>(
      results.flatMap((r, idx) =>
        r.status === "rejected" && ids[idx] !== undefined ? [ids[idx] as string] : []
      )
    );
    if (failedIds.size > 0) {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        failedIds.forEach((id) => next.delete(id));
        return next;
      });
    }
    setArchivingOutreach(false);
    void refresh();
  }, [rows, refresh]);

  const runBulk = useCallback(
    async (
      label: string,
      buildPath: (id: string) => string,
      body: Record<string, unknown> = {}
    ) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      setBulkPending(label);
      setBulkResult(null);
      // Optimistically hide the affected rows.
      setRemovedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.add(id));
        return next;
      });
      const results = await Promise.allSettled(
        ids.map((id) => apiPost(buildPath(id), body))
      );
      const failed = results.filter((r) => r.status === "rejected");
      const succeeded = ids.length - failed.length;
      if (failed.length > 0) {
        // Restore the failed ids to the visible list.
        // Map each rejected result back to its source id by sharing the
        // index between `results` and `ids` (Promise.allSettled preserves
        // input order). The original implementation used findIndex on
        // `results`, which only ever found the first rejection and so
        // mis-restored ids when ≥2 calls failed.
        const failedIds = new Set<string>(
          results.flatMap((r, idx) =>
            r.status === "rejected" && ids[idx] !== undefined ? [ids[idx] as string] : []
          )
        );
        setRemovedIds((prev) => {
          const next = new Set(prev);
          failedIds.forEach((id) => next.delete(id));
          return next;
        });
        const firstReason = failed
          .map((f) => (f.status === "rejected" ? (f.reason as Error | ApiRequestError) : null))
          .find(Boolean);
        const reasonMsg = firstReason instanceof Error ? firstReason.message : "Unknown";
        setBulkResult(`${label}: ${succeeded} ok, ${failed.length} failed (${reasonMsg})`);
      } else {
        setBulkResult(`${label}: ${succeeded} of ${ids.length}`);
      }
      setBulkPending(null);
      clearSelection();
      void refresh();
    },
    [selectedIds, clearSelection, refresh]
  );

  return (
    <Canvas>
      <PageHead
        eyebrow="All conversations"
        title="Inbox"
        subtitle="Every active thread, sectioned by urgency. Search and filter to find one fast."
        meta={
          selectMode ? (
            <span data-testid="inbox-select-count">{selectedIds.length} selected</span>
          ) : (
            <span>{visible.length} of {allRows.length} threads</span>
          )
        }
      />

      {summary ? (
        <div className="mb-6 grid grid-cols-3 gap-3">
          <KpiTile label="Unread" value={summary.unreadThreads} />
          <KpiTile label="At risk" value={summary.atRiskThreads} tone={summary.atRiskThreads > 0 ? "warn" : "ok"} />
          <KpiTile label="Oldest pending inbound" value={oldestPending} small />
        </div>
      ) : null}

      {personFilter && personFilterName ? (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-3">
          <span>Filtered to threads with</span>
          <button
            type="button"
            onClick={() => setPersonFilter(null)}
            className="inline-flex items-center gap-1 rounded-[8px] border border-hairline bg-paper px-2 py-[2px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink"
            aria-label={`Clear filter for ${personFilterName}`}
          >
            {personFilterName}
            <span aria-hidden>×</span>
          </button>
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
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value as PlatformFilter)}
          className="shrink-0 rounded-[10px] border border-hairline bg-paper px-3 py-[8px] text-[12px] text-ink-2 focus:border-ink-3 focus:outline-none"
          aria-label="Filter by platform"
        >
          {PLATFORM_FILTERS.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="shrink-0 rounded-[10px] border border-hairline bg-paper px-3 py-[8px] text-[12px] text-ink-2 focus:border-ink-3 focus:outline-none"
          aria-label="Sort threads"
        >
          {SORT_MODES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        {filter === "outreach" && rows.length > 0 ? (
          <button
            type="button"
            disabled={!!archivingOutreach}
            onClick={() => void archiveAllOutreach()}
            className="shrink-0 rounded-[10px] border border-hairline bg-paper px-3 py-[8px] text-[12px] text-ink-2 hover:bg-paper-2 disabled:opacity-50"
          >
            {archivingOutreach ? `Archiving ${rows.length}…` : `Archive all (${rows.length})`}
          </button>
        ) : null}
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
            runActionWithFeedback(
              apiPost("/runner/control/platform/test-selectors", { platform: degraded.platform }),
              {
                pending: `Running selector tests for ${degraded.platform}…`,
                success: `Selector tests queued for ${degraded.platform}`,
                failure: `Selector tests failed for ${degraded.platform}`,
                setError,
                onDone: () => refresh()
              }
            )
          }
          onOpenReceipts={() => setReceiptsOpen(true)}
        />
      ) : null}

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {bulkResult ? (
        <p className="mb-6 font-mono text-[11px] text-ink-3">{bulkResult}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : visible.length === 0 ? (
        <CaughtUp
          title={query || filter !== "all" ? "Nothing matches that filter." : "You’re caught up."}
          body={query || filter !== "all" ? "Clear the filter or try a different search." : "No conversations need you right now."}
        />
      ) : (
        <>
          {!selectMode ? (
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                Tip:{" "}
                <kbd className="rounded border border-hairline-strong bg-paper-2 px-[5px] py-[1px] font-mono text-[11px] normal-case tracking-normal text-ink-2">
                  ⌘
                </kbd>
                -click a row to select multiple at once.
              </p>
              <button
                type="button"
                onClick={() => setForceSelectMode(true)}
                className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
              >
                Select
              </button>
            </div>
          ) : null}
          {buckets.map((bucket) =>
            bucket.items.length ? (
              <section key={bucket.key}>
                <SectionDivider label={bucket.label} />
                <div className="flex flex-col">
                  {bucket.items.map((row) => (
                    <SelectableThreadRow
                      key={row.id}
                      row={row}
                      selectMode={selectMode}
                      selected={selectedSet.has(row.id)}
                      onToggle={toggleId}
                      onPersonChanged={() => void refresh()}
                    />
                  ))}
                </div>
              </section>
            ) : null
          )}
        </>
      )}

      {selectMode ? (
        <div
          data-testid="bulk-action-bar"
          className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-hairline bg-paper px-4 py-2 shadow-card"
        >
          <span className="font-mono text-[11px] tracking-[0.04em] text-ink-3">
            {selectedIds.length} selected
          </span>
          <button
            type="button"
            disabled={!!bulkPending}
            onClick={() =>
              void runBulk("Mark done", (id) => `/runner/control/thread/${id}/mark-done`)
            }
            className="rounded-full px-3 py-1 text-[12px] font-medium text-ink hover:bg-paper-2 disabled:opacity-50"
          >
            {bulkPending === "Mark done" ? "Marking…" : "Mark done"}
          </button>
          <button
            type="button"
            disabled={!!bulkPending}
            onClick={() =>
              void runBulk("Snooze 16h", (id) => `/runner/control/thread/${id}/snooze`, { hours: 16 })
            }
            className="rounded-full px-3 py-1 text-[12px] font-medium text-ink hover:bg-paper-2 disabled:opacity-50"
          >
            {bulkPending === "Snooze 16h" ? "Snoozing…" : "Snooze 16h"}
          </button>
          <button
            type="button"
            disabled={!!bulkPending}
            onClick={() =>
              void runBulk("Rescan", (id) => `/runner/control/thread/${id}/rescan`)
            }
            className="rounded-full px-3 py-1 text-[12px] font-medium text-ink hover:bg-paper-2 disabled:opacity-50"
          >
            {bulkPending === "Rescan" ? "Rescanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="rounded-full px-3 py-1 text-[12px] text-ink-3 hover:bg-paper-2"
          >
            Clear
          </button>
        </div>
      ) : null}

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
