// Records the most recent uncaught client-side error so a pilot feedback
// report can carry "what error did you actually see" context without the
// tester having to describe it. This exists because a real pilot report
// (R-0077 / #709) arrived as "Got an error? / What's this about?" with no
// way to tell what they hit — the only detail was an unreadable screenshot.
//
// Safety: we keep only the exception MESSAGE (not a full stack, not the DOM,
// not any rendered conversation text), squashed to one line and truncated.
// Exception messages are not message content, so this preserves the
// reports-never-carry-conversation-text guarantee.

export interface ClientErrorRecord {
  message: string;
  at: number; // epoch ms
}

// Keep messages short — enough to recognise an error, not a stack dump.
const MAX_MESSAGE_LEN = 300;

// Only surface an error captured within this window before the report is
// submitted. A stale error from earlier in the session shouldn't be
// mislabelled as "the thing I just saw".
export const RECENT_CLIENT_ERROR_WINDOW_MS = 2 * 60 * 1000;

let lastError: ClientErrorRecord | null = null;
let installed = false;

/**
 * Shape a raw error / event reason into a safe, bounded, single-line message.
 * Pure — no globals, no clock — so it can be unit-tested directly.
 */
export function formatClientErrorMessage(input: unknown): string {
  let raw = "";
  if (typeof input === "string") {
    raw = input;
  } else if (input instanceof Error) {
    raw = input.message || input.name || "Error";
  } else if (input && typeof input === "object" && "message" in input) {
    raw = String((input as { message?: unknown }).message ?? "");
  } else if (input != null) {
    raw = String(input);
  }
  raw = raw.replace(/\s+/g, " ").trim();
  if (!raw) raw = "Unknown error";
  // ASCII-only truncation marker (the UI-copy gate bans typographic dashes;
  // this string can ride along into the GitHub issue body).
  return raw.length > MAX_MESSAGE_LEN ? `${raw.slice(0, MAX_MESSAGE_LEN - 3)}...` : raw;
}

/** Store the most recent error. `at` is injected so tests stay deterministic. */
export function recordClientError(input: unknown, at: number): void {
  lastError = { message: formatClientErrorMessage(input), at };
}

/**
 * The most recent client error, but only if it happened within `windowMs`
 * before `now`. Returns null when there's nothing recent. Pure w.r.t. the
 * passed clock.
 */
export function getRecentClientError(
  now: number,
  windowMs: number = RECENT_CLIENT_ERROR_WINDOW_MS
): string | null {
  if (!lastError) return null;
  if (now - lastError.at > windowMs) return null;
  return lastError.message;
}

/** Test-only reset of module state. */
export function __resetClientErrorLogForTests(): void {
  lastError = null;
  installed = false;
}

/**
 * Listen for uncaught errors and unhandled promise rejections, recording the
 * latest one. Idempotent and SSR-safe. Returns a disposer.
 */
export function installClientErrorCapture(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (installed) return () => undefined;
  installed = true;
  const onError = (event: ErrorEvent) => {
    recordClientError(event.error ?? event.message, Date.now());
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    recordClientError(event.reason, Date.now());
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    installed = false;
  };
}
