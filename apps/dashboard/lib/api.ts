import {
  classifyConsumerFailure,
  diagnosticMessage,
  logConsumerFailure,
  type ConsumerFailure,
  type ConsumerFailureContext
} from "./consumer-failure";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
    readonly rawText?: string,
    readonly failure?: ConsumerFailure
  ) {
    super(failure ? `${failure.message} ${failure.nextAction}` : message);
    this.name = "ApiRequestError";
  }
}

function payloadMessage(payload: unknown, rawText?: string): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  for (const key of ["error", "message", "reason"]) {
    if (record && typeof record[key] === "string" && record[key]) {
      return record[key] as string;
    }
  }
  return rawText || "Unknown API error";
}

function requestError(
  error: unknown,
  context: ConsumerFailureContext,
  status = context.status ?? 0,
  payload?: unknown,
  rawText?: string
): ApiRequestError {
  const diagnostic = context.diagnostic ?? diagnosticMessage(error);
  const failure = classifyConsumerFailure(error, { ...context, diagnostic, status });
  logConsumerFailure(failure, error, { ...context, diagnostic, status });
  return new ApiRequestError(diagnostic, status, payload, rawText, failure);
}

async function readJson<T>(response: Response, context: ConsumerFailureContext): Promise<T> {
  const rawText = await response.text();
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      payload = undefined;
    }
    const diagnostic = payloadMessage(payload, rawText || `Request failed: ${response.status}`);
    throw requestError(
      new Error(diagnostic),
      { ...context, phase: "response", status: response.status, diagnostic },
      response.status,
      payload,
      rawText
    );
  }

  try {
    return JSON.parse(rawText) as T;
  } catch (error) {
    throw requestError(
      error,
      { ...context, phase: "parse", status: response.status, diagnostic: rawText.slice(0, 300) },
      response.status,
      undefined,
      rawText
    );
  }
}

/**
 * Raw GET - always hits the network with `cache: "no-store"`. This is the
 * historical `apiGet` behaviour, kept for callers that explicitly want a
 * fresh, uncached read.
 */
export async function apiGetRaw<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store"
    });
  } catch (error) {
    throw requestError(error, { path, method: "GET", phase: "network" });
  }
  return readJson<T>(response, { path, method: "GET" });
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

// ---------------------------------------------------------------------------
// Persistent snapshot layer (localStorage) under the in-memory cache.
//
// The in-memory cache makes navigation instant WITHIN a session, but a cold
// open (fresh tab, app relaunch, next morning) still mounted blank and waited
// on the runner. This persists the last response for the hot read paths so a
// cold open paints the last-known state instantly and revalidates over it -
// the same stale-while-revalidate contract, stretched across restarts.
//
// Snapshots are hydrated lazily inside apiGet (never during render, so
// server-rendered HTML and the first client render always match) with their
// ORIGINAL timestamp, so they are always treated as stale: ttl fresh-hits
// can't serve them without revalidation, and swr callers paint them and
// refresh in the background. Whitelisted paths only; thread snapshots are
// capped to the most recent few; everything is best-effort (quota errors
// fall back to pruning, then to skipping persistence entirely).
// ---------------------------------------------------------------------------

const SNAPSHOT_PREFIX_BASE = "rios.snapshot.";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_PREFIX = `${SNAPSHOT_PREFIX_BASE}v${SNAPSHOT_VERSION}:`;
const SNAPSHOT_THREAD_LIMIT = 8;
const SNAPSHOT_MAX_CHARS = 2_000_000;
const SNAPSHOT_THREAD_PATH = "/runner/data/thread/";

function snapshotEligible(path: string): boolean {
  if (path === "/runner/data/inbox" || path === "/runner/data/archived") return true;
  // Only the default thread window - paginated reads (?before=) are partial.
  return path.startsWith(SNAPSHOT_THREAD_PATH) && !path.includes("?");
}

let snapshotsCleaned = false;
function snapshotStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const storage = window.localStorage;
    if (!snapshotsCleaned) {
      snapshotsCleaned = true;
      // Drop snapshots from older payload-shape versions in one pass.
      for (let i = storage.length - 1; i >= 0; i -= 1) {
        const key = storage.key(i);
        if (key && key.startsWith(SNAPSHOT_PREFIX_BASE) && !key.startsWith(SNAPSHOT_PREFIX)) {
          storage.removeItem(key);
        }
      }
    }
    return storage;
  } catch {
    return undefined;
  }
}

/** Read a persisted snapshot into a cache entry shape (undefined if none). */
function readSnapshot(path: string): CacheEntry | undefined {
  if (!snapshotEligible(path)) return undefined;
  const storage = snapshotStorage();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(SNAPSHOT_PREFIX + path);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { ts?: unknown; data?: unknown };
    if (typeof parsed?.ts !== "number" || parsed.data === undefined) return undefined;
    return { data: parsed.data, ts: parsed.ts };
  } catch {
    return undefined;
  }
}

/** Keep only the most recent N thread snapshots ("ts" is serialised first). */
function pruneThreadSnapshots(storage: Storage): void {
  const threadKeys: Array<{ key: string; ts: number }> = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !key.startsWith(SNAPSHOT_PREFIX + SNAPSHOT_THREAD_PATH)) continue;
    const head = storage.getItem(key)?.slice(0, 32) ?? "";
    const ts = Number(/"ts":(\d+)/.exec(head)?.[1] ?? 0);
    threadKeys.push({ key, ts });
  }
  if (threadKeys.length <= SNAPSHOT_THREAD_LIMIT) return;
  threadKeys
    .sort((a, b) => b.ts - a.ts)
    .slice(SNAPSHOT_THREAD_LIMIT)
    .forEach(({ key }) => storage.removeItem(key));
}

function writeSnapshot(path: string, data: unknown): void {
  if (!snapshotEligible(path)) return;
  const storage = snapshotStorage();
  if (!storage) return;
  try {
    // `ts` first so pruning can read it from the head without a full parse.
    const raw = JSON.stringify({ ts: Date.now(), data });
    if (raw.length > SNAPSHOT_MAX_CHARS) return;
    const key = SNAPSHOT_PREFIX + path;
    try {
      storage.setItem(key, raw);
    } catch {
      // Quota: drop all our snapshots and retry once, else skip silently.
      for (let i = storage.length - 1; i >= 0; i -= 1) {
        const k = storage.key(i);
        if (k && k.startsWith(SNAPSHOT_PREFIX_BASE)) storage.removeItem(k);
      }
      try {
        storage.setItem(key, raw);
      } catch {
        return;
      }
    }
    pruneThreadSnapshots(storage);
  } catch {
    /* persistence is best-effort */
  }
}

/**
 * Hydrate a missing in-memory entry from the persistent snapshot. Returns the
 * (possibly seeded) entry. Only called from apiGet, i.e. after mount - never
 * during render.
 */
function entryWithSnapshot(path: string): CacheEntry | undefined {
  const entry = responseCache.get(path);
  if (entry !== undefined) return entry;
  const snapshot = readSnapshot(path);
  if (snapshot) {
    responseCache.set(path, snapshot);
  }
  return snapshot;
}

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
  writeSnapshot(path, data);
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
  const entry = entryWithSnapshot(path);
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
        writeSnapshot(path, data);
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

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw requestError(error, { path, method: "POST", phase: "network" });
  }
  return readJson<T>(response, { path, method: "POST" });
}

export async function apiPostForm<T>(path: string, body: FormData, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      method: "POST",
      body
    });
  } catch (error) {
    throw requestError(error, { path, method: "POST", phase: "network" });
  }
  return readJson<T>(response, { path, method: "POST" });
}
