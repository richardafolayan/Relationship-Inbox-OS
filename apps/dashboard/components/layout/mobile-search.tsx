"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Search, X } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { openPilotFeedback } from "@/lib/pilot";
import { PersonAvatar } from "@/components/common/person-avatar";
import {
  buildMobileSearchSections,
  MOBILE_SEARCH_RECENT_QUERIES_KEY,
  MOBILE_SEARCH_RECENT_THREADS_KEY,
  parseRecentQueries,
  parseRecentThreads,
  rememberRecentQuery,
  rememberRecentThread,
  resolveVisualViewportHeight,
  resolveVisualViewportOffset,
  type MobileSearchItem,
  type RecentSearchThread
} from "@/lib/mobile-search";

// Full-screen Search for phone widths (#903). Not the desktop command palette:
// fixed search field, grouped results (conversations primary), Back/Cancel,
// visualViewport keyboard resize, and recent conversation history.

export function MobileSearchScreen() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<InboxResponse["rows"]>([]);
  const [recentThreads, setRecentThreads] = useState<RecentSearchThread[]>([]);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [viewportOffset, setViewportOffset] = useState(0);

  useEffect(() => {
    void apiGet<InboxResponse>("/runner/data/inbox")
      .then((data) => setThreads(data.rows))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      setRecentThreads(parseRecentThreads(window.localStorage.getItem(MOBILE_SEARCH_RECENT_THREADS_KEY)));
      setRecentQueries(parseRecentQueries(window.localStorage.getItem(MOBILE_SEARCH_RECENT_QUERIES_KEY)));
    } catch {
      // Privacy mode / blocked storage: recent history is optional.
    }
  }, []);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus({ preventScroll: true });
    }, 50);
    return () => window.clearTimeout(focusTimer);
  }, []);

  useEffect(() => {
    const syncViewport = () => {
      const vv = window.visualViewport;
      setViewportHeight(
        resolveVisualViewportHeight({
          visualHeight: vv?.height ?? null,
          layoutHeight: window.innerHeight
        })
      );
      setViewportOffset(resolveVisualViewportOffset(vv?.offsetTop ?? null));
    };
    syncViewport();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", syncViewport);
    vv?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      vv?.removeEventListener("resize", syncViewport);
      vv?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, []);

  const sections = useMemo(
    () =>
      buildMobileSearchSections({
        threads,
        query,
        recentThreads
      }),
    [threads, query, recentThreads]
  );

  const closeSearch = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/today");
  };

  const persistQuery = (value: string) => {
    const next = rememberRecentQuery(recentQueries, value);
    setRecentQueries(next);
    try {
      window.localStorage.setItem(MOBILE_SEARCH_RECENT_QUERIES_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const persistThread = (item: MobileSearchItem) => {
    if (!item.threadId || !item.personName || !item.platform) return;
    const entry: RecentSearchThread = {
      threadId: item.threadId,
      personName: item.personName,
      platform: item.platform,
      preview: item.subtitle,
      avatarUrl: item.avatarUrl ?? null
    };
    const next = rememberRecentThread(recentThreads, entry);
    setRecentThreads(next);
    try {
      window.localStorage.setItem(MOBILE_SEARCH_RECENT_THREADS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const runAction = (actionId: string) => {
    if (actionId === "scan-now") {
      void apiPost("/runner/control/scan", { scope: "update" }).catch(() => undefined);
      return;
    }
    if (actionId === "scan-full") {
      void apiPost("/runner/control/scan", { platform: "LINKEDIN", scope: "full" }).catch(() => undefined);
      return;
    }
    if (actionId === "send-feedback") {
      openPilotFeedback("feedback");
      return;
    }
    if (actionId === "report-bug") {
      openPilotFeedback("bug");
    }
  };

  const onSelect = (item: MobileSearchItem) => {
    if (query.trim()) persistQuery(query);
    if (item.group === "conversations") persistThread(item);
    if (item.href) {
      router.push(item.href);
      return;
    }
    if (item.actionId) {
      runAction(item.actionId);
      closeSearch();
    }
  };

  const showRecentLabel = !query.trim() && recentThreads.length > 0;
  const conversationHeading = showRecentLabel ? "Recent" : "Conversations";
  const hasAny = sections.conversations.length > 0 || sections.pagesAndActions.length > 0;

  // Pin to the visual viewport so the iOS keyboard never covers the field,
  // result list, or Back/Cancel controls. Avoid bottom:0; height alone owns
  // the visible area while the keyboard is up. CSS vars keep md: overrides
  // able to win over the phone-only fixed geometry.
  const shellStyle = {
    ["--mobile-search-top" as string]: `${viewportOffset}px`,
    ["--mobile-search-height" as string]:
      viewportHeight != null ? `${viewportHeight}px` : "100dvh"
  };

  return (
    <div
      data-mobile-search-screen
      role="search"
      aria-label="Search"
      className="fixed inset-x-0 top-[var(--mobile-search-top)] z-[90] flex h-[var(--mobile-search-height)] flex-col bg-paper md:static md:inset-auto md:top-auto md:z-auto md:h-full"
      style={shellStyle}
    >
      <header className="flex flex-shrink-0 items-center gap-1 border-b border-hairline px-1 pb-1 pt-[max(6px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={closeSearch}
          aria-label="Back"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-paper-2 hover:text-ink"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={1.7} />
        </button>
        <h1 className="flex-1 text-center font-display text-[16px] font-semibold tracking-[-0.01em] text-ink">
          Search
        </h1>
        <button
          type="button"
          onClick={closeSearch}
          className="min-h-11 shrink-0 rounded-full px-3 text-[14px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
        >
          Cancel
        </button>
      </header>

      <div className="flex flex-shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
        <div className="flex min-h-[48px] min-w-0 flex-1 items-center gap-2 rounded-[14px] bg-paper-2 px-3">
          <Search className="h-[18px] w-[18px] shrink-0 text-ink-3" strokeWidth={1.7} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="min-h-[48px] min-w-0 flex-1 border-0 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-4"
            aria-label="Search conversations"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-paper-3 hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={1.7} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        data-mobile-search-results
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[max(16px,env(safe-area-inset-bottom))] pt-2"
      >
        {sections.conversations.length > 0 ? (
          <section aria-label={conversationHeading} className="mb-4">
            <h2 className="px-3 pb-1 pt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              {conversationHeading}
            </h2>
            <ul className="m-0 list-none p-0">
              {sections.conversations.map((item) => (
                <ResultRow key={item.id} item={item} onSelect={onSelect} />
              ))}
            </ul>
          </section>
        ) : null}

        {sections.pagesAndActions.length > 0 ? (
          <section aria-label="Pages and actions" className="mb-4">
            <h2 className="px-3 pb-1 pt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              Pages and actions
            </h2>
            <ul className="m-0 list-none p-0">
              {sections.pagesAndActions.map((item) => (
                <ResultRow key={item.id} item={item} onSelect={onSelect} />
              ))}
            </ul>
          </section>
        ) : null}

        {!hasAny ? (
          <p className="px-3 py-4 text-[14px] text-ink-3">
            No matching conversations. A contact appears after a conversation is synced.
          </p>
        ) : null}

        {!query.trim() && recentQueries.length > 0 ? (
          <section aria-label="Recent searches" className="mb-4">
            <h2 className="px-3 pb-1 pt-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              Recent searches
            </h2>
            <ul className="m-0 list-none p-0">
              {recentQueries.map((entry) => (
                <li key={entry}>
                  <button
                    type="button"
                    onClick={() => setQuery(entry)}
                    className="flex min-h-[48px] w-full items-center rounded-[12px] px-3 py-2 text-left text-[15px] text-ink-2 hover:bg-paper-2"
                  >
                    {entry}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ResultRow({
  item,
  onSelect
}: {
  item: MobileSearchItem;
  onSelect: (item: MobileSearchItem) => void;
}) {
  const isConversation = item.group === "conversations";
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item)}
        className="flex min-h-[56px] w-full items-center gap-3 rounded-[12px] px-3 py-2 text-left hover:bg-paper-2 active:bg-paper-3"
      >
        {isConversation ? (
          <PersonAvatar name={item.personName || item.label} avatarUrl={item.avatarUrl} size={40} />
        ) : (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-paper-2 font-mono text-[10px] uppercase tracking-[0.04em] text-ink-3">
            {item.kindLabel === "Page" ? "Pg" : "Act"}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink">{item.label}</span>
          {item.subtitle ? (
            <span className="mt-[2px] block truncate text-[13px] text-ink-3">{item.subtitle}</span>
          ) : null}
        </span>
        <span className="max-w-[88px] shrink-0 truncate text-right font-mono text-[11px] capitalize text-ink-3">
          {item.kindLabel}
        </span>
      </button>
    </li>
  );
}
