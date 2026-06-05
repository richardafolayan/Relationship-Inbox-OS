export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
    readonly rawText?: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function parseErrorPayload(response: Response): Promise<{ payload?: unknown; rawText?: string }> {
  const rawText = await response.text();
  if (!rawText) {
    return {};
  }

  try {
    return {
      payload: JSON.parse(rawText),
      rawText
    };
  } catch {
    return {
      rawText
    };
  }
}

/**
 * Raw GET - always hits the network with `cache: "no-store"`. This is the
 * historical `apiGet` behaviour, kept for callers that explicitly want a
 * fresh, uncached read.
 */
export async function apiGetRaw<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Lightweight client-side response cache (stale-while-revalidate).
//
// The dashboard is a thin client: every page mounts blank then fetches from
// the runner. Without a cache, switching Today <-> Inbox <-> a thread (and
// browser back/forward) re-fetches lists that were on screen a second ago,
// so navigation never feels instant. This module-level cache lets callers:
//   * paint instantly from the last value (peekCache / swr),
//   * skip the network entirely while a value is still fresh (ttlMs),
//   * de-dupe concurrent fetches of the same path into ONE request
//     (collapses the near-simultaneous app-shell poll + page fetch + hover
//     prefetch of the same endpoint), and
//   * warm a path ahead of navigation (warmApiGet, used for hover-prefetch).
//
// It is intentionally tiny and dependency-free. Keyed on the exact path
// string (including query params) so paginated reads don't collide. POSTs
// are never cached. Mutations (send / snooze / mark-done) and SSE events
// call invalidateCache / mutateCache to keep lists honest.
// ---------------------------------------------------------------------------

interface CacheEntry {
  data?: unknown;
  ts: number;
  inflight?: Promise<unknown>;
}

const responseCache = new Map<string, CacheEntry>();

/** Synchronous read of the last cached value for a path (undefined if none). */
export function peekCache<T>(path: string): T | undefined {
  return responseCache.get(path)?.data as T | undefined;
}

/** Drop a cached path (or everything) so the next read re-fetches. */
export function invalidateCache(path?: string): void {
  if (path === undefined) {
    responseCache.clear();
  } else {
    responseCache.delete(path);
  }
}

/** Write a value into the cache directly (e.g. optimistic update / SSE delta). */
export function mutateCache<T>(path: string, data: T): void {
  responseCache.set(path, { data, ts: Date.now() });
}

export type ApiGetOptions = RequestInit & {
  /** Serve the cached value without a network round-trip if younger than this. */
  ttlMs?: number;
  /**
   * Stale-while-revalidate: if a cached value exists, resolve with it
   * immediately (instant paint) AND revalidate in the background, calling
   * `onFresh` with the network value when it lands.
   */
  swr?: boolean;
  onFresh?: (data: unknown) => void;
};

/**
 * Cache-aware GET.
 *
 * Backwards compatible: `apiGet(path)` with no options always hits the
 * network (same as before) but now de-dupes in-flight requests and writes
 * the result to the shared cache so warm/peek callers benefit.
 *
 * Opt in to caching per call:
 *   apiGet(path, { ttlMs: 5000 })            // skip network while fresh
 *   apiGet(path, { swr: true, onFresh })     // paint stale now, update later
 */
export async function apiGet<T>(path: string, opts?: ApiGetOptions): Promise<T> {
  const { ttlMs = 0, swr = false, onFresh, ...init } = opts ?? {};
  const entry = responseCache.get(path);
  const hasData = entry !== undefined && entry.data !== undefined;
  const now = Date.now();

  // Fresh cache hit - no network at all.
  if (hasData && ttlMs > 0 && now - entry!.ts < ttlMs) {
    return entry!.data as T;
  }

  // Ensure exactly one in-flight request per path (de-dupe concurrent callers).
  let inflight = entry?.inflight as Promise<T> | undefined;
  if (!inflight) {
    inflight = apiGetRaw<T>(path, init)
      .then((data) => {
        responseCache.set(path, { data, ts: Date.now() });
        return data;
      })
      .catch((err) => {
        // Drop the in-flight marker but keep any prior stale value so the
        // next call retries instead of wedging on a rejected promise.
        const cur = responseCache.get(path);
        if (cur) {
          responseCache.set(path, { data: cur.data, ts: cur.ts });
        }
        throw err;
      });
    responseCache.set(path, { data: entry?.data, ts: entry?.ts ?? 0, inflight });
  }

  // Stale-while-revalidate: paint the cached value now, update via onFresh.
  if (hasData && swr) {
    inflight
      .then((fresh) => {
        onFresh?.(fresh);
      })
      .catch(() => {
        /* revalidation failure: keep the stale value already returned */
      });
    return entry!.data as T;
  }

  // No cached value (or caching not requested): await the network.
  return inflight;
}

/**
 * Fire-and-forget prefetch: warm the cache for a path without binding the
 * result to any React state. Used to prefetch a thread's data on row hover
 * so the click opens an already-loaded conversation. Errors are swallowed -
 * a failed prefetch simply means the click pays the normal fetch.
 */
export function warmApiGet(path: string, opts?: ApiGetOptions): void {
  void apiGet(path, opts).catch(() => {
    /* prefetch is best-effort */
  });
}

/**
 * Wrap a fire-and-forget action call so that:
 *  - On success, the local error state is cleared and an optional follow-up
 *    (e.g. `refresh()`) runs.
 *  - On failure, the error message is captured into the caller's `setError`
 *    state and logged with a `[action]` tag - instead of bubbling out as an
 *    unhandled promise rejection that Next.js's dev overlay counts toward
 *    the "X errors" badge.
 *
 * Use this anywhere a button onClick would otherwise look like
 * `void apiPost(...)` or `void apiPost(...).then(refresh)`. If callers want
 * to handle their own errors, they can pass `setError` as a no-op and read
 * the returned promise directly.
 */
export function runAction<T>(
  promise: Promise<T>,
  setError: (message: string | null) => void,
  onDone?: () => void | Promise<void>
): void {
  // The chained `.catch` (rather than the two-arg form of `.then`) is
  // load-bearing: it catches BOTH the primary action's rejection AND any
  // error thrown inside the success branch (e.g. a refresh() call that
  // explodes). Without it, a throwing onDone would leak as an unhandled
  // rejection and re-trigger the bug this helper exists to prevent.
  promise
    .then(async () => {
      setError(null);
      if (onDone) {
        await onDone();
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Surface in DevTools without polluting the user-visible error badge.
      console.warn("[action]", message);
      setError(message);
    });
}

export async function apiPost<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const parsed = await parseErrorPayload(response);
    // Runner errors are inconsistent: some endpoints return `{ error }`,
    // others `{ reason }` (e.g. enrich's `{status:"failed",reason:"..."}`),
    // and some send back `{ message }`. Prefer the most descriptive shape
    // before falling back to the raw body so the dashboard never surfaces
    // a JSON blob to the operator.
    const payload =
      typeof parsed.payload === "object" && parsed.payload
        ? (parsed.payload as Record<string, unknown>)
        : null;
    const stringField = (key: string): string | undefined =>
      payload && typeof payload[key] === "string" ? (payload[key] as string) : undefined;
    const message =
      stringField("error") ??
      stringField("message") ??
      stringField("reason") ??
      parsed.rawText ??
      `Request failed: ${response.status}`;
    throw new ApiRequestError(message, response.status, parsed.payload, parsed.rawText);
  }

  return (await response.json()) as T;
}
