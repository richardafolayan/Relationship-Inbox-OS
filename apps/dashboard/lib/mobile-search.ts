// Pure helpers for the phone full-screen Search screen (#903).
// Extracted so grouping, prioritisation, recent history, and visual-viewport
// height math can be unit-tested without React/jsdom.

import { paletteItemMatches } from "./command-palette-search";
import { normalizePreview } from "./preview";
import { PLATFORM_LABEL } from "./risk";
import type { InboxRow, PlatformName } from "./types";

export type MobileSearchGroup = "conversations" | "pages" | "actions";

export interface MobileSearchItem {
  id: string;
  /** Visible title (person name or command label). */
  label: string;
  /** Secondary line (message preview, or empty for pages/actions). */
  subtitle: string;
  group: MobileSearchGroup;
  /** Platform label for conversations; "Page" / "Action" for commands. */
  kindLabel: string;
  /** Full text used for matching (name + preview for conversations). */
  search: string;
  href?: string;
  actionId?: string;
  threadId?: string;
  platform?: PlatformName;
  personName?: string;
  avatarUrl?: string | null;
}

export interface MobileSearchSections {
  conversations: MobileSearchItem[];
  pagesAndActions: MobileSearchItem[];
}

export const MOBILE_SEARCH_RECENT_QUERIES_KEY = "inbox_os_mobile_search_queries";
export const MOBILE_SEARCH_RECENT_THREADS_KEY = "inbox_os_mobile_search_threads";
export const MOBILE_SEARCH_RECENT_QUERY_LIMIT = 8;
export const MOBILE_SEARCH_RECENT_THREAD_LIMIT = 8;
export const MOBILE_SEARCH_CONVERSATION_LIMIT = 20;
export const MOBILE_SEARCH_COMMAND_LIMIT = 8;

export interface RecentSearchThread {
  threadId: string;
  personName: string;
  platform: PlatformName;
  preview: string;
  avatarUrl?: string | null;
}

export const STATIC_SEARCH_COMMANDS: ReadonlyArray<{
  id: string;
  label: string;
  group: "pages" | "actions";
  kindLabel: string;
  href?: string;
  actionId?: string;
}> = [
  { id: "today", label: "Go to Today", group: "pages", kindLabel: "Page", href: "/today" },
  { id: "inbox", label: "Go to Inbox", group: "pages", kindLabel: "Page", href: "/inbox" },
  { id: "archived", label: "Go to Archived", group: "pages", kindLabel: "Page", href: "/archived" },
  { id: "settings", label: "Go to Settings", group: "pages", kindLabel: "Page", href: "/settings" },
  { id: "scan-now", label: "Run scan now", group: "actions", kindLabel: "Action", actionId: "scan-now" },
  {
    id: "scan-full",
    label: "Full LinkedIn rescan · advanced · rechecks every thread",
    group: "actions",
    kindLabel: "Action",
    actionId: "scan-full"
  },
  {
    id: "send-feedback",
    label: "Send feedback",
    group: "actions",
    kindLabel: "Action",
    actionId: "send-feedback"
  },
  {
    id: "report-bug",
    label: "Report a bug",
    group: "actions",
    kindLabel: "Action",
    actionId: "report-bug"
  }
];

export function conversationFromRow(thread: InboxRow): MobileSearchItem {
  const preview = normalizePreview(thread.preview);
  return {
    id: `thread-${thread.id}`,
    label: thread.personName,
    subtitle: preview,
    group: "conversations",
    kindLabel: PLATFORM_LABEL[thread.platform] ?? thread.platform,
    search: `${thread.personName} ${preview}`,
    href: `/thread/${thread.id}`,
    threadId: thread.id,
    platform: thread.platform,
    personName: thread.personName,
    avatarUrl: thread.personAvatarUrl
  };
}

export function commandItems(): MobileSearchItem[] {
  return STATIC_SEARCH_COMMANDS.map((cmd) => ({
    id: cmd.id,
    label: cmd.label,
    subtitle: "",
    group: cmd.group,
    kindLabel: cmd.kindLabel,
    search: cmd.label,
    href: cmd.href,
    actionId: cmd.actionId
  }));
}

