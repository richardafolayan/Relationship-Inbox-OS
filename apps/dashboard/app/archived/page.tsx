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

type PlatformFilter = "all" | "LINKEDIN" | "IMESSAGE" | "WHATSAPP" | "GOOGLE_MESSAGES";
type ArchSort = "recent" | "oldest" | "name";

// WhatsApp is opt-in: the archived view only surfaces its chip when there
// are actually archived WhatsApp threads to filter to (see platformOptions
// in the page component). ChipsRow still reads labels from the full list.
const PLATFORM_FILTERS: { key: PlatformFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "IMESSAGE", label: "iMessage" },
  { key: "LINKEDIN", label: "LinkedIn" },
  { key: "WHATSAPP", label: "WhatsApp" },
  { key: "GOOGLE_MESSAGES", label: "Google Messages" }
];

const ARCH_SORTS: { key: ArchSort; label: string }[] = [
  { key: "recent", label: "most recent" },
  { key: "oldest", label: "oldest first" },
  { key: "name", label: "name A-Z" }
];

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

// Archived contains only threads the operator explicitly archived. It avoids
// inventing an outcome from message direction or age because those signals do
// not record why the thread was archived.
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
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [sortMode, setSortMode] = useState<ArchSort>("recent");

  const platformOptions = useMemo(() => {
    const available = new Set((rows ?? []).map((row) => row.platform));
    return PLATFORM_FILTERS.filter(
      (option) => option.key === "all" || available.has(option.key)
    );
  }, [rows]);

  useEffect(() => {
    if (platformFilter === "all") return;
    if (platformOptions.some((option) => option.key === platformFilter)) return;
    setPlatformFilter("all");
  }, [platformFilter, platformOptions]);

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

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (removedIds.has(row.id)) return false;
      if (platformFilter !== "all" && row.platform !== platformFilter) return false;
      if (!q) return true;
      return (
        row.personName.toLowerCase().includes(q) ||
        (row.preview ?? "").toLowerCase().includes(q) ||
        PLATFORM_LABEL[row.platform].includes(q)
      );
    });
  }, [rows, query, platformFilter, removedIds]);

  const sections = useMemo(() => {
    return [{ key: "archived", label: null as string | null, items: applyArchSort(visible, sortMode) }];
  }, [visible, sortMode]);

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

  const loading = rows === null;
  const isEmpty = rows?.length === 0;
  const hasRows = (rows?.length ?? 0) > 0;

  return (
    // Mobile (#897): same contained list shell as Inbox. Compact fixed
    // header + one search row; conversation list is the only vertical
    // scroller. Sort/platform stay in popovers. Desktop long-page stays.
    <Canvas className="flex h-full min-h-0 flex-col overflow-hidden pb-0 md:block md:h-auto md:overflow-visible md:pb-[120px]">
      <div data-testid="archived-controls" className="shrink-0">
        <Link
          href="/inbox"
          className="mb-2 inline-flex items-center gap-[5px] font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:text-ink sm:mb-[12px]"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to inbox
        </Link>

        <header className="mb-3 flex items-start justify-between gap-4 sm:mb-[20px] sm:gap-6">
          <div className="min-w-0">
            <p className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 sm:mb-1">
              Explicitly archived
            </p>
            <h1 className="m-0 font-display text-[20px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[40px] sm:leading-[1.04] sm:tracking-[-0.035em]">
              Archived
            </h1>
          </div>
          {rows && rows.length > 0 ? (
            <div className="shrink-0 pt-1 text-right font-mono text-[11px] text-ink-3 sm:text-[12.5px]">
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

        {hasRows ? (
          <label
            className={cn(
              "mb-3 flex items-center gap-[10px] rounded-[12px] border bg-transparent px-[14px] py-[9px] transition-colors duration-calm sm:mb-[16px] sm:py-[10px]",
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
              placeholder="Search archived…"
              autoComplete="off"
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
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
        ) : null}

        {hasRows ? (
          <div className="flex items-center justify-end gap-[4px] border-b border-hairline pb-[6px]">
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
        ) : null}
      </div>

      <div
        data-testid="archived-list-scroller"
        data-scroll-owner="list"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 md:overflow-visible md:pb-0"
      >
        {error ? (
          <p className="mb-4 mt-3 rounded-row border border-hairline bg-paper-2 px-4 py-3 text-[12px] leading-[1.5] text-ink-2 sm:mb-6">
            {error}
          </p>
        ) : null}

        {hasRows && platformFilter !== "all" ? (
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

        {loading && !error ? (
          <p className="py-8 text-center font-mono text-[12px] text-ink-3" role="status">
            Loading archived threads…
          </p>
        ) : loading && error ? (
          <div className="flex justify-center py-6">
            <button type="button" className={TOOL_CLASS} onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : isEmpty ? (
          <CaughtUp title="No archived threads yet." body="Threads you archive land here." />
        ) : visible.length === 0 ? (
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

        {selectMode ? (
          <div
            data-testid="archived-bulk-bar"
            className="sticky bottom-3 z-40 mt-3 flex items-center gap-4 rounded-[12px] bg-ink px-[18px] py-[14px] text-paper shadow-pop"
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

        {hasRows ? (
          <div className="mt-9 flex flex-col items-center gap-4 pt-5 text-center">
            <p className="m-0 font-mono text-[11.5px] text-ink-3">
              Only threads you archive appear here. Nothing is deleted automatically.
            </p>
          </div>
        ) : null}
      </div>
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
  const when = formatRelative(row.archivedAt ?? row.lastMessageAt);

  const onClick = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || selectMode) {
      event.preventDefault();
      onToggle(row.id, { shiftKey: event.shiftKey });
    }
  };

  return (
    <div
      className={cn(
        "group grid min-h-[56px] grid-cols-[44px_1fr] items-center gap-[10px] border-b border-hairline px-1 py-[6px] transition-colors duration-calm hover:bg-paper-2",
        selected ? "bg-paper-2" : ""
      )}
    >
      <button
        type="button"
        aria-label={selected ? `Deselect ${row.personName}` : `Select ${row.personName}`}
        aria-pressed={selected}
        onClick={(event) => onToggle(row.id, { shiftKey: event.shiftKey })}
        className="relative grid h-11 w-11 place-items-center rounded-full"
      >
        <PersonAvatar
          name={row.personName}
          avatarUrl={row.personAvatarUrl}
          size={28}
          className="text-[11px]"
        />
        <span
          className={cn(
            "absolute grid h-7 w-7 place-items-center rounded-full border transition-opacity duration-calm",
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
        </span>
      </button>

      <Link
        href={`/thread/${row.id}`}
        onClick={onClick}
        className="grid min-w-0 grid-cols-1 items-center gap-[2px] rounded-[6px] py-[7px] outline-none focus-visible:ring-2 focus-visible:ring-accent sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-[12px]"
      >
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium tracking-[-0.005em] text-ink">
            {row.personName}
          </span>
          <span className="block truncate text-[12px] text-ink-3">{row.preview}</span>
        </span>
        <span className="flex items-center gap-[10px] font-mono text-[11px] text-ink-3">
          <span>Archived {when}</span>
          <span>{PLATFORM_LABEL[row.platform]}</span>
        </span>
      </Link>
    </div>
  );
}
