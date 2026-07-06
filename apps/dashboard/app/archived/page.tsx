"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost, ApiRequestError } from "@/lib/api";
import { useCacheSeed } from "@/lib/use-cache-seed";
import type { InboxRow } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { PLATFORM_LABEL } from "@/lib/risk";
import { PersonAvatar } from "@/components/common/person-avatar";
import { Canvas, CaughtUp } from "@/components/common/canvas";
import { cn } from "@/lib/utils";
import {
  OXBLOOD_PAGE_VARS,
  TOOL_CLASS,
  XIcon,
  FilterGlyph,
  SelectGlyph,
  useDismiss,
  SortMenu,
  PopSection,
  PopOpt
} from "@/components/common/list-controls";

interface ArchivedResponse {
  rows: InboxRow[];
}

type Outcome = "handled" | "snoozed" | "ghosted";
type OutcomeTab = "all" | Outcome;
type PlatformFilter = "all" | "LINKEDIN" | "IMESSAGE" | "WHATSAPP";
type ArchSort = "recent" | "oldest" | "name";

const OUTCOME_TABS: { key: OutcomeTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "handled", label: "Handled" },
  { key: "snoozed", label: "Snoozed" },
  { key: "ghosted", label: "Ghosted" }
];

const OUTCOME_GROUPS: { key: Outcome; label: string }[] = [
  { key: "handled", label: "Handled" },
  { key: "snoozed", label: "Snoozed" },
  { key: "ghosted", label: "Ghosted" }
];

// WhatsApp is opt-in: the archived view only surfaces its chip when there
// are actually archived WhatsApp threads to filter to (see platformOptions
// in the page component). ChipsRow still reads labels from the full list.
const PLATFORM_FILTERS: { key: PlatformFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "IMESSAGE", label: "iMessage" },
  { key: "LINKEDIN", label: "LinkedIn" },
  { key: "WHATSAPP", label: "WhatsApp" }
];

const ARCH_SORTS: { key: ArchSort; label: string }[] = [
  { key: "recent", label: "most recent" },
  { key: "oldest", label: "oldest first" },
  { key: "name", label: "name A-Z" }
];