export function conversationFromRecent(entry: RecentSearchThread): MobileSearchItem {
  const preview = normalizePreview(entry.preview);
  return {
    id: `thread-${entry.threadId}`,
    label: entry.personName,
    subtitle: preview,
    group: "conversations",
    kindLabel: PLATFORM_LABEL[entry.platform] ?? entry.platform,
    search: `${entry.personName} ${preview}`,
    href: `/thread/${entry.threadId}`,
    threadId: entry.threadId,
    platform: entry.platform,
    personName: entry.personName,
    avatarUrl: entry.avatarUrl
  };
}

/**
 * Build grouped mobile search results. Conversations always come first;
 * pages and actions are a quieter secondary section. Empty query shows a
 * short default set (recent-friendly); a non-empty query filters both groups.
 */
export function buildMobileSearchSections(options: {
  threads: readonly InboxRow[];
  query: string;
  recentThreads?: readonly RecentSearchThread[];
  conversationLimit?: number;
  commandLimit?: number;
}): MobileSearchSections {
  const conversationLimit = options.conversationLimit ?? MOBILE_SEARCH_CONVERSATION_LIMIT;
  const commandLimit = options.commandLimit ?? MOBILE_SEARCH_COMMAND_LIMIT;
  const q = options.query.trim();
  const commands = commandItems();

  if (!q) {
    const recent = (options.recentThreads ?? []).map(conversationFromRecent);
    const recentIds = new Set(recent.map((item) => item.threadId));
    const fresh = options.threads
      .filter((row) => !recentIds.has(row.id))
      .map(conversationFromRow);
    const conversations = [...recent, ...fresh].slice(0, conversationLimit);
    return {
      conversations,
      pagesAndActions: commands.slice(0, commandLimit)
    };
  }

  const conversations = options.threads
    .map(conversationFromRow)
    .filter((item) => paletteItemMatches(item, q))
    .slice(0, conversationLimit);

  const pagesAndActions = commands
    .filter((item) => paletteItemMatches(item, q))
    .slice(0, commandLimit);

  return { conversations, pagesAndActions };
}

export function flattenMobileSearchSections(sections: MobileSearchSections): MobileSearchItem[] {
  // Conversations first so keyboard/list order matches visual hierarchy.
  return [...sections.conversations, ...sections.pagesAndActions];
}

