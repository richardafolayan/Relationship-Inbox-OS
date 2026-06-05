"use client";

import { useMemo, useState } from "react";

import type { InboxRow } from "@/lib/types";

interface LiveThreadPickerProps {
  candidates: InboxRow[];
  selected: string[];
  onChange: (next: string[]) => void;
}

/**
 * Lightweight search-and-tick list for live presenter mode. Operator
 * deliberately picks which real threads will be on screen during the
 * demo — there's no auto-include, so private conversations are never
 * surfaced just because they happen to be in the inbox.
 */
export function LiveThreadPicker({ candidates, selected, onChange }: LiveThreadPickerProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((row) => {
      const haystack = `${row.personName ?? ""} ${row.platform ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [candidates, query]);

  function toggle(id: string) {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else onChange([...selected, id]);
  }

  return (
    <div className="space-y-3">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a thread by name or platform"
        className="w-full rounded-pill border border-hairline bg-paper px-4 py-2 text-sm placeholder:text-ink-3 focus-visible:border-hairline-strong focus-visible:outline-none"
        data-demo-target="live-picker-search"
      />
      <div className="max-h-72 overflow-y-auto rounded-2xl border border-hairline">
        {filtered.length === 0 ? (
          <div className="p-4 text-sm text-ink-3">No matches.</div>
        ) : (
          <ul className="divide-y divide-hairline">
            {filtered.map((row) => (
              <li key={row.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-paper-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                    className="h-4 w-4"
                  />
                  <span className="flex-1 truncate text-ink">{row.personName}</span>
                  <span className="text-xs uppercase tracking-wide text-ink-3">{row.platform}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="text-xs text-ink-3">{selected.length} selected</div>
    </div>
  );
}