// A future "until <when>" label for a snoozed thread: a weekday inside the
// week ("until Monday"), a short date beyond it ("until 12 Jun").
function untilLabel(ts: number): string {
  const days = (ts - Date.now()) / 86_400_000;
  const date = new Date(ts);
  if (days <= 7) return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

// The outcome is the organising principle of the archive. Inferred from row
// signals — a live snooze → snoozed; the operator spoke last → handled; an
// old inbound-last thread → ghosted — each with a short human note.
function archiveOutcome(row: InboxRow): { key: Outcome; note: string | null } {
  const snoozeUntil = row.snoozedUntil ?? row.scheduledSendAt ?? null;
  if (snoozeUntil) {
    const ts = Date.parse(snoozeUntil);
    if (Number.isFinite(ts) && ts > Date.now()) {
      return { key: "snoozed", note: `until ${untilLabel(ts)}` };
    }
    return { key: "snoozed", note: null };
  }
  if (row.lastMessageDirection === "OUT") {
    return { key: "handled", note: "you replied" };
  }
  if (row.archivedAt && row.lastInboundAt) {
    const archivedTs = Date.parse(row.archivedAt);
    const inboundTs = Date.parse(row.lastInboundAt);
    if (
      Number.isFinite(archivedTs) &&
      Number.isFinite(inboundTs) &&
      archivedTs - inboundTs > 30 * 86_400_000
    ) {
      return { key: "ghosted", note: "no reply" };
    }
  }
  return { key: "handled", note: null };
}

function outcomeDot(outcome: Outcome): string {
  if (outcome === "handled") return "bg-risk-fresh"; // green
  if (outcome === "snoozed") return "bg-risk-waiting"; // amber
  return "bg-ink-4"; // ghosted → muted grey
}

function monthLabel(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return "Unknown";
  return new Date(ts).toLocaleDateString([], { month: "long", year: "numeric" });
}

function archivedTs(row: InboxRow): number {
  const ts = Date.parse(row.archivedAt ?? row.lastMessageAt ?? "");
  return Number.isFinite(ts) ? ts : 0;
}

function applyArchSort(items: InboxRow[], sort: ArchSort): InboxRow[] {
  const copy = [...items];
  if (sort === "name") return copy.sort((a, b) => a.personName.localeCompare(b.personName));
  if (sort === "oldest") return copy.sort((a, b) => archivedTs(a) - archivedTs(b));
  return copy.sort((a, b) => archivedTs(b) - archivedTs(a)); // most recent
}

// Archived — the graveyard of closed threads, organised by OUTCOME
// (handled / snoozed / ghosted) rather than time. Consolidated filter bar
// (status tabs + Sort + a Platform-only Filters popover + Select), grouped
// sections, and a calm foot note. Threads land here from Inbox; nothing is
// deleted automatically.
export default function ArchivedPage() {
  // Seed from the shared client cache so returning to Archived paints the
  // last-known list instantly (refresh below revalidates immediately). Read
  // via useCacheSeed (NOT a useState initializer) so a warm cache can never
  // leak into the hydration render and mismatch the server HTML.
  const archivedSeed = useCacheSeed<ArchivedResponse>("/runner/data/archived");
  const [rowsState, setRows] = useState<InboxRow[] | null>(null);
  const rows = rowsState ?? archivedSeed?.rows ?? null;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<OutcomeTab>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [sortMode, setSortMode] = useState<ArchSort>("recent");

  // WhatsApp is opt-in, so its chip only appears once there are archived
  // WhatsApp threads to filter to. Keeps the popover at two platforms for
  // pilots who never linked it.
  const platformOptions = useMemo(() => {
    const showWhatsApp = (rows ?? []).some((row) => row.platform === "WHATSAPP");
    return PLATFORM_FILTERS.filter((option) => option.key !== "WHATSAPP" || showWhatsApp);
  }, [rows]);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [forceSelectMode, setForceSelectMode] = useState(false);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const lastToggledRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // SWR: paint the cached list immediately, revalidate in the background.
      const response = await apiGet<ArchivedResponse>("/runner/data/archived", {
        swr: true,
        onFresh: (d) => {
          setRows((d as ArchivedResponse).rows);
          setError(null);
        }
      });
      setRows(response.rows);
      setError(null);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error ? refreshError.message : "Failed to load archived threads"
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Per-tab outcome counts, scoped to the active platform filter so the
  // badges track the current lens (search is transient and left out).
  const counts = useMemo(() => {
    const base = { all: 0, handled: 0, snoozed: 0, ghosted: 0 };
    if (!rows) return base;
    for (const row of rows) {
      if (platformFilter !== "all" && row.platform !== platformFilter) continue;
      base.all += 1;
      base[archiveOutcome(row).key] += 1;
    }
    return base;
  }, [rows, platformFilter]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (removedIds.has(row.id)) return false;
      if (platformFilter !== "all" && row.platform !== platformFilter) return false;
      if (tab !== "all" && archiveOutcome(row).key !== tab) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q) ||
        PLATFORM_LABEL[row.platform].includes(q)
      );
    });
  }, [rows, query, tab, platformFilter, removedIds]);

  // "All" mixes outcomes, so it's bucketed into outcome sections; a single
  // outcome tab renders one flat list.
  const grouped = tab === "all";
  const sections = useMemo(() => {
    if (!grouped) {
      return [{ key: tab, label: null as string | null, items: applyArchSort(visible, sortMode) }];
    }
    return OUTCOME_GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      items: applyArchSort(
        visible.filter((row) => archiveOutcome(row).key === group.key),
        sortMode
      )
    })).filter((section) => section.items.length > 0);
  }, [visible, grouped, tab, sortMode]);

  const orderedIds = useMemo(
    () => sections.flatMap((section) => section.items.map((row) => row.id)),
    [sections]
  );

  const oldestMonthLabel = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const ts = archivedTs(row);
      if (ts > 0 && ts < oldest) oldest = ts;
    }
    return oldest === Number.POSITIVE_INFINITY ? null : monthLabel(new Date(oldest).toISOString());
  }, [rows]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectMode = forceSelectMode || selectedIds.length > 0;

  const toggleId = useCallback(
    (id: string, opts: { shiftKey: boolean }) => {
      setSelectedIds((prev) => {
        const set = new Set(prev);
        if (opts.shiftKey && lastToggledRef.current && lastToggledRef.current !== id) {
          const a = orderedIds.indexOf(lastToggledRef.current);
          const b = orderedIds.indexOf(id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (const rangeId of orderedIds.slice(lo, hi + 1)) set.add(rangeId);
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
    [orderedIds]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setForceSelectMode(false);
    lastToggledRef.current = null;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectMode) clearSelection();
      if (selectMode && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(orderedIds);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, orderedIds, clearSelection]);

  // Bulk restore: optimistically drop the rows, then unarchive each. On any
  // failure the failed ids are put back so they don't silently vanish.
  const restoreSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkPending(true);
    setRemovedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    const results = await Promise.allSettled(
      ids.map((id) => apiPost(`/runner/control/thread/${id}/unarchive`, {}))
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
      const firstReason = results
        .map((r) => (r.status === "rejected" ? (r.reason as Error | ApiRequestError) : null))
        .find(Boolean);
      setError(
        `Restore: ${ids.length - failedIds.size} ok, ${failedIds.size} failed (${
          firstReason instanceof Error ? firstReason.message : "Unknown"
        })`
      );
    }
    setBulkPending(false);
    clearSelection();
    void refresh();
  }, [selectedIds, clearSelection, refresh]);

  const isEmpty = !rows || rows.length === 0;

  return (
    <Canvas style={OXBLOOD_PAGE_VARS}>
      <Link
        href="/inbox"
        className="mb-[16px] inline-flex items-center gap-[5px] font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:text-ink"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to inbox
      </Link>

      <header className="mb-[20px] flex items-start justify-between gap-6">
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            Done &amp; dusted
          </p>
          <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.04] tracking-[-0.035em]">
            Archived
          </h1>
        </div>
        {rows && rows.length > 0 ? (
          <div className="shrink-0 pt-1 text-right font-mono text-[12.5px] text-ink-3">
            <strong className="font-medium text-ink">{visible.length}</strong> of {rows.length} threads
            {oldestMonthLabel ? (
              <>
                <br />
                oldest {oldestMonthLabel}
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      {error ? <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p> : null}

      {isEmpty ? (
        <CaughtUp title="No archived threads yet." body="Threads you mark as handled land here." />
      ) : (
        <>
          {/* Ghost search */}
          <label
            className={cn(
              "mb-[16px] flex items-center gap-[10px] rounded-[12px] border bg-transparent px-[14px] py-[10px] transition-colors duration-calm",
              query
                ? "border-hairline-strong"
                : "border-hairline hover:border-hairline-strong focus-within:border-ink-3 focus-within:bg-paper"
            )}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" className="shrink-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4-4" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search archived threads by person, channel, or phrase…"
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

          {/* Outcome tabs + tools cluster. On phone the tools sit above a
              horizontally-scrollable tab strip (no wrap) so the bar stays
              two calm rows instead of a tall pile. */}
          <div className="flex flex-col-reverse gap-1 border-b border-hairline sm:flex-row sm:flex-wrap sm:items-end sm:gap-[14px]">
            <div className="flex min-w-0 flex-1 gap-[1px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-x-visible">
              {OUTCOME_TABS.map((entry) => {
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
              <SortMenu value={sortMode} options={ARCH_SORTS} onChange={setSortMode} />
              <PlatformPopover
                platformOptions={platformOptions}
                platformFilter={platformFilter}
                onPlatform={setPlatformFilter}
              />
              {orderedIds.length > 0 || selectMode ? (
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

          {platformFilter !== "all" ? (
            <div className="flex flex-wrap items-center gap-2 pt-[14px]">
              <span className="inline-flex items-center gap-[6px] rounded-pill border border-hairline bg-paper px-[10px] py-[4px] font-mono text-[11.5px] text-ink-2">
                <span className="opacity-60">Platform</span>
                {PLATFORM_FILTERS.find((p) => p.key === platformFilter)?.label}
                <button
                  type="button"
                  onClick={() => setPlatformFilter("all")}
                  aria-label="Remove platform filter"
                  className="ml-[1px] rounded p-[1px] opacity-70 transition-opacity duration-calm hover:opacity-100"
                >
                  <XIcon />
                </button>
              </span>
            </div>
          ) : null}

          {visible.length === 0 ? (
            <CaughtUp
              title="Nothing matches that filter."
              body="Clear the filter or try a different phrase."
            />
          ) : (
            <div className="mt-1">
              {sections.map((section) => (
                <section key={section.key}>
                  {section.label ? (
                    <header className="mb-[2px] mt-[32px] flex items-center gap-[10px] font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3 first:mt-[22px]">
                      <span>{section.label}</span>
                      <span aria-hidden className="h-px flex-1 bg-hairline" />
                      <span className="text-ink-4">{section.items.length}</span>
                    </header>
                  ) : null}
                  <div className="flex flex-col">
                    {section.items.map((row) => (
                      <ArchivedRowItem
                        key={row.id}
                        row={row}
                        selectMode={selectMode}
                        selected={selectedSet.has(row.id)}
                        onToggle={toggleId}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          {/* Bulk bar (Restore only — Delete is intentionally not wired). */}
          {selectMode ? (
            <div
              data-testid="archived-bulk-bar"
              className="sticky bottom-6 z-40 mt-3 flex items-center gap-4 rounded-[12px] bg-ink px-[18px] py-[14px] text-paper shadow-pop"
            >
              <span className="font-mono text-[13px]">{selectedIds.length} selected</span>
              <span className="flex-1" />
              <button
                type="button"
                disabled={bulkPending || selectedIds.length === 0}
                onClick={() => void restoreSelected()}
                className="rounded-[8px] bg-white/[0.12] px-[13px] py-[8px] text-[13px] transition-colors duration-calm hover:bg-white/[0.2] disabled:opacity-50"
              >
                {bulkPending ? "Restoring…" : "Restore to inbox"}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="px-[6px] py-[8px] text-[13px] text-paper/70 transition-colors duration-calm hover:text-paper"
              >
                Cancel
              </button>
            </div>
          ) : null}

          <div className="mt-9 flex flex-col items-center gap-4 pt-5 text-center">
            <p className="m-0 font-mono text-[11.5px] text-ink-3">
              Threads move here once they’re handled, snoozed out, or go cold. Nothing is deleted
              automatically.
            </p>
          </div>
        </>
      )}
    </Canvas>
  );
}

// Filters popover — Platform only (Kind isn't meaningful for an archive).
function PlatformPopover({
  platformOptions,
  platformFilter,
  onPlatform
}: {
  platformOptions: { key: PlatformFilter; label: string }[];
  platformFilter: PlatformFilter;
  onPlatform: (value: PlatformFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const activeCount = platformFilter !== "all" ? 1 : 0;
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
          <div className="mt-4 flex justify-end border-t border-hairline pt-3">
            <button
              type="button"
              onClick={() => onPlatform("all")}
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

interface ArchivedRowItemProps {
  row: InboxRow;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string, opts: { shiftKey: boolean }) => void;
}

function ArchivedRowItem({ row, selectMode, selected, onToggle }: ArchivedRowItemProps) {
  const outcome = archiveOutcome(row);
  const when = formatRelative(row.archivedAt ?? row.lastMessageAt);

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
        "group grid grid-cols-[28px_1fr_auto] items-center gap-[14px] border-b border-hairline px-1 py-[13px] transition-colors duration-calm hover:bg-paper-2",
        selected ? "bg-paper-2" : ""
      )}
    >
      {/* Avatar doubles as the select target (a check fades in on hover / in
          select mode), matching the Inbox row. */}
      <span className="relative h-7 w-7">
        <PersonAvatar name={row.personName} avatarUrl={row.personAvatarUrl} size={28} className="text-[11px]" />
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
            selectMode ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          )}
        >
          {selected ? (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.25">
              <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </button>
      </span>

      <span className="flex min-w-0 items-center gap-[12px]">
        <span className="truncate text-[14px] font-medium tracking-[-0.005em] text-ink">
          {row.personName}
        </span>
        <span className="inline-flex shrink-0 items-center gap-[7px] font-mono text-[11.5px] text-ink-3">
          <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${outcomeDot(outcome.key)}`} />
          {outcome.key}
        </span>
        {outcome.note ? (
          <span className="shrink-0 font-mono text-[11.5px] text-ink-4">{outcome.note}</span>
        ) : null}
      </span>

      <span className="flex items-center gap-[12px] font-mono text-[11px] text-ink-3">
        <span>{when}</span>
        <span className="text-ink-3">{PLATFORM_LABEL[row.platform]}</span>
      </span>
    </Link>
  );
}