export function parseRecentQueries(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MOBILE_SEARCH_RECENT_QUERY_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecentQuery(existing: readonly string[], query: string): string[] {
  const next = query.trim();
  if (!next) return [...existing].slice(0, MOBILE_SEARCH_RECENT_QUERY_LIMIT);
  const without = existing.filter((entry) => entry.toLowerCase() !== next.toLowerCase());
  return [next, ...without].slice(0, MOBILE_SEARCH_RECENT_QUERY_LIMIT);
}

export function parseRecentThreads(raw: string | null | undefined): RecentSearchThread[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RecentSearchThread[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.threadId !== "string" || !row.threadId) continue;
      if (typeof row.personName !== "string" || !row.personName) continue;
      if (typeof row.platform !== "string" || !row.platform) continue;
      out.push({
        threadId: row.threadId,
        personName: row.personName,
        platform: row.platform as PlatformName,
        preview: typeof row.preview === "string" ? row.preview : "",
        avatarUrl: typeof row.avatarUrl === "string" ? row.avatarUrl : null
      });
      if (out.length >= MOBILE_SEARCH_RECENT_THREAD_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function rememberRecentThread(
  existing: readonly RecentSearchThread[],
  entry: RecentSearchThread
): RecentSearchThread[] {
  if (!entry.threadId) return [...existing].slice(0, MOBILE_SEARCH_RECENT_THREAD_LIMIT);
  const without = existing.filter((row) => row.threadId !== entry.threadId);
  return [entry, ...without].slice(0, MOBILE_SEARCH_RECENT_THREAD_LIMIT);
}

/**
 * Parse body CSS zoom for pre-zoom px lengths. Explicit px under body { zoom }
 * are pre-zoom; divide visualViewport measurements by this factor (#921 / #903).
 */
export function readCssZoom(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : 1;
  }
  if (!value) return 1;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Height available above the on-screen keyboard. Uses visualViewport when
 * present (iOS Safari shrinks it as the keyboard rises); falls back to the
 * layout viewport otherwise. Callers apply this as the screen container
 * height so the fixed field and result list stay above the keyboard.
 *
 * Under body { zoom: var(--effective-zoom) }, explicit px lengths are pre-zoom
 * and must be divided by effective zoom (same class of fix as #921).
 */
export function resolveVisualViewportHeight(input: {
  visualHeight?: number | null;
  layoutHeight?: number | null;
  effectiveZoom?: number | string | null;
}): number | null {
  const zoom = readCssZoom(input.effectiveZoom ?? 1);
  const visual = input.visualHeight;
  if (typeof visual === "number" && Number.isFinite(visual) && visual > 0) {
    return visual / zoom;
  }
  const layout = input.layoutHeight;
  if (typeof layout === "number" && Number.isFinite(layout) && layout > 0) {
    return layout / zoom;
  }
  return null;
}

/**
 * Offset the fixed screen so it tracks visualViewport.offsetTop while iOS pans.
 * Divides by effective zoom so top matches height under body { zoom }.
 */
export function resolveVisualViewportOffset(
  offsetTop?: number | null,
  effectiveZoom?: number | string | null
): number {
  const zoom = readCssZoom(effectiveZoom ?? 1);
  if (typeof offsetTop === "number" && Number.isFinite(offsetTop) && offsetTop > 0) {
    return offsetTop / zoom;
  }
  return 0;
}

export function isPhoneSearchWidth(width: number): boolean {
  return width < 768;
}

// App-owned return path for /search (#903 review). history.length is not a
// safe Back signal: direct opens, Home Screen launches, restored tabs and
// external referrers can all report length > 1 while the previous entry is
// outside the app. Record the last non-search in-app href (pathname + search
// + hash); Close always routes inside the app, falling back to /today.
export const MOBILE_SEARCH_RETURN_KEY = "search:return";
export const MOBILE_SEARCH_RETURN_FALLBACK = "/today";
// Result list scroll is restored when browser Back returns to Search after
// opening a conversation. Query lives in the /search?q= URL so history keeps it.
export const MOBILE_SEARCH_SCROLL_KEY = "search:scroll";
export const MOBILE_SEARCH_QUERY_PARAM = "q";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Pathname only, stripping ?query and #hash for route checks. */
export function pathnameOnly(href: string): string {
  const noHash = href.split("#")[0] ?? href;
  return noHash.split("?")[0] ?? noHash;
}

/**
 * Build a full in-app href from pathname, search, and hash pieces.
 * search may be with or without a leading "?"; hash with or without "#".
 */
export function buildInAppHref(
  pathname: string | null | undefined,
  search?: string | null,
  hash?: string | null
): string {
  const path = (pathname ?? "").trim() || "/";
  let href = path.startsWith("/") ? path : `/${path}`;
  const q = (search ?? "").trim();
  if (q && q !== "?") {
    href += q.startsWith("?") ? q : `?${q}`;
  }
  const h = (hash ?? "").trim();
  if (h && h !== "#") {
    href += h.startsWith("#") ? h : `#${h}`;
  }
  return href;
}

function isSafeAppPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const offOrigin = /^\/[\\/]/;
  if (offOrigin.test(path)) return false;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (offOrigin.test(decoded)) return false;
  // Reject protocol / scheme smuggling via query or hash too.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path.slice(1))) return false;
  const route = pathnameOnly(path);
  const decodedRoute = pathnameOnly(decoded);
  if (route === "/search" || route.startsWith("/search/")) return false;
  if (decodedRoute === "/search" || decodedRoute.startsWith("/search/")) return false;
  return true;
}

/** Remember the latest non-search in-app href so Close can restore query/hash. */
export function recordSearchReturn(
  href: string | null | undefined,
  storage: StorageLike | null = defaultSessionStorage()
): void {
  if (!storage || !href) return;
  if (!isSafeAppPath(href)) return;
  try {
    storage.setItem(MOBILE_SEARCH_RETURN_KEY, href);
  } catch {
    // Optional polish; ignore quota / security errors.
  }
}

/**
 * Resolve where Close / Cancel should go. Always an in-app path.
 * Defaults to /today when no app-owned predecessor was recorded
 * (direct entry, external referrer, empty session).
 */
export function resolveSearchCloseTarget(
  storage: StorageLike | null = defaultSessionStorage()
): string {
  if (!storage) return MOBILE_SEARCH_RETURN_FALLBACK;
  let stored: string | null = null;
  try {
    stored = storage.getItem(MOBILE_SEARCH_RETURN_KEY);
  } catch {
    return MOBILE_SEARCH_RETURN_FALLBACK;
  }
  if (!stored || !isSafeAppPath(stored)) return MOBILE_SEARCH_RETURN_FALLBACK;
  return stored;
}

/**
 * Close target for Search. Always an in-app path from the recorded return
 * route (or /today). Never consult history.length: that can leave the app
 * on direct entry, Home Screen launch, restored tabs, or external referrers.
 * Callers should router.replace (not push) so Close does not stack a second
 * predecessor and bounce Search on system Back.
 */
export function resolveSearchCloseHref(
  storage: StorageLike | null = defaultSessionStorage()
): string {
  return resolveSearchCloseTarget(storage);
}

/** Read q from a search string or URLSearchParams-like value. */
export function readSearchQueryParam(
  search: string | URLSearchParams | null | undefined
): string {
  if (search == null) return "";
  if (typeof search === "string") {
    const raw = search.startsWith("?") ? search.slice(1) : search;
    try {
      return new URLSearchParams(raw).get(MOBILE_SEARCH_QUERY_PARAM) ?? "";
    } catch {
      return "";
    }
  }
  return search.get(MOBILE_SEARCH_QUERY_PARAM) ?? "";
}

/** Build the Search history href that preserves the current query. */
export function buildSearchHistoryHref(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "/search";
  return `/search?${MOBILE_SEARCH_QUERY_PARAM}=${encodeURIComponent(trimmed)}`;
}

export function rememberSearchScroll(
  scrollTop: number,
  storage: StorageLike | null = defaultSessionStorage()
): void {
  if (!storage) return;
  try {
    if (!Number.isFinite(scrollTop) || scrollTop <= 0) {
      storage.removeItem?.(MOBILE_SEARCH_SCROLL_KEY);
      storage.setItem(MOBILE_SEARCH_SCROLL_KEY, "0");
      return;
    }
    storage.setItem(MOBILE_SEARCH_SCROLL_KEY, String(Math.round(scrollTop)));
  } catch {
    // optional
  }
}

export function readSearchScroll(
  storage: StorageLike | null = defaultSessionStorage()
): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(MOBILE_SEARCH_SCROLL_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * In-search attention strip (#903 adversarial). Full-screen Search sits above
 * shell TopStatus (z-90 vs z-30), so offline / degraded / in-flight work that
 * would forceSurface on /search must render inside this screen or the pilot
 * never sees it. Mirrors the same readiness signals TopStatus uses.
 */
export type SearchAttentionKind = "offline" | "degraded" | "scanning" | null;

export function resolveSearchAttentionKind(signals: {
  ready: boolean;
  runnerOffline: boolean;
  hasDegraded: boolean;
  scanning: boolean;
}): SearchAttentionKind {
  if (!signals.ready) return null;
  if (signals.runnerOffline) return "offline";
  if (signals.hasDegraded) return "degraded";
  if (signals.scanning) return "scanning";
  return null;
}
