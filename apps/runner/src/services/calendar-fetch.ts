import { assertSafeRequestTarget, type ResolveAddresses } from "./link-preview";

// SSRF-guarded fetch for the operator's secret iCal (ICS) feed URL (#786).
//
// The URL is operator-supplied, but it is still fetched by the runner process,
// so the same lock-down the link-preview unfurler uses applies: http/https
// only, no credentials in the URL, and the host (plus every redirect hop) must
// resolve to public unicast addresses so the feed URL can't be pointed at
// "http://localhost:4001/" or a LAN box. Bodies are size- and time-capped.
//
// webcal:// URLs (what Apple / some Google share links hand out) are treated
// as https:// — "webcal" is only a "please subscribe" scheme hint.

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ICS_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ICS_ACCEPT = "text/calendar, text/plain;q=0.9, */*;q=0.5";
const USER_AGENT = "RelationshipInboxOS/1.0 (+calendar-focus)";

export class CalendarFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarFetchError";
  }
}

export interface CalendarFetchOptions {
  fetchImpl?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  /** Tests only: let fixture servers on 127.0.0.1 through the address guard.
   *  Protocol + redirect caps still apply. Never set in production paths. */
  allowPrivateTargets?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CalendarFetchResult {
  text: string;
  finalUrl: string;
}

/** Parse operator input into an absolute http(s) URL, mapping webcal:// to
 *  https://, or null if it can't be made into one. */
export function normalizeCalendarUrl(raw: string): URL | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (/^webcal:\/\//i.test(candidate)) {
    candidate = `https://${candidate.slice("webcal://".length)}`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new CalendarFetchError("calendar feed is too large");
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already done
    }
  }
  return out + decoder.decode();
}

/**
 * Fetch the ICS text at `rawUrl`, following redirects (each hop re-checked
 * against the SSRF guard). Throws {@link CalendarFetchError} on a bad URL,
 * blocked target, non-2xx status, oversize body, or network/timeout failure.
 */
export async function fetchIcsText(
  rawUrl: string,
  opts: CalendarFetchOptions = {}
): Promise<CalendarFetchResult> {
  const target = normalizeCalendarUrl(rawUrl);
  if (!target) {
    throw new CalendarFetchError("calendar URL is not a valid http(s)/webcal URL");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_ICS_BYTES;

  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (opts.allowPrivateTargets) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new CalendarFetchError(`unsupported protocol: ${current.protocol}`);
      }
    } else {
      // The secret iCal URL carries a bearer-like token in its path, so it
      // (and every redirect hop) must stay on https - a downgrade to http
      // would leak that token in cleartext. http is only reachable through
      // the allowPrivateTargets test hatch above.
      if (current.protocol !== "https:") {
        throw new CalendarFetchError(
          `calendar feed must use https (got ${current.protocol || "an unknown scheme"})`
        );
      }
      try {
        await assertSafeRequestTarget(current, opts.resolveAddresses);
      } catch (error) {
        throw new CalendarFetchError(
          error instanceof Error ? error.message : "blocked calendar URL"
        );
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": USER_AGENT, accept: ICS_ACCEPT }
      });
    } catch (error) {
      throw new CalendarFetchError(
        error instanceof Error ? `could not reach calendar: ${error.message}` : "could not reach calendar"
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      try {
        await response.body?.cancel();
      } catch {
        // best effort
      }
      if (!location) {
        throw new CalendarFetchError(`redirect without location from ${current.hostname}`);
      }
      try {
        current = new URL(location, current);
      } catch {
        throw new CalendarFetchError(`invalid redirect target from ${current.hostname}`);
      }
      continue;
    }

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // best effort
      }
      throw new CalendarFetchError(`calendar responded ${response.status}`);
    }

    const text = await readBodyCapped(response, maxBytes);
    return { text, finalUrl: current.toString() };
  }
  throw new CalendarFetchError("too many redirects");
}
