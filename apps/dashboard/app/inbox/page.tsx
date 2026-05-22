"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { apiGet, apiPost, runAction, ApiRequestError } from "@/lib/api";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { PersonAvatar } from "@/components/common/person-avatar";
import { readInboxQueryParam } from "@/lib/inbox-query";
import { formatRelative } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";
import { PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { isWithinHorizon } from "@/lib/horizon";
import { cn } from "@/lib/utils";

type RiskTab = "all" | "overdue" | "waiting" | "fresh" | "snoozed";
type CategoryFilter = "any" | "genuine" | "outreach" | "needs_reply" | "waiting_on_them";
type PlatformFilter = "all" | "LINKEDIN" | "IMESSAGE";
type SortMode = "oldest" | "recent" | "name";

const TABS: { key: RiskTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "overdue", label: "Overdue" },
  { key: "waiting", label: "Waiting" },
  { key: "fresh", label: "Fresh" },
  { key: "snoozed", label: "Snoozed" }
];

const CATEGORY_FILTERS: { key: CategoryFilter; label: string }[] = [
  { key: "any", label: "Any kind" },
  { key: "needs_reply", label: "Needs reply" },
  { key: "waiting_on_them", label: "Waiting on them" },
  { key: "genuine", label: "Genuine" },
  { key: "outreach", label: "Outreach" }
];

const PLATFORM_FILTERS: { key: PlatformFilter; label: string }[] = [
  { key: "all", label: "Any platform" },
  { key: "LINKEDIN", label: "LinkedIn" },
  { key: "IMESSAGE", label: "iMessage" }
];

const SORT_MODES: { key: SortMode; label: string }[] = [
  { key: "oldest", label: "oldest wait" },
  { key: "recent", label: "most recent" },
  { key: "name", label: "name A-Z" }
];

const PLATFORM_GLYPH: Record<InboxRow["platform"], string> = {
  LINKEDIN: "in",
  IMESSAGE: "iM",
  INSTAGRAM: "ig",
  TIKTOK: "tt"
};

function applyTab(row: InboxRow, tab: RiskTab): boolean {
  if (tab === "all") return !row.scheduledSendAt;
  if (tab === "snoozed") return !!row.scheduledSendAt;
  if (row.scheduledSendAt) return false;
  if (tab === "overdue") return row.riskLevel === "RED";
  if (tab === "waiting") return row.riskLevel === "AMBER";
  if (tab === "fresh") return row.riskLevel === "GREEN";
  return true;
}

function applyCategory(row: InboxRow, kind: CategoryFilter): boolean {
  switch (kind) {
    case "needs_reply":
      return row.needsReply;
    case "waiting_on_them":
      return row.lastMessageDirection === "OUT" && !row.archivedAt;
    case "genuine":
      return row.category === "genuine";
    case "outreach":
      return row.category === "outreach";
    default:
      return true;
  }
}

function applyPlatform(row: InboxRow, platform: PlatformFilter): boolean {
  return platform === "all" ? true : row.platform === platform;
}

function applySort(items: InboxRow[], sort: SortMode): InboxRow[] {
  const copy = [...items];
  switch (sort) {
    case "name":
      return copy.sort((a, b) => a.personName.localeCompare(b.personName));
    case "recent":
      return copy.sort((a, b) => {
        const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        return bTs - aTs;
      });
    case "oldest":
    default:
      return copy.sort((a, b) => {
        const aTs = a.lastInboundAt ?? a.lastMessageAt;
        const bTs = b.lastInboundAt ?? b.lastMessageAt;
        return (aTs ? Date.parse(aTs) : 0) - (bTs ? Date.parse(bTs) : 0);
      });
  }
}

function rightLabelFor(row: InboxRow): { text: string; tone: string } {
  const risk = toDisplayRisk(row.riskLevel);
  const rel = formatRelative(row.lastInboundAt ?? row.lastMessageAt);
  if (risk === "overdue")
    return { text: `${rel} overdue`, tone: "text-risk-overdue font-medium" };
  if (risk === "waiting")
    return { text: rel, tone: "text-risk-waiting font-medium" };
  return { text: rel, tone: "text-ink-2" };
}

function dotFor(row: InboxRow): string {
  const risk = toDisplayRisk(row.riskLevel);
  if (risk === "overdue") return "bg-risk-overdue";
  if (risk === "waiting") return "bg-risk-waiting";
  return "bg-risk-fresh";
}

