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

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
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
