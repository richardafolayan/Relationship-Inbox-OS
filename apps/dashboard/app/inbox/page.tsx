"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useFullDemo } from "@/components/full-demo/FullDemoProvider";
import { scopeRowsToSandbox } from "@/lib/demo-threads";
import {
  GUIDED_TOUR_SURFACE_EVENT,
  isGuidedTourSurfaceActive,
  resolveFrozenListRows,
  type GuidedTourSurfaceDetail
} from "@/lib/guided-tour";
import { Archive, Search, Star, Tags } from "lucide-react";
import { apiGet, apiPost, runAction, ApiRequestError } from "@/lib/api";
import { useCacheSeed } from "@/lib/use-cache-seed";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { shouldInboxRefreshOnRunnerEvent } from "@/lib/inbox-events";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard } from "@/lib/types";
import { priorityContactsFirst, setFavourite } from "@/lib/favourites";
import { rowMatchesPriorityGroup } from "@/lib/priority-groups";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { FocusInboxGroup } from "@/components/common/focus/focus-inbox-group";
import { BrandLoader } from "@/components/common/brand-loader";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { MacContactsHint } from "@/components/common/mac-contacts-hint";
import dynamic from "next/dynamic";
import { PersonAvatar } from "@/components/common/person-avatar";
import { readInboxQueryParam } from "@/lib/inbox-query";
import {
  INBOX_INITIAL_VISIBLE_ROWS,
  nextInboxVisibleCount,
  windowInboxSections
} from "@/lib/inbox-pagination";
import { formatRelative } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";
import { isDegradedAndInUse, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { isWithinHorizon } from "@/lib/horizon";
import { isLikelyClosed } from "@/lib/closed-conversation";
import { bulkActionRemovesRow } from "@/lib/inbox-bulk";
import { cn } from "@/lib/utils";
import { prefetchThreadData, cancelThreadPrefetch } from "@/lib/thread-prefetch";
import {
  TOOL_CLASS,
  XIcon,
  FilterGlyph,
  SelectGlyph,
  useDismiss,
  SortMenu,
  PopSection,
  PopOpt
} from "@/components/common/list-controls";

type RiskTab = "all" | "overdue" | "waiting" | "fresh" | "scheduled";
type CategoryFilter = "any" | "genuine" | "outreach" | "needs_reply" | "waiting_on_them";
type PlatformFilter = "all" | "LINKEDIN" | "IMESSAGE" | "WHATSAPP" | "GOOGLE_MESSAGES";
type PriorityGroupFilter = "all" | string;
type SortMode = "oldest" | "recent" | "name";

// Lazy-load the receipts drawer so its chunk stays out of the inbox's
// initial bundle; an "opened-once" latch keeps the existing open-prop
// behaviour once it has been shown.
const ReceiptsDrawer = dynamic(
  () => import("@/components/common/receipts-drawer").then((m) => m.ReceiptsDrawer),
  { ssr: false }
);

const TABS: { key: RiskTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "overdue", label: "Overdue" },
  { key: "waiting", label: "Waiting" },
  { key: "fresh", label: "Fresh" },
  { key: "scheduled", label: "Scheduled" }
];

const CATEGORY_FILTERS: { key: CategoryFilter; label: string }[] = [
  { key: "any", label: "Any" },
  { key: "needs_reply", label: "Needs reply" },
  { key: "waiting_on_them", label: "Waiting on them" },
  { key: "genuine", label: "Genuine" },
  { key: "outreach", label: "Outreach" }
];

// Full label lookup. The popover filters this against /data/platforms so
// disabled platforms never appear while active chip labels stay available.
const PLATFORM_FILTERS: { key: PlatformFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "LINKEDIN", label: "LinkedIn" },
  { key: "IMESSAGE", label: "iMessage" },
  { key: "WHATSAPP", label: "WhatsApp" },
  { key: "GOOGLE_MESSAGES", label: "Google Messages" }
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
  TIKTOK: "tt",
  WHATSAPP: "wa",
  GOOGLE_MESSAGES: "gm"
};

