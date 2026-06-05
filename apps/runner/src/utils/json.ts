/**
 * JSON.parse that never throws. Returns `fallback` when `value` is
 * null/undefined/empty or is not valid JSON.
 *
 * Use this for any parse of stored/untrusted JSON on a request or boot path,
 * so a single corrupt row (an `app_settings` blob, a message's `rawJson` /
 * `attachmentsJson`, a selector-override store) degrades gracefully to a
 * sensible default instead of throwing out of a route handler (a 500 for the
 * whole response) or wedging a startup read.
 */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
