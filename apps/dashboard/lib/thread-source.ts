// Issue #336 / R-0025. Remembers the most recent non-thread route so
// that archiving a thread can return the operator to wherever they came
// from (Inbox, Reconnect, Archived, etc.) rather than always bouncing
// to /today. The recorder runs from the app shell whenever the pathname
// changes; the reader is called from the thread page's archive handler.
//
// Storage is sessionStorage by default — scoped to the tab, cleared
// when the tab closes — but exposed as a parameter so the helpers can
// be exercised by node:test with a Map-backed stub.

const KEY = "thread:source";
const FALLBACK = "/today";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Some embedded contexts throw on sessionStorage access (private
    // mode, file:// URLs, restrictive iframes). Swallow and act as if
    // no storage was available — the caller falls back to /today.
    return null;
  }
}

// Records `pathname` as the latest non-thread route the operator visited.
// No-op for thread routes themselves (otherwise opening a thread would
// overwrite the source we want to navigate back to) and for missing
// storage. Other paths pass through unchanged — even unknown ones like
// /settings — because the recorder only stores routes the operator
// actually reached, so they are by definition reachable again.
export function recordThreadSource(
  pathname: string | null | undefined,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage || !pathname) return;
  if (!pathname.startsWith("/")) return;
  if (pathname.startsWith("/thread/")) return;
  try {
    storage.setItem(KEY, pathname);
  } catch {
    // QuotaExceeded or SecurityError. Coverage is a polish — drop the
    // write silently rather than escalate.
  }
}

// Returns the stored source path or `/today` when nothing safe is on
// hand. The validation rejects empty values, thread paths (defensive —
// the recorder wouldn't have written one), and anything that doesn't
// look like a local route, which closes the door on a malicious storage
// value being used as a router destination.
export function readThreadSource(
  storage: StorageLike | null = defaultStorage()
): string {
  if (!storage) return FALLBACK;
  let stored: string | null = null;
  try {
    stored = storage.getItem(KEY);
  } catch {
    return FALLBACK;
  }
  if (!stored) return FALLBACK;
  if (!stored.startsWith("/")) return FALLBACK;
  // Reject anything that resolves off-origin. A single leading slash
  // followed by a second slash OR a backslash is the protocol-relative
  // attack: browsers normalise '\\' to '/' when resolving a URL, so
  // '/\\evil.com' becomes '//evil.com' and navigates the tab to
  // evil.com. Percent-encoded variants ('/%2Fevil.com', '/%5Cevil.com')
  // decode to the same shape, so test a best-effort decoded copy too.
  const offOrigin = /^\/[\\/]/;
  if (offOrigin.test(stored)) return FALLBACK;
  let decoded = stored;
  try {
    decoded = decodeURIComponent(stored);
  } catch {
    // Malformed percent-encoding can't be a real local route; reject it.
    return FALLBACK;
  }
  if (offOrigin.test(decoded)) return FALLBACK;
  if (stored.startsWith("/thread/")) return FALLBACK;
  return stored;
}

export function canNavigateBackToSameOrigin(
  historyLength: number,
  referrer: string,
  origin: string,
  previousEntryUrl?: string
): boolean {
  if (historyLength <= 1 || !origin) return false;
  for (const candidate of [previousEntryUrl, referrer]) {
    if (!candidate) continue;
    try {
      if (new URL(candidate).origin === origin) return true;
    } catch {
      // Try the next independently sourced history candidate.
    }
  }
  return false;
}

export function readPreviousNavigationEntryUrl(navigationValue: unknown): string | undefined {
  if (!navigationValue || typeof navigationValue !== "object") return undefined;
  const navigation = navigationValue as {
    currentEntry?: unknown;
    entries?: unknown;
  };
  if (!navigation.currentEntry || typeof navigation.currentEntry !== "object") return undefined;
  const currentIndex = (navigation.currentEntry as { index?: unknown }).index;
  if (typeof currentIndex !== "number" || typeof navigation.entries !== "function") return undefined;
  try {
    const entries = navigation.entries.call(navigationValue) as unknown;
    if (!Array.isArray(entries)) return undefined;
    const previous = entries.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      return (entry as { index?: unknown }).index === currentIndex - 1;
    }) as { url?: unknown } | undefined;
    return typeof previous?.url === "string" ? previous.url : undefined;
  } catch {
    return undefined;
  }
}

export const __test = { KEY, FALLBACK };
