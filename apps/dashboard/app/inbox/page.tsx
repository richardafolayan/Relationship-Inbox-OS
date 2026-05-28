"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Archive, Search } from "lucide-react";
import { apiGet, apiPost, runAction, ApiRequestError } from "@/lib/api";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { PersonAvatar } from "@/components/common/person-avatar";
import { readInboxQueryParam } from "@/lib/inbox-query";
import { formatRelative } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";
import { PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { isWithinHorizon } from "@/lib/horizon";
import { isLikelyClosed } from "@/lib/closed-conversation";
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
  { key: "any", label: "Any" },
  { key: "needs_reply", label: "Needs reply" },
  { key: "waiting_on_them", label: "Waiting on them" },
  { key: "genuine", label: "Genuine" },
  { key: "outreach", label: "Outreach" }
];

const PLATFORM_FILTERS: { key: PlatformFilter; label: string }[] = [
  { key: "all", label: "All" },
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

// Human-readable label for the "N older or closed conversations set aside"
// banner. Picks the right pluralisation and only mentions a bucket when
// it is non-empty so the copy stays tight ("3 older conversations", "1
// closed conversation", "5 older, 2 closed").
function hiddenLabel(breakdown: { older: number; closed: number }): string {
  const { older, closed } = breakdown;
  if (older > 0 && closed > 0) {
    return `${older} older, ${closed} closed conversation${
      older + closed === 1 ? "" : "s"
    }`;
  }
  if (older > 0) {
    return `${older} older conversation${older === 1 ? "" : "s"}`;
  }
  return `${closed} closed conversation${closed === 1 ? "" : "s"}`;
}

// #433 R-0055: empty-state headline for a specific risk tab whose badge is
// non-zero but whose feed is empty because every match sits behind the
// recency horizon. The tab label already reads as a noun
// ("Overdue"/"Waiting"/"Fresh"/"Snoozed"); lowercase it and agree the verb
// with the count so the line reads "197 overdue are set aside."
function setAsidePhrase(tab: RiskTab, count: number): string {
  const noun: Record<RiskTab, string> = {
    all: "",
    overdue: "overdue",
    waiting: "waiting",
    fresh: "fresh",
    snoozed: "snoozed"
  };
  return `${count} ${noun[tab]} ${count === 1 ? "is" : "are"} set aside.`;
}

interface SectionGroup {
  key: string;
  label: string | null;
  items: InboxRow[];
}

// Inbox - search box, a risk tab bar, then a thin secondary filter row
// (platform / kind / sort). The "All" tab buckets the feed into Overdue /
// Waiting / Fresh sections so a long list scans top-down by urgency; a
// single-risk or Snoozed tab is already homogeneous and renders as one
// flat list. Older / likely-closed threads are hidden by default
// (issue #287) and surfaced via the Show all affordance.
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

  // Per-tab counts. Scoped to the active platform + category chips so the
  // badges reflect the current filter — e.g. filtering to LinkedIn shows
  // how many LinkedIn threads sit in each risk bucket, not the global
  // totals (#433 R-0055). Search and the recency horizon are deliberately
  // left out: search is a transient find (the "N of M" header already
  // tracks it), and the horizon's "set aside" threads still belong to
  // their bucket — the empty-state copy below explains that split rather
  // than hiding them from the badge.
  const counts = useMemo(() => {
    const scoped = allRows.filter(
      (row) => applyCategory(row, category) && applyPlatform(row, platformFilter)
    );
    const live = scoped.filter((row) => !row.scheduledSendAt);
    return {
      all: live.length,
      overdue: live.filter((r) => r.riskLevel === "RED").length,
      waiting: live.filter((r) => r.riskLevel === "AMBER").length,
      fresh: live.filter((r) => r.riskLevel === "GREEN").length,
      snoozed: scoped.filter((r) => !!r.scheduledSendAt).length
    };
  }, [allRows, category, platformFilter]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Two "set aside" filters tighten the default inbox (issue #287):
    //   - The recency horizon hides dormant threads (phase 1).
    //   - The closed-conversation heuristic hides threads whose last
    //     inbound message reads as an acknowledgement / farewell
    //     (phase 2).
    // Both are lifted by an explicit "show all" toggle and by any active
    // search, so older or closed threads are still reachable.
    const applyActiveOnly = !showAll && !q;
    return allRows.filter((row) => {
      if (!applyTab(row, tab)) return false;
      if (!applyCategory(row, category)) return false;
      if (!applyPlatform(row, platformFilter)) return false;
      if (applyActiveOnly && !isWithinHorizon(row.lastMessageAt)) return false;
      if (applyActiveOnly && isLikelyClosed(row)) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [allRows, query, tab, category, platformFilter, showAll]);

  // How many threads the active-only filter is currently hiding, broken
  // down by reason. Only counts threads that would otherwise be visible
  // under the current tab / category / platform so the affordance does
  // not over-promise.
  const hiddenBreakdown = useMemo(() => {
    if (showAll || query.trim()) return { total: 0, older: 0, closed: 0 };
    let older = 0;
    let closed = 0;
    for (const row of allRows) {
      if (!applyTab(row, tab)) continue;
      if (!applyCategory(row, category)) continue;
      if (!applyPlatform(row, platformFilter)) continue;
      const dormant = !isWithinHorizon(row.lastMessageAt);
      const ended = isLikelyClosed(row);
      if (!dormant && !ended) continue;
      // Dormant takes precedence in the count so the two reasons add up
      // to total without double-counting a thread that is both old and
      // closed.
      if (dormant) older += 1;
      else closed += 1;
    }
    return { total: older + closed, older, closed };
  }, [allRows, showAll, query, tab, category, platformFilter]);
  const hiddenByHorizon = hiddenBreakdown.total;

  // #287 F1: "Refresh closed verdicts" button state. Same idle/running/
  // done/error transitions as the Reconnect page's refresh button so the
  // operator's pattern carries across surfaces.
  type RefreshState =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; summary: string; tone: "ok" | "warn" }
    | { kind: "error"; message: string };
  const [closedRefreshState, setClosedRefreshState] = useState<RefreshState>({ kind: "idle" });
  const handleRefreshClosedVerdicts = useCallback(async () => {
    if (closedRefreshState.kind === "running") return;
    setClosedRefreshState({ kind: "running" });
    try {
      const result = await apiPost<{
        status: "ok" | "ai_unavailable" | "disabled_by_settings";
        scored: number;
        skipped: number;
        failed: number;
      }>("/runner/control/closed-status/refresh-stale", { limit: 30 });
      await refresh();
      const summary =
        result.status === "disabled_by_settings"
          ? "AI is off (Settings)"
          : result.scored === 0 && result.skipped > 0
            ? "Already up to date"
            : result.status === "ai_unavailable"
              ? `Classified ${result.scored}, then AI went quiet`
              : `Classified ${result.scored}${result.skipped > 0 ? `, skipped ${result.skipped} already done` : ""}`;
      const tone: "ok" | "warn" =
        result.status === "ai_unavailable" || result.status === "disabled_by_settings"
          ? "warn"
          : "ok";
      setClosedRefreshState({ kind: "done", summary, tone });
      window.setTimeout(() => {
        setClosedRefreshState((current) => (current.kind === "done" ? { kind: "idle" } : current));
      }, 4500);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Could not reach the runner.";
      setClosedRefreshState({ kind: "error", message });
      window.setTimeout(() => {
        setClosedRefreshState((current) => (current.kind === "error" ? { kind: "idle" } : current));
      }, 5000);
    }
  }, [closedRefreshState.kind, refresh]);
  const closedRefreshLabel = (() => {
    if (closedRefreshState.kind === "running") return "Classifying…";
    if (closedRefreshState.kind === "done") return closedRefreshState.summary;
    if (closedRefreshState.kind === "error") return closedRefreshState.message;
    return "Refresh closed verdicts";
  })();
  const closedRefreshTone =
    closedRefreshState.kind === "error"
      ? "text-risk-overdue"
      : closedRefreshState.kind === "done" && closedRefreshState.tone === "warn"
        ? "text-risk-waiting"
        : "text-ink-3";

  // The "All" tab mixes risk levels, so it is bucketed into urgency
  // sections; every other tab is a single bucket and renders flat.
  const grouped = tab === "all";

  const sections = useMemo<SectionGroup[]>(() => {
    const live = visible.filter((row) => !removedIds.has(row.id));
    if (!grouped) {
      return [{ key: tab, label: null, items: applySort(live, sortMode) }];
    }
    const byLevel = (level: InboxRow["riskLevel"]) =>
      applySort(live.filter((row) => row.riskLevel === level), sortMode);
    return [
      { key: "overdue", label: "Overdue", items: byLevel("RED") },
      { key: "waiting", label: "Waiting", items: byLevel("AMBER") },
      { key: "fresh", label: "Fresh", items: byLevel("GREEN") }
    ].filter((section) => section.items.length > 0);
  }, [visible, removedIds, grouped, tab, sortMode]);

  // Flat, in-visual-order id list so shift-click range select spans across
  // section boundaries.
  const orderedRows = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections]
  );

  const degraded = platforms.find((p) => p.status === "DEGRADED");

  const flatVisibleIds = useMemo(() => orderedRows.map((r) => r.id), [orderedRows]);
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

      <div className="flex flex-wrap items-center gap-[2px] border-b border-hairline">
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
      </div>

      <div className="mb-1 mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px]">
        <FilterSelect
          label="platform"
          value={platformFilter}
          onChange={setPlatformFilter}
          options={PLATFORM_FILTERS}
        />
        <FilterSelect label="kind" value={category} onChange={setCategory} options={CATEGORY_FILTERS} />
        <FilterSelect label="sort" value={sortMode} onChange={setSortMode} options={SORT_MODES} />
        {!selectMode && orderedRows.length > 0 ? (
          <button
            type="button"
            onClick={() => setForceSelectMode(true)}
            className="ml-auto uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:text-ink"
          >
            Select
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
          {tab === "all" ? (
            <>
              <p className="m-0 text-[16px] font-medium text-ink">You’re caught up.</p>
              <p className="m-0 text-[14px] text-ink-2">
                {hiddenLabel(hiddenBreakdown)} set aside.{" "}
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  Show all
                </button>
              </p>
            </>
          ) : (
            // #433 R-0055: the badge the user just clicked is non-zero, so
            // "You’re caught up." reads as a contradiction. Lead with the
            // actionable count and offer to lift the horizon in one click.
            <>
              <p className="m-0 text-[16px] font-medium text-ink">
                {setAsidePhrase(tab, hiddenByHorizon)}
              </p>
              <p className="m-0 text-[14px] text-ink-2">
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  Show all
                </button>
              </p>
            </>
          )}
        </div>
      ) : visible.length === 0 ? (
        <CaughtUp
          title={query || tab !== "all" || category !== "any" ? "Nothing matches that filter." : "You’re caught up."}
          body={query || tab !== "all" || category !== "any" ? "Clear the filter or try a different search." : "No conversations need you right now."}
        />
      ) : (
        <>
          {!query.trim() && (showAll || hiddenByHorizon > 0) ? (
            <p className="mb-3 mt-3 flex flex-wrap items-baseline gap-x-3 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
              {showAll ? (
                <span>
                  Showing all conversations.{" "}
                  <button
                    type="button"
                    onClick={() => setShowAll(false)}
                    className="underline underline-offset-2 hover:text-ink"
                  >
                    Show recent only
                  </button>
                </span>
              ) : (
                <span>
                  {hiddenLabel(hiddenBreakdown)} set aside.{" "}
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="underline underline-offset-2 hover:text-ink"
                  >
                    Show all
                  </button>
                </span>
              )}
              {/* #287 F1: trigger AI close-status classification for
                  threads that have never been classified (or pre-date
                  the v2 cache with reasons). Sits next to the existing
                  Show all / Show recent toggle so the affordance is in
                  the same place the operator already looks. */}
              <button
                type="button"
                onClick={() => void handleRefreshClosedVerdicts()}
                disabled={closedRefreshState.kind === "running"}
                className={`underline underline-offset-2 transition-colors duration-calm hover:text-ink disabled:opacity-60 ${closedRefreshTone}`}
                data-testid="inbox-refresh-closed-verdicts"
                aria-live="polite"
              >
                {closedRefreshLabel}
              </button>
            </p>
          ) : null}
          {grouped ? (
            sections.map((section, index) => (
              <section key={section.key}>
                <SectionDivider label={section.label ?? ""} tight={index === 0} />
                <div className="flex flex-col">
                  {section.items.map((row) => (
                    <InboxRowItem
                      key={row.id}
                      row={row}
                      selectMode={selectMode}
                      selected={selectedSet.has(row.id)}
                      onToggle={toggleId}
                    />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <div className="mt-4 flex flex-col">
              {orderedRows.map((row) => (
                <InboxRowItem
                  key={row.id}
                  row={row}
                  selectMode={selectMode}
                  selected={selectedSet.has(row.id)}
                  onToggle={toggleId}
                />
              ))}
            </div>
          )}
        </>
      )}

      {loaded ? (
        <div className="mt-14 flex justify-center border-t border-hairline pt-6">
          <Link
            href="/archived"
            className="inline-flex items-center gap-[7px] font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:text-ink"
          >
            <Archive className="h-[13px] w-[13px]" strokeWidth={1.6} />
            View archived threads
          </Link>
        </div>
      ) : null}

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

interface FilterSelectProps<K extends string> {
  label: string;
  value: K;
  onChange: (value: K) => void;
  options: readonly { key: K; label: string }[];
}

function FilterSelect<K extends string>({ label, value, onChange, options }: FilterSelectProps<K>) {
  return (
    <label className="flex items-center gap-[6px] text-ink-3">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as K)}
        className="cursor-pointer bg-transparent text-ink-2 outline-none transition-colors duration-calm hover:text-ink"
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
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
        "group grid grid-cols-[28px_30px_1fr_auto] items-center gap-[14px] border-b border-hairline px-1 py-[13px] transition-colors duration-calm hover:bg-paper-2",
        selected ? "bg-paper-2" : ""
      )}
    >
      {/* Avatar doubles as the select target: a circle fades in over it on
          row hover (and stays put in select mode) so multi-select is
          discoverable without a ⌘-click. The button stops propagation so a
          click selects rather than opening the thread. */}
      <span className="relative h-7 w-7">
        <PersonAvatar
          name={row.personName}
          avatarUrl={row.personAvatarUrl}
          size={28}
          className="text-[11px]"
        />
        <button
          type="button"
          aria-label={selected ? `Deselect ${row.personName}` : `Select ${row.personName}`}
          aria-pressed={selected}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle(row.id, { shiftKey: event.shiftKey });
          }}
          className={cn(
            "absolute inset-0 grid place-items-center rounded-full border transition-opacity duration-calm",
            selected
              ? "border-accent bg-accent text-white"
              : "border-hairline-strong bg-paper text-ink-3 hover:border-ink-3 hover:text-ink-2",
            selectMode
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          )}
        >
          {selected ? (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.25">
              <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </button>
      </span>
      <span className="rounded-[5px] border border-hairline px-1 py-[3px] text-center font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-3 self-start mt-[2px]">
        {PLATFORM_GLYPH[row.platform] ?? PLATFORM_LABEL[row.platform].slice(0, 2)}
      </span>
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className="flex min-w-0 items-baseline gap-[10px]">
          <span className="shrink-0 text-[14px] font-medium tracking-[-0.005em] text-ink">
            {row.personName}
          </span>
          <span className="min-w-0 truncate text-[13px] text-ink-3">{previewBody}</span>
        </span>
        {/* AI close-status reason caption (#287 F2). Only rendered when
            the verdict is "closed" - on "open" rows there is nothing
            useful to caption ("waiting on them" duplicates the right
            column). The row itself only renders under Show all or a
            search; the parent's filter decides whether the operator
            sees it at all. */}
        {row.closedStatus === "closed" && row.closedStatusReason ? (
          <span className="block text-[12px] text-ink-3">{row.closedStatusReason}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-[10px] font-mono text-[11px] text-ink-3">
        <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${dot}`} />
        <span className={right.tone}>{right.text}</span>
      </span>
    </Link>
  );
}
