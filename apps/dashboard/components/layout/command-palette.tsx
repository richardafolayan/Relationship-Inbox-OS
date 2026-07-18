"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { PLATFORM_LABEL } from "@/lib/risk";
import { normalizePreview } from "@/lib/preview";
import { openPilotFeedback } from "@/lib/pilot";
import { clampActiveIndex, paletteItemMatches } from "@/lib/command-palette-search";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  // Right-column type tag. One consistent system across every row:
  // "Page" / "Action" for commands, the platform label for threads.
  // The "press enter" affordance (↵) is shown only on the active row,
  // not baked per-item — so we don't mix ↩/scan/↗ glyphs (#436 R-0058).
  kind: string;
  // Full searchable text (#132): person name + the whole latest-message
  // preview, so a number past the truncated label is still findable.
  // Omitted for page/action entries — their label is already the whole text.
  search?: string;
  run: () => void;
}

// ⌘K palette. Replaces the topbar's search and the old "run scan now"
// command rail. Two kinds of entries: page jumps and thread jumps.
// Esc closes (this is wired in app-shell so it also closes any open thread).
//
// This component is mounted once for the whole app session (it lives in
// AppShell), so its search state must not survive a close. The stateful body
// lives in CommandPalettePanel, which is mounted ONLY while open — closing
// unmounts it, so the next open always starts from a blank, fresh panel.
// Resetting state in a post-commit [open] effect instead would flash the
// previous session's typed query and stale highlight for one frame on reopen
// (P3-PL2): the reset runs after the reopen render has already committed.
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  if (!open) return null;
  return <CommandPalettePanel onClose={onClose} />;
}

function CommandPalettePanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<InboxResponse["rows"]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    // Index the full inbox, not just the first 30 rows. With hundreds of
    // threads the old slice(0, 30) silently dropped most contacts from
    // search — e.g. a LinkedIn thread last active 12d ago would never
    // match by name even though it's right there in the inbox (#434
    // R-0056). The list is already fetched whole for the inbox page.
    void apiGet<InboxResponse>("/runner/data/inbox")
      .then((data) => setThreads(data.rows))
      .catch(() => undefined);
  }, []);

  const items: PaletteItem[] = useMemo(() => {
    const pages: PaletteItem[] = [
      { id: "today", label: "Go to Today", kind: "Page", run: () => router.push("/today") },
      { id: "inbox", label: "Go to Inbox", kind: "Page", run: () => router.push("/inbox") },
      { id: "archived", label: "Go to Archived", kind: "Page", run: () => router.push("/archived") },
      { id: "settings", label: "Go to Settings", kind: "Page", run: () => router.push("/settings") },
      {
        id: "scan-now",
        label: "Run scan now",
        kind: "Action",
        run: () => {
          void apiPost("/runner/control/scan", { scope: "update" }).catch(() => undefined);
        }
      },
      {
        id: "scan-full",
        // #338/#362: label signals "advanced / rare", not a recommended
        // default. The normal "Run scan now" entry above already does
        // incremental update-mode; this entry is the opt-in escape hatch
        // for the rare case the operator wants to re-walk every persisted
        // thread (e.g. after a data migration or suspected corruption).
        label: "Full LinkedIn rescan · advanced · rechecks every thread",
        kind: "Action",
        run: () => {
          void apiPost("/runner/control/scan", { platform: "LINKEDIN", scope: "full" }).catch(() => undefined);
        }
      },
      {
        id: "send-feedback",
        label: "Send feedback",
        kind: "Action",
        run: () => openPilotFeedback("feedback")
      },
      {
        id: "report-bug",
        label: "Report a bug",
        kind: "Action",
        run: () => openPilotFeedback("bug")
      }
    ];
    const threadItems: PaletteItem[] = threads.map((thread) => {
      const preview = normalizePreview(thread.preview);
      return {
        id: `thread-${thread.id}`,
        label: `${thread.personName} - ${preview.slice(0, 60)}${preview.length > 60 ? "…" : ""}`,
        search: `${thread.personName} ${preview}`,
        kind: PLATFORM_LABEL[thread.platform],
        run: () => router.push(`/thread/${thread.id}`)
      };
    });
    const all = [...pages, ...threadItems];
    if (!query.trim()) return all.slice(0, 8);
    return all.filter((item) => paletteItemMatches(item, query)).slice(0, 12);
  }, [query, router, threads]);

  // Reset to the top match whenever the *query* changes — the best match
  // should be highlighted as the operator types.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // A *data*-driven change to the list (the inbox fetch landing after open,
  // or a background refresh) must NOT yank the selection back to the top
  // mid-keyboard-navigation (#605). Only clamp the current index back into
  // range — with no query the length is unchanged, so this is a no-op.
  useEffect(() => {
    setActiveIndex((i) => clampActiveIndex(i, items.length));
  }, [items.length]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = items[activeIndex];
      if (target) {
        target.run();
        onClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      className="fixed inset-0 z-[100] grid place-items-stretch bg-paper pt-[env(safe-area-inset-top)] sm:place-items-start sm:justify-items-center sm:bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] sm:pt-[18vh] sm:backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-paper sm:block sm:h-auto sm:w-[min(560px,92vw)] sm:rounded-[18px] sm:border sm:border-hairline sm:shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center border-b border-hairline">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search conversations, pages, or actions…"
            className="min-h-[60px] min-w-0 flex-1 border-0 bg-transparent px-4 py-[18px] text-[16px] text-ink outline-none placeholder:text-ink-4 sm:px-5"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-paper-2 hover:text-ink sm:hidden"
          >
            <X className="h-5 w-5" strokeWidth={1.7} />
          </button>
        </div>
        <ul className="app-main-scroll m-0 min-h-0 flex-1 list-none overflow-y-auto p-[6px]">
          {items.map((item, index) => (
            <li
              key={item.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                item.run();
                onClose();
              }}
              className={`flex min-h-[48px] cursor-pointer items-center gap-[10px] rounded-[10px] px-[14px] py-[10px] text-[14px] ${
                index === activeIndex ? "bg-paper-2 text-ink" : "text-ink-2"
              }`}
            >
              <span className="flex-1 truncate">{item.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-[8px] font-mono text-[11px] text-ink-3">
                <span>{item.kind}</span>
                {index === activeIndex ? (
                  <span aria-hidden className="text-ink-4">↵</span>
                ) : null}
              </span>
            </li>
          ))}
          {!items.length ? (
            <li className="px-[14px] py-[10px] text-[14px] text-ink-3">
              No matching conversations. A contact appears after a conversation is synced.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