function applyTab(row: InboxRow, tab: RiskTab): boolean {
  if (tab === "all") return !row.scheduledSendAt;
  if (tab === "scheduled") return !!row.scheduledSendAt;
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

// Favourites lens (R-0066 / #483). When on, only favourited contacts show —
// the star doubles as a one-tap filter. Off by default so the inbox stays the
// full list.
function applyFavourite(row: InboxRow, favouritesOnly: boolean): boolean {
  return favouritesOnly ? row.personFavourite === true : true;
}

function applyPriorityGroup(row: InboxRow, group: PriorityGroupFilter): boolean {
  return rowMatchesPriorityGroup(row, group);
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

// Right-hand timestamp. Per the redesign only "overdue" carries colour
// (oxblood "… overdue"); waiting and fresh times read as quiet grey so the
// list stays calm and the overdue rows are the thing that pulls the eye.
function rightLabelFor(row: InboxRow): { text: string; tone: string } {
  const risk = toDisplayRisk(row.riskLevel);
  const rel = formatRelative(row.lastInboundAt ?? row.lastMessageAt);
  if (risk === "overdue")
    return { text: `${rel} overdue`, tone: "text-risk-overdue font-medium" };
  return { text: rel, tone: "text-ink-3" };
}

// Status dot: overdue = oxblood, waiting = amber, fresh = muted grey
// (the redesign mutes the fresh dot rather than colouring it green).
function dotFor(row: InboxRow): string {
  const risk = toDisplayRisk(row.riskLevel);
  if (risk === "overdue") return "bg-risk-overdue";
  if (risk === "waiting") return "bg-risk-waiting";
  return "bg-ink-4";
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
// ("Overdue"/"Waiting"/"Fresh"/"Scheduled"); lowercase it and agree the verb
// with the count so the line reads "197 overdue are set aside."
function setAsidePhrase(tab: RiskTab, count: number): string {
  const noun: Record<RiskTab, string> = {
    all: "",
    overdue: "overdue",
    waiting: "waiting",
    fresh: "fresh",
    scheduled: "scheduled"
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
// single-risk or Scheduled tab is already homogeneous and renders as one
// flat list. Older / likely-closed threads are hidden by default
// (issue #287) and surfaced via the Show all affordance.
export default function InboxPage() {
  // Seed from the shared client cache so returning to the Inbox (e.g. back
  // from a thread, or Today -> Inbox) paints the last-known list instantly
  // and then revalidates, instead of flashing an empty skeleton. Read via
  // useCacheSeed (NOT a useState initializer): the app shell's effects can
  // warm the cache from the localStorage snapshot before this boundary
  // hydrates, and a useState seed would leak that into the hydration render
  // and mismatch the server HTML.
  const inboxSeed = useCacheSeed<InboxResponse>("/runner/data/inbox");
  const platformsSeed = useCacheSeed<PlatformCard[]>("/runner/data/platforms");
  const [dataState, setData] = useState<InboxResponse | null>(null);
  const data = dataState ?? inboxSeed ?? null;
  const [platformsState, setPlatforms] = useState<PlatformCard[] | null>(null);
  const platforms = platformsState ?? platformsSeed ?? [];
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [receiptsEverOpened, setReceiptsEverOpened] = useState(false);
  useEffect(() => {
    if (receiptsOpen) setReceiptsEverOpened(true);
  }, [receiptsOpen]);
  const [loadedState, setLoaded] = useState(false);
  // A cached list (even an empty one) counts as loaded - no skeleton on
  // top of data we are already painting.
  const loaded = loadedState || inboxSeed !== undefined;
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<RiskTab>("all");
  const [category, setCategory] = useState<CategoryFilter>("any");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [priorityGroup, setPriorityGroup] = useState<PriorityGroupFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("oldest");
  const [visibleRowLimit, setVisibleRowLimit] = useState(INBOX_INITIAL_VISIBLE_ROWS);
  // Optimistic favourite state keyed by personId, so tapping a row's star
  // re-sorts and re-marks instantly without waiting for the 10s poll. Merged
  // over the server rows below; reverted if the toggle request fails.
  const [favOverrides, setFavOverrides] = useState<Record<string, boolean>>({});
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

  const applyInbox = useCallback((inbox: InboxResponse) => {
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
  }, []);

  // `force` skips the freshness TTL (still SWR: stale paints immediately,
  // the network value lands via onFresh). Used by the SSE-driven path - a
  // runner event means the data DID change, so serving a <4s-old cache and
  // skipping revalidation would delay the update until the next poll.
  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    const supportingContext = Promise.all([
      apiGet<PlatformCard[]>("/runner/data/platforms", { ttlMs: 10000 }).catch(() => []),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=100", { ttlMs: 5000 }).catch(() => [])
    ]).then(([platformRows, logRows]) => {
      setPlatforms(platformRows ?? []);
      setLogs(logRows ?? []);
    });

    const inbox = await apiGet<InboxResponse>("/runner/data/inbox", {
        ttlMs: opts?.force ? 0 : 4000,
        swr: true,
        onFresh: (d) => applyInbox(d as InboxResponse)
      }).catch(() => null);
    if (inbox) applyInbox(inbox);
    setLoaded(true);
    void supportingContext;
  }, [applyInbox]);

  // Seed search from a ?q= deep link (the thread participant popover's
  // "Find 1:1 thread" → /inbox?q=<handle>). Runs once on mount; the inbox
  // redesign dropped the original handling — see issue #211.
  useEffect(() => {
    const q = readInboxQueryParam(window.location.search);
    if (q) setQuery(q);
  }, []);

  // Debounced refetch (mirrors Today): a multi-thread scan emits a burst of
  // runner events, so collapse them into one refresh rather than N.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh({ force: true });
    }, 450);
  }, [refresh]);
  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    []
  );

  // Live updates: the runner streams THREAD_UPDATED / MESSAGE_SENT /
  // MESSAGE_SEND_FAILED / SCAN_FINISHED to the browser as `runner-event`
  // window events (the reassess-on-send path included). Today already
  // refetches on these, so a scan finishing or a send from the thread page /
  // another tab reflected near-instantly there while the Inbox stayed stale
  // until its 10s poll (P4L1). Subscribe to the same stream so the Inbox keeps
  // pace; the 10s poll below stays as a backstop.
  useEffect(() => {
    const onResync = () => scheduleRefresh();
    const onRunnerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      if (shouldInboxRefreshOnRunnerEvent(detail?.type)) scheduleRefresh();
    };
    window.addEventListener("runner-resync", onResync);
    window.addEventListener("runner-event", onRunnerEvent as EventListener);
    return () => {
      window.removeEventListener("runner-resync", onResync);
      window.removeEventListener("runner-event", onRunnerEvent as EventListener);
    };
  }, [scheduleRefresh]);
  // Poll every 10s while visible; paused in background tabs (the hook fires an
  // immediate tick on mount and a catch-up tick on return to foreground).
  useVisiblePolling(() => void refresh(), 10000);

  const { sandboxActive } = useFullDemo();
  // In a sandbox guided flow (pilot tour / presenter sandbox), the Inbox shows
  // only demo-seeded threads so the walkthrough stays inside sandbox data and
  // its targets resolve on a busy real inbox. Outside a sandbox flow this is a
  // no-op.
  const scopedRows = useMemo(
    () =>
      scopeRowsToSandbox(data?.rows ?? [], sandboxActive).map((row) => {
        const pid = row.personId;
        return pid && pid in favOverrides
          ? { ...row, personFavourite: favOverrides[pid] }
          : row;
      }),
    [data, sandboxActive, favOverrides]
  );
  const [tourSurfaceActive, setTourSurfaceActive] = useState(false);
  const [frozenRows, setFrozenRows] = useState<typeof scopedRows | null>(null);
  useEffect(() => {
    setTourSurfaceActive(isGuidedTourSurfaceActive());
    const onSurface = (event: Event) => {
      const detail = (event as CustomEvent<GuidedTourSurfaceDetail>).detail;
      setTourSurfaceActive(detail?.active ?? isGuidedTourSurfaceActive());
    };
    window.addEventListener(GUIDED_TOUR_SURFACE_EVENT, onSurface);
    return () => window.removeEventListener(GUIDED_TOUR_SURFACE_EVENT, onSurface);
  }, []);
  useEffect(() => {
    const resolved = resolveFrozenListRows({
      tourActive: tourSurfaceActive,
      nextRows: scopedRows,
      frozenRows
    });
    if (resolved.nextFrozen !== frozenRows) {
      setFrozenRows(resolved.nextFrozen);
    }
  }, [scopedRows, tourSurfaceActive, frozenRows]);
  const allRows = tourSurfaceActive && frozenRows && frozenRows.length > 0 ? frozenRows : scopedRows;

  const priorityGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const row of allRows) {
      for (const group of row.personGroups ?? []) groups.add(group);
    }
    return Array.from(groups).sort((a, b) => a.localeCompare(b));
  }, [allRows]);

  const platformFilterOptions = useMemo(() => {
    const available = new Set(platforms.map((platform) => platform.platform));
    return PLATFORM_FILTERS.filter(
      (option) => option.key === "all" || available.has(option.key)
    );
  }, [platforms]);

  useEffect(() => {
    if (platformFilter === "all") return;
    if (platformFilterOptions.some((option) => option.key === platformFilter)) return;
    setPlatformFilter("all");
  }, [platformFilter, platformFilterOptions]);

  useEffect(() => {
    if (priorityGroup === "all") return;
    if (priorityGroups.includes(priorityGroup)) return;
    setPriorityGroup("all");
  }, [priorityGroup, priorityGroups]);

  // Optimistically flip a contact's favourite, then persist. Reverts the
  // local override if the request fails so the star never lies. Keyed by
  // personId so every row of a multi-thread contact updates together.
  const toggleFavourite = useCallback((personId: string | undefined, next: boolean) => {
    if (!personId) return;
    setFavOverrides((prev) => ({ ...prev, [personId]: next }));
    void setFavourite(personId, next).catch(() => {
      setFavOverrides((prev) => ({ ...prev, [personId]: !next }));
    });
  }, []);

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
      (row) =>
        applyCategory(row, category) &&
        applyPlatform(row, platformFilter) &&
        applyFavourite(row, favouritesOnly) &&
        applyPriorityGroup(row, priorityGroup)
    );
    const live = scoped.filter((row) => !row.scheduledSendAt);
    return {
      all: live.length,
      overdue: live.filter((r) => r.riskLevel === "RED").length,
      waiting: live.filter((r) => r.riskLevel === "AMBER").length,
      fresh: live.filter((r) => r.riskLevel === "GREEN").length,
      scheduled: scoped.filter((r) => !!r.scheduledSendAt).length
    };
  }, [allRows, category, platformFilter, favouritesOnly, priorityGroup]);

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
      if (!applyFavourite(row, favouritesOnly)) return false;
      if (!applyPriorityGroup(row, priorityGroup)) return false;
      if (applyActiveOnly && !isWithinHorizon(row.lastMessageAt)) return false;
      if (applyActiveOnly && isLikelyClosed(row)) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [allRows, query, tab, category, platformFilter, favouritesOnly, priorityGroup, showAll]);

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
      if (!applyFavourite(row, favouritesOnly)) continue;
      if (!applyPriorityGroup(row, priorityGroup)) continue;
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
  }, [allRows, showAll, query, tab, category, platformFilter, favouritesOnly, priorityGroup]);
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
      }, 2200);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Could not reach the runner.";
      setClosedRefreshState({ kind: "error", message });
      window.setTimeout(() => {
        setClosedRefreshState((current) => (current.kind === "error" ? { kind: "idle" } : current));
      }, 3200);
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
    // Favourited contacts float to the top of whichever section they land in,
    // preserving the chosen sort order within the favourite / non-favourite
    // split (R-0066 / #483). Applied per-section so a favourite never jumps
    // its risk bucket.
    const ordered = (rows: InboxRow[]) => priorityContactsFirst(applySort(rows, sortMode));
    if (!grouped) {
      return [{ key: tab, label: null, items: ordered(live) }];
    }
    const byLevel = (level: InboxRow["riskLevel"]) =>
      ordered(live.filter((row) => row.riskLevel === level));
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
  const renderedSections = useMemo(
    () => windowInboxSections(sections, visibleRowLimit),
    [sections, visibleRowLimit]
  );
  const renderedRows = useMemo(
    () => orderedRows.slice(0, visibleRowLimit),
    [orderedRows, visibleRowLimit]
  );
  const renderedRowCount = Math.min(visibleRowLimit, orderedRows.length);
  const hasMoreRows = renderedRowCount < orderedRows.length;

  useEffect(() => {
    setVisibleRowLimit(INBOX_INITIAL_VISIBLE_ROWS);
  }, [query, tab, category, platformFilter, favouritesOnly, priorityGroup, showAll, sortMode]);

  // Only platforms the operator actually uses (connected at least once) raise
  // an error banner; a never-connected platform is "not set up". (issue #708)
  const degraded = platforms.find(isDegradedAndInUse);

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
      // Only membership-changing actions (mark-done / snooze) optimistically
      // hide their rows: applyInbox self-heals removedIds by keeping ids whose
      // row is gone or whose needsReply flipped to false. Rescan does neither
      // (it just re-parses messages), so optimistically removing a still-needs-
      // reply thread would strand it in removedIds until a full reload. For
      // those actions we skip the add and let refresh() update the row in place.
      const removesRow = bulkActionRemovesRow(label);
      if (removesRow) {
        setRemovedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.add(id));
          return next;
        });
      }
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
        // Mirror the optimistic add: only roll the failed ids back out of
        // removedIds for actions that put them there in the first place.
        if (removesRow) {
          setRemovedIds((prev) => {
            const next = new Set(prev);
            failedIds.forEach((id) => next.delete(id));
            return next;
          });
        }
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

      {/* Explains bare phone numbers when this Mac's Contacts app is empty
          (issue #676). Renders nothing unless the runner confirms it. */}
      <MacContactsHint />

      {/* Ghost search — a subtle field, not a heavy box (the redesign's
          calmer default). The border darkens on hover/focus; a clear
          button appears once there's a query. */}
      <label
        className={cn(
          "mb-[16px] flex items-center gap-[10px] rounded-[12px] border bg-transparent px-[14px] py-[10px] transition-colors duration-calm",
          query
            ? "border-hairline-strong"
            : "border-hairline hover:border-hairline-strong focus-within:border-ink-3 focus-within:bg-paper"
        )}
      >
        <Search className="h-[16px] w-[16px] shrink-0 text-ink-3" strokeWidth={1.6} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people, keywords…"
          autoComplete="off"
          className="flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="shrink-0 p-[2px] text-ink-3 transition-colors duration-calm hover:text-ink"
          >
            <XIcon />
          </button>
        ) : null}
      </label>

      {/* Status tabs (the lens you switch most) + a compact tools cluster.
          Platform + Kind now live behind the Filters popover so this bar
          stays one calm row instead of the old stack of dropdowns. On
          phone the tools sit above a horizontally-scrollable tab strip
          (no wrap) so the bar stays two calm rows instead of a tall pile. */}
      <div className="flex flex-col-reverse gap-1 border-b border-hairline sm:flex-row sm:flex-wrap sm:items-end sm:gap-[14px]">
        <div className="flex min-w-0 flex-1 gap-[1px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-x-visible">
          {TABS.map((entry) => {
            const active = tab === entry.key;
            const count = counts[entry.key];
            const zero = count === 0;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setTab(entry.key)}
                className={cn(
                  "relative -mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-[14px] py-[10px] text-[13px] transition-colors duration-calm",
                  active
                    ? "border-accent font-medium text-ink"
                    : zero
                      ? "text-ink-4 hover:text-ink-2"
                      : "text-ink-3 hover:text-ink"
                )}
              >
                {entry.label}
                <span
                  className={cn(
                    "ml-[5px] font-mono text-[11px]",
                    active ? "text-accent-ink" : "text-ink-3"
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-[4px] pb-[6px]">
          <SortMenu value={sortMode} options={SORT_MODES} onChange={setSortMode} />
          <FiltersPopover
            platformOptions={platformFilterOptions}
            platformFilter={platformFilter}
            category={category}
            favouritesOnly={favouritesOnly}
            priorityGroup={priorityGroup}
            priorityGroups={priorityGroups}
            onPlatform={setPlatformFilter}
            onCategory={setCategory}
            onFavouritesOnly={setFavouritesOnly}
            onPriorityGroup={setPriorityGroup}
            onClear={() => {
              setPlatformFilter("all");
              setCategory("any");
              setFavouritesOnly(false);
              setPriorityGroup("all");
            }}
          />
          {orderedRows.length > 0 || selectMode ? (
            <button
              type="button"
              onClick={() => (selectMode ? clearSelection() : setForceSelectMode(true))}
              className={cn(TOOL_CLASS, selectMode ? "bg-paper-2 text-ink" : "")}
              aria-pressed={selectMode}
            >
              <SelectGlyph />
              <span>Select</span>
            </button>
          ) : null}
        </div>
      </div>

      <ChipsRow
        platformFilter={platformFilter}
        category={category}
        favouritesOnly={favouritesOnly}
        priorityGroup={priorityGroup}
        onClearPlatform={() => setPlatformFilter("all")}
        onClearCategory={() => setCategory("any")}
        onClearFavourites={() => setFavouritesOnly(false)}
        onClearPriorityGroup={() => setPriorityGroup("all")}
        onClearAll={() => {
          setPlatformFilter("all");
          setCategory("any");
          setFavouritesOnly(false);
          setPriorityGroup("all");
        }}
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
        <p className="mb-6 rounded-row border border-hairline bg-paper-2 px-4 py-3 text-[12px] leading-[1.5] text-ink-2">{error}</p>
      ) : null}

      {bulkResult ? (
        <p className="mb-6 font-mono text-[11px] text-ink-3">{bulkResult}</p>
      ) : null}

      {/* Focus Reply Buffer: covered threads that arrived during the active
          window sit above the normal list with a one-tap acknowledgement.
          Renders nothing when no window is active or nothing qualifies. */}
      <FocusInboxGroup rows={allRows} onChanged={refresh} />

      {!loaded ? (
        <BrandLoader className="py-1" />
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
          title={
            query || tab !== "all" || category !== "any" || favouritesOnly || priorityGroup !== "all"
              ? "Nothing matches that filter."
              : "You’re caught up."
          }
          body={
            query || tab !== "all" || category !== "any" || favouritesOnly || priorityGroup !== "all"
              ? "Clear the filter or try a different search."
              : "No conversations need you right now."
          }
        />
      ) : (
        <>
          {grouped ? (
            renderedSections.map((section, index) => (
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
                      onToggleFavourite={toggleFavourite}
                    />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <div className="mt-4 flex flex-col">
              {renderedRows.map((row) => (
                <InboxRowItem
                  key={row.id}
                  row={row}
                  selectMode={selectMode}
                  selected={selectedSet.has(row.id)}
                  onToggle={toggleId}
                  onToggleFavourite={toggleFavourite}
                />
              ))}
            </div>
          )}
        </>
      )}

      {loaded && hasMoreRows ? (
        <div className="mt-8 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => setVisibleRowLimit((current) => nextInboxVisibleCount(current, orderedRows.length))}
            className="rounded-pill border border-hairline bg-paper px-4 py-2 text-[13px] font-medium text-ink transition-colors duration-calm hover:bg-paper-2"
          >
            Show {Math.min(INBOX_INITIAL_VISIBLE_ROWS, orderedRows.length - renderedRowCount)} more
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3" aria-live="polite">
            {renderedRowCount} of {orderedRows.length}
          </span>
        </div>
      ) : null}

      {loaded ? (
        <div className="mt-14 flex flex-col items-center gap-3 border-t border-hairline pt-6">
          {/* Older / closed set-aside disclosure — an end-of-list affordance
              (moved here from the header per the redesign), sitting next to
              View archived threads where end-of-list disclosures belong. */}
          {!query.trim() && (showAll || hiddenByHorizon > 0) ? (
            <p className="m-0 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
              {showAll ? (
                <span>
                  Showing all conversations.{" "}
                  <button
                    type="button"
                    onClick={() => setShowAll(false)}
                    className="underline underline-offset-2 transition-colors duration-calm hover:text-ink"
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
                    className="underline underline-offset-2 transition-colors duration-calm hover:text-ink"
                  >
                    Show all
                  </button>
                </span>
              )}
              {/* #287 F1: trigger AI close-status classification for threads
                  never classified (or pre-dating the v2 cache with reasons). */}
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

      {receiptsEverOpened ? (
        <ReceiptsDrawer
          open={receiptsOpen}
          onClose={() => setReceiptsOpen(false)}
          rows={logs}
          title="Inbox receipts"
        />
      ) : null}
    </Canvas>
  );
}

// Filters: Platform + Kind collapsed into one popover with an active-count
// badge — replacing the old stack of inline <select>s (the "convoluted"
// part Richard flagged).
function FiltersPopover({
  platformOptions,
  platformFilter,
  category,
  favouritesOnly,
  priorityGroup,
  priorityGroups,
  onPlatform,
  onCategory,
  onFavouritesOnly,
  onPriorityGroup,
  onClear
}: {
  platformOptions: { key: PlatformFilter; label: string }[];
  platformFilter: PlatformFilter;
  category: CategoryFilter;
  favouritesOnly: boolean;
  priorityGroup: PriorityGroupFilter;
  priorityGroups: string[];
  onPlatform: (value: PlatformFilter) => void;
  onCategory: (value: CategoryFilter) => void;
  onFavouritesOnly: (value: boolean) => void;
  onPriorityGroup: (value: PriorityGroupFilter) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const activeCount =
    (platformFilter !== "all" ? 1 : 0) +
    (category !== "any" ? 1 : 0) +
    (favouritesOnly ? 1 : 0) +
    (priorityGroup !== "all" ? 1 : 0);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(TOOL_CLASS, open ? "bg-paper-2 text-ink" : "", activeCount > 0 ? "text-accent-ink" : "")}
        aria-expanded={open}
      >
        <FilterGlyph />
        <span>Filters</span>
        {activeCount > 0 ? (
          <span className="grid h-[16px] min-w-[16px] place-items-center rounded-full bg-accent px-[4px] font-mono text-[10px] font-medium text-white">
            {activeCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-[248px] rounded-[12px] border border-hairline bg-paper p-4 shadow-pop">
          <PopSection label="Platform">
            {platformOptions.map((o) => (
              <PopOpt key={o.key} selected={platformFilter === o.key} onClick={() => onPlatform(o.key)}>
                {o.label}
              </PopOpt>
            ))}
          </PopSection>
          <div className="mt-4">
            <PopSection label="Kind">
              {CATEGORY_FILTERS.map((o) => (
                <PopOpt key={o.key} selected={category === o.key} onClick={() => onCategory(o.key)}>
                  {o.label}
                </PopOpt>
              ))}
            </PopSection>
          </div>
          <div className="mt-4">
            <PopSection label="Show">
              <PopOpt selected={!favouritesOnly} onClick={() => onFavouritesOnly(false)}>
                Everyone
              </PopOpt>
              <PopOpt selected={favouritesOnly} onClick={() => onFavouritesOnly(true)}>
                <span className="inline-flex items-center gap-[6px]">
                  <Star className="h-[12px] w-[12px]" strokeWidth={1.6} fill="currentColor" />
                  Favourites only
                </span>
              </PopOpt>
            </PopSection>
          </div>
          {priorityGroups.length > 0 ? (
            <div className="mt-4">
              <PopSection label="Group">
                <PopOpt selected={priorityGroup === "all"} onClick={() => onPriorityGroup("all")}>
                  All groups
                </PopOpt>
                {priorityGroups.map((group) => (
                  <PopOpt key={group} selected={priorityGroup === group} onClick={() => onPriorityGroup(group)}>
                    <span className="inline-flex items-center gap-[6px]">
                      <Tags className="h-[12px] w-[12px]" strokeWidth={1.6} />
                      {group}
                    </span>
                  </PopOpt>
                ))}
              </PopSection>
            </div>
          ) : null}
          <div className="mt-4 flex justify-end border-t border-hairline pt-3">
            <button
              type="button"
              onClick={onClear}
              className="font-mono text-[12px] text-ink-3 transition-colors duration-calm hover:text-accent-ink"
            >
              Clear filters
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Applied-filter chips — only rendered when a platform/kind filter is set,
// so the resting bar stays calm.
function ChipsRow({
  platformFilter,
  category,
  favouritesOnly,
  priorityGroup,
  onClearPlatform,
  onClearCategory,
  onClearFavourites,
  onClearPriorityGroup,
  onClearAll
}: {
  platformFilter: PlatformFilter;
  category: CategoryFilter;
  favouritesOnly: boolean;
  priorityGroup: PriorityGroupFilter;
  onClearPlatform: () => void;
  onClearCategory: () => void;
  onClearFavourites: () => void;
  onClearPriorityGroup: () => void;
  onClearAll: () => void;
}) {
  const chips: { key: string; label: string; value: string; onRemove: () => void }[] = [];
  if (platformFilter !== "all") {
    chips.push({
      key: "platform",
      label: "Platform",
      value: PLATFORM_FILTERS.find((p) => p.key === platformFilter)?.label ?? platformFilter,
      onRemove: onClearPlatform
    });
  }
  if (category !== "any") {
    chips.push({
      key: "kind",
      label: "Kind",
      value: CATEGORY_FILTERS.find((c) => c.key === category)?.label ?? category,
      onRemove: onClearCategory
    });
  }
  if (favouritesOnly) {
    chips.push({
      key: "favourites",
      label: "Show",
      value: "Favourites",
      onRemove: onClearFavourites
    });
  }
  if (priorityGroup !== "all") {
    chips.push({
      key: "group",
      label: "Group",
      value: priorityGroup,
      onRemove: onClearPriorityGroup
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-[14px]">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-[6px] rounded-pill border border-hairline bg-paper px-[10px] py-[4px] font-mono text-[11.5px] text-ink-2"
        >
          <span className="opacity-60">{c.label}</span>
          {c.value}
          <button
            type="button"
            onClick={c.onRemove}
            aria-label={`Remove ${c.label} filter`}
            className="ml-[1px] rounded p-[1px] opacity-70 transition-opacity duration-calm hover:opacity-100"
          >
            <XIcon />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="font-mono text-[11.5px] text-ink-3 transition-colors duration-calm hover:text-accent-ink"
      >
        Clear all
      </button>
    </div>
  );
}

interface InboxRowItemProps {
  row: InboxRow;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string, opts: { shiftKey: boolean }) => void;
  onToggleFavourite: (personId: string | undefined, next: boolean) => void;
}

const InboxRowItem = memo(function InboxRowItem({ row, selectMode, selected, onToggle, onToggleFavourite }: InboxRowItemProps) {
  const right = rightLabelFor(row);
  const dot = dotFor(row);
  const fav = row.personFavourite === true;
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
      onMouseEnter={() => prefetchThreadData(row.id)}
      onMouseLeave={() => cancelThreadPrefetch(row.id)}
      onFocus={() => prefetchThreadData(row.id)}
      onBlur={() => cancelThreadPrefetch(row.id)}
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
        {/* Phone: preview drops to its own line under the name so it gets
            the full row width instead of the 2 characters left beside the
            meta column. From sm up the two sit inline as before. */}
        <span className="flex min-w-0 flex-col gap-[1px] sm:flex-row sm:items-baseline sm:gap-[10px]">
          <span className="truncate text-[14px] font-medium tracking-[-0.005em] text-ink sm:shrink-0">
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
        {row.personGroups && row.personGroups.length > 0 ? (
          <span className="flex flex-wrap gap-1 pt-[2px]">
            {row.personGroups.slice(0, 2).map((group) => (
              <span
                key={group}
                className="inline-flex w-fit items-center gap-[4px] rounded-pill border border-hairline bg-paper px-[7px] py-[2px] font-mono text-[10.5px] text-ink-3"
              >
                <Tags className="h-[10px] w-[10px]" strokeWidth={1.7} />
                {group}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-[10px] font-mono text-[11px] text-ink-3">
        {/* Favourite star (R-0066 / #483). Filled + always visible once
            favourited (doubles as the at-a-glance marker); a quiet outline
            that fades in on row hover otherwise. Stops propagation so a tap
            toggles the favourite instead of opening the thread. */}
        <button
          type="button"
          aria-label={fav ? `Unfavourite ${row.personName}` : `Favourite ${row.personName}`}
          aria-pressed={fav}
          data-testid="inbox-favourite-toggle"
          title={fav ? "Remove favourite" : "Favourite this contact"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleFavourite(row.personId, !fav);
          }}
          className={cn(
            "-my-1 shrink-0 rounded p-[3px] transition-[color,opacity] duration-calm",
            fav
              ? "text-accent opacity-100"
              : "text-ink-4 opacity-0 hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
          )}
        >
          <Star className="h-[15px] w-[15px]" strokeWidth={1.6} fill={fav ? "currentColor" : "none"} />
        </button>
        <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${dot}`} />
        <span className={right.tone}>{right.text}</span>
      </span>
    </Link>
  );
});
