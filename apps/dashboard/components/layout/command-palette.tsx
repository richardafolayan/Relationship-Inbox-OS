"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { PLATFORM_LABEL } from "@/lib/risk";
import { normalizePreview } from "@/lib/preview";
import { openPilotFeedback } from "@/lib/pilot";

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
  run: () => void;
}

// ⌘K palette. Replaces the topbar's search and the old "run scan now"
// command rail. Two kinds of entries: page jumps and thread jumps.
// Esc closes (this is wired in app-shell so it also closes any open thread).
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<InboxResponse["rows"]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    // Index the full inbox, not just the first 30 rows. With hundreds of
    // threads the old slice(0, 30) silently dropped most contacts from
    // search — e.g. a LinkedIn thread last active 12d ago would never
    // match by name even though it's right there in the inbox (#434
    // R-0056). The list is already fetched whole for the inbox page.
    void apiGet<InboxResponse>("/runner/data/inbox")
      .then((data) => setThreads(data.rows))
      .catch(() => undefined);
  }, [open]);

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
        kind: PLATFORM_LABEL[thread.platform],
        run: () => router.push(`/thread/${thread.id}`)
      };
    });
    const all = [...pages, ...threadItems];
    if (!query.trim()) return all.slice(0, 8);
    return all.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  }, [query, router, threads]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items]);

  if (!open) return null;

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
      className="fixed inset-0 z-[100] grid place-items-start justify-items-center bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] pt-[18vh] backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-[18px] border border-hairline bg-paper shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search people, pages, or threads…"
          className="w-full border-0 border-b border-hairline bg-transparent px-5 py-[18px] text-[16px] text-ink outline-none placeholder:text-ink-4"
        />
        <ul className="m-0 list-none p-[6px]">
          {items.map((item, index) => (
            <li
              key={item.id}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                item.run();
                onClose();
              }}
              className={`flex cursor-pointer items-center gap-[10px] rounded-[10px] px-[14px] py-[10px] text-[14px] ${
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
            <li className="px-[14px] py-[10px] text-[14px] text-ink-3">No matches.</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
