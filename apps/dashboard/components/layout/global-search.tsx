"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Input } from "@/components/ui/input";

// Persistent thread search across the whole dashboard. Lives in the topbar so
// it's reachable from any page. Behaviour spec'd in Phase 2 of the UX overhaul:
//
//   - Typing filters /data/inbox rows in real time on personName + preview
//     (case-insensitive, substring match).
//   - Dropdown of up to 8 matches under the input.
//   - Click a row → navigate to /thread/[id].
//   - Escape clears the query and closes the dropdown.
//   - Cmd/Ctrl+K focuses the input (matches the existing CommandPalette
//     binding so keyboard users have one entry point).
//
// Data is fetched once on first focus and then re-fetched on /events
// "runner-resync" or every 30s while the dropdown is open. We don't poll
// continuously while the input isn't focused — there's no point.
const MAX_RESULTS = 8;
const REFETCH_INTERVAL_MS = 30_000;

export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const inbox = await apiGet<InboxResponse>("/runner/data/inbox");
      setRows(inbox.rows);
    } catch {
      // Search is non-critical UI; on fetch error keep whatever rows we
      // already have (or empty). Don't surface to the user — they're typing.
    }
  }, []);

  // Fetch on first open + at intervals while open.
  useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), REFETCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  // Cmd/Ctrl+K focuses the input. Matches the existing app-shell binding for
  // the command palette — both surfaces are valid; whichever the user prefers.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside closes the dropdown.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return rows
      .filter((row) => {
        const haystack = `${row.personName} ${row.preview}`.toLowerCase();
        return haystack.includes(trimmed);
      })
      .slice(0, MAX_RESULTS);
  }, [rows, query]);

  // Reset highlight when results change.
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered]);

  const navigateToResult = useCallback(
    (row: InboxRow) => {
      setQuery("");
      setOpen(false);
      router.push(`/thread/${row.id}`);
    },
    [router]
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || filtered.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = filtered[activeIndex];
      if (target) navigateToResult(target);
    }
  };

  const showDropdown = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className="relative max-w-lg flex-1">
      <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
      <Input
        ref={inputRef}
        className="pl-9"
        placeholder="Search people, keywords…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-autocomplete="list"
        aria-expanded={showDropdown}
      />
      {showDropdown ? (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500">No matches.</p>
          ) : (
            filtered.map((row, idx) => (
              <button
                key={row.id}
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => navigateToResult(row)}
                className={`flex w-full items-start gap-3 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 ${
                  idx === activeIndex ? "bg-slate-50" : "bg-white"
                }`}
              >
                <span
                  className={`mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                    row.lastMessageDirection === "OUT"
                      ? "bg-emerald-500"
                      : row.needsReply
                        ? "bg-rose-500"
                        : "bg-slate-300"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">{row.personName}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {row.lastMessageDirection === "OUT" ? "You: " : ""}
                    {row.preview}
                  </span>
                </span>
                <span className="text-[11px] uppercase tracking-wide text-slate-400">{row.platform}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