// All inbox - filter tabs (replacing stacked risk sections), platform
// glyph column, sort + secondary filters on the right of the tab bar.
// Search input lives above the tabs. Multi-select + bulk-action bar
// unchanged.
export default function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<RiskTab>("all");
  const [category, setCategory] = useState<CategoryFilter>("any");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("oldest");
  // Issue #287: by default the inbox hides conversations whose last activity
  // is older than the recency horizon. Searching or flipping "show all"
  // lifts the horizon so dormant threads stay reachable.
  const [showAll, setShowAll] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [forceSelectMode, setForceSelectMode] = useState(false);
  const lastToggledRef = useRef<string | null>(null);
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

  // Seed search from a ?q= deep link (the thread participant popover's
  // "Find 1:1 thread" → /inbox?q=<handle>). Runs once on mount; the inbox
  // redesign dropped the original handling — see issue #211.
  useEffect(() => {
    const q = readInboxQueryParam(window.location.search);
    if (q) setQuery(q);
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

  // Per-tab counts, computed against the full data set so the tab badges
  // don't shift as the operator filters by platform / search / category.
  const counts = useMemo(() => {
    const live = allRows.filter((row) => !row.scheduledSendAt);
    return {
      all: live.length,
      overdue: live.filter((r) => r.riskLevel === "RED").length,
      waiting: live.filter((r) => r.riskLevel === "AMBER").length,
      fresh: live.filter((r) => r.riskLevel === "GREEN").length,
      snoozed: allRows.filter((r) => !!r.scheduledSendAt).length
    };
  }, [allRows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The recency horizon (issue #287) hides long-dormant threads from the
    // default view so a year of pilot history does not crowd out the live
    // inbox. Searching lifts the horizon so older threads are still
    // reachable; "show all" lifts it explicitly.
    const applyHorizon = !showAll && !q;
    return allRows.filter((row) => {
      if (!applyTab(row, tab)) return false;
      if (!applyCategory(row, category)) return false;
      if (!applyPlatform(row, platformFilter)) return false;
      if (applyHorizon && !isWithinHorizon(row.lastMessageAt)) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [allRows, query, tab, category, platformFilter, showAll]);

  // How many threads the horizon is hiding right now, for the "show all"
  // affordance below the search bar. Only counts threads that would
  // otherwise be visible under the current tab / category / platform.
  const hiddenByHorizon = useMemo(() => {
    if (showAll || query.trim()) return 0;
    return allRows.filter(
      (row) =>
        applyTab(row, tab) &&
        applyCategory(row, category) &&
        applyPlatform(row, platformFilter) &&
        !isWithinHorizon(row.lastMessageAt)
    ).length;
  }, [allRows, showAll, query, tab, category, platformFilter]);

  const rows = useMemo(
    () => applySort(visible.filter((row) => !removedIds.has(row.id)), sortMode),
    [visible, removedIds, sortMode]
  );

  const degraded = platforms.find((p) => p.status === "DEGRADED");

  const flatVisibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectMode = forceSelectMode || selectedIds.length > 0;

  const toggleId = useCallback(
    (id: string, opts: { shiftKey: boolean }) => {
      setSelectedIds((prev) => {
        const set = new Set(prev);
        if (opts.shiftKey && lastToggledRef.current && lastToggledRef.current !== id) {
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
        if (set.has(id)) set.delete(id);
        else set.add(id);
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

  const sortLabel = SORT_MODES.find((s) => s.key === sortMode)?.label ?? "oldest wait";

  return (
    <Canvas>
      <PageHead
        eyebrow="All conversations"
        title="Inbox"
        meta={
          selectMode ? (
            <span data-testid="inbox-select-count">{selectedIds.length} selected</span>
          ) : (
            <span>
              <strong className="font-medium text-ink">{visible.length}</strong> of {counts.all} threads
            </span>
          )
        }
      />

      <div className="mb-[14px] flex items-center gap-2 rounded-[10px] border border-hairline bg-paper px-3 py-[8px] text-ink-3">
        <Search className="h-[14px] w-[14px]" strokeWidth={1.6} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people, keywords…"
          className="flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>

      <div className="mb-[18px] flex flex-wrap items-center gap-[2px] border-b border-hairline">
        {TABS.map((entry) => {
          const active = tab === entry.key;
          const count = counts[entry.key];
          const tone =
            entry.key === "overdue"
              ? "text-risk-overdue"
              : entry.key === "waiting"
                ? "text-risk-waiting"
                : "text-ink-4";
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={cn(
                "relative -mb-px px-[14px] py-[10px] text-[13px] transition-colors duration-calm",
                active ? "font-medium text-ink" : "text-ink-3 hover:text-ink"
              )}
            >
              {entry.label}
              <span className={cn("ml-[5px] font-mono text-[10px]", active ? "text-ink-2" : tone)}>
                {count}
              </span>
              {active ? (
                <span
                  aria-hidden
                  className="absolute bottom-[-1px] left-[14px] right-[14px] h-[2px] bg-ink"
                />
              ) : null}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-3 pr-1 font-mono text-[11px] text-ink-3">
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value as PlatformFilter)}
            aria-label="Platform"
            className="bg-transparent text-ink-2 outline-none hover:text-ink"
          >
            {PLATFORM_FILTERS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
          <span aria-hidden className="text-ink-3/60">·</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as CategoryFilter)}
            aria-label="Kind"
            className="bg-transparent text-ink-2 outline-none hover:text-ink"
          >
            {CATEGORY_FILTERS.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <span aria-hidden className="text-ink-3/60">·</span>
          <span>
            sort:{" "}
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              aria-label="Sort"
              className="bg-transparent text-ink-2 outline-none hover:text-ink"
            >
              {SORT_MODES.map((s) => (
                <option key={s.key} value={s.key}>{s.label} ↓</option>
              ))}
            </select>
            <span className="sr-only">{sortLabel}</span>
          </span>
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

      {bulkResult ? (
        <p className="mb-6 font-mono text-[11px] text-ink-3">{bulkResult}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : visible.length === 0 && !showAll && hiddenByHorizon > 0 && !query.trim() ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <p className="m-0 text-[16px] font-medium text-ink">You’re caught up.</p>
          <p className="m-0 text-[14px] text-ink-2">
            {hiddenByHorizon} older conversation{hiddenByHorizon === 1 ? "" : "s"} set aside.{" "}
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="underline underline-offset-2 hover:text-ink"
            >
              Show all
            </button>
          </p>
        </div>
      ) : visible.length === 0 ? (
        <CaughtUp
          title={query || tab !== "all" || category !== "any" ? "Nothing matches that filter." : "You’re caught up."}
          body={query || tab !== "all" || category !== "any" ? "Clear the filter or try a different search." : "No conversations need you right now."}
        />
      ) : (
        <>
          {!query.trim() && (showAll || hiddenByHorizon > 0) ? (
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
              {showAll ? (
                <>
                  Showing all conversations.{" "}
                  <button
                    type="button"
                    onClick={() => setShowAll(false)}
                    className="underline underline-offset-2 hover:text-ink"
                  >
                    Show recent only
                  </button>
                </>
              ) : (
                <>
                  {hiddenByHorizon} older conversation{hiddenByHorizon === 1 ? "" : "s"} set aside.{" "}
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="underline underline-offset-2 hover:text-ink"
                  >
                    Show all
                  </button>
                </>
              )}
            </p>
          ) : null}
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
          <div className="flex flex-col">
            {rows.map((row) => (
              <InboxRowItem
                key={row.id}
                row={row}
                selectMode={selectMode}
                selected={selectedSet.has(row.id)}
                onToggle={toggleId}
              />
            ))}
          </div>
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

interface InboxRowItemProps {
  row: InboxRow;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string, opts: { shiftKey: boolean }) => void;
}

function InboxRowItem({ row, selectMode, selected, onToggle }: InboxRowItemProps) {
  const right = rightLabelFor(row);
  const dot = dotFor(row);
  const cleanPreview = normalizePreview(row.preview);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${cleanPreview}` : cleanPreview;

  const onClick = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || selectMode) {
      event.preventDefault();
      onToggle(row.id, { shiftKey: event.shiftKey });
    }
  };

  return (
    <Link
      href={`/thread/${row.id}`}
      onClick={onClick}
      className={cn(
        "grid grid-cols-[28px_30px_1fr_auto] items-center gap-[14px] border-b border-hairline px-1 py-[13px] transition-colors duration-calm hover:bg-paper-2",
        selected ? "bg-paper-2" : ""
      )}
    >
      <PersonAvatar
        name={row.personName}
        avatarUrl={row.personAvatarUrl}
        size={28}
        className="text-[11px]"
      />
      <span className="rounded-[5px] border border-hairline px-1 py-[3px] text-center font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-3">
        {PLATFORM_GLYPH[row.platform] ?? PLATFORM_LABEL[row.platform].slice(0, 2)}
      </span>
      <span className="flex min-w-0 items-baseline gap-[10px]">
        <span className="shrink-0 text-[14px] font-medium tracking-[-0.005em] text-ink">
          {row.personName}
        </span>
        <span className="min-w-0 truncate text-[13px] text-ink-3">{previewBody}</span>
      </span>
      <span className="flex items-center gap-[10px] font-mono text-[11px] text-ink-3">
        <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${dot}`} />
        <span className={right.tone}>{right.text}</span>
      </span>
    </Link>
  );
}
