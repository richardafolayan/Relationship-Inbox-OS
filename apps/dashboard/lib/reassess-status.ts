"use client";

// Tracks in-flight Reassess actions for the TopStatus ticker (issue
// #369). The thread page calls signalReassessStart() when the kebab →
// Reassess click fires, and TopStatus listens via onReassessChange to
// surface "Reassessing thread…" in the ticker instead of a static
// pending toast. The discrete outcome (success / error) still uses
// the toast surface — those are events, not ongoing work.
//
// Implementation note: lightweight dashboard-side state via a custom
// event bus, mirroring lib/feedback.ts's showToast pattern. No SSE,
// no /runner/health round-trip — Reassess is a single LLM call and
// the operator-initiated click already lives in the dashboard, so
// the state can stay client-side. If we ever need to surface
// reassess progress to other tabs / other dashboards on the same
// runner, the source of truth would move to /runner/health.

const EVENT_NAME = "inbox-reassess-status";

// threadId -> number of concurrent reassesses in flight for that thread.
// A refcount (not a Set) so two overlapping reassesses of the same thread
// both have to settle before the "Reassessing…" indicator clears — a single
// stop() must not clear it while a sibling reassess is still running. The
// emitted/observed count is the number of distinct threads (inFlight.size).
const inFlight = new Map<string, number>();

function emit() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ count: number }>(EVENT_NAME, { detail: { count: inFlight.size } })
  );
}

/**
 * Mark a reassess as in flight. Returns a stop function — callers
 * should invoke it (typically from a Promise.finally) regardless of
 * success or failure so the ticker doesn't get stuck "Reassessing…".
 *
 * Concurrent reassesses of the same threadId are refcounted: the thread
 * stays in flight (and the ticker stays up) until the LAST of them stops.
 * The returned stop is idempotent — calling it more than once decrements
 * only on the first call.
 */
export function signalReassessStart(threadId: string): () => void {
  if (typeof window === "undefined") return () => undefined;
  const prev = inFlight.get(threadId) ?? 0;
  inFlight.set(threadId, prev + 1);
  // Only the 0 -> 1 transition changes the distinct-thread count.
  if (prev === 0) emit();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const current = inFlight.get(threadId) ?? 0;
    if (current <= 1) {
      inFlight.delete(threadId);
      emit();
    } else {
      inFlight.set(threadId, current - 1);
    }
  };
}

/**
 * Subscribe to reassess in-flight count changes. Fires with the
 * current count on every signal. Returns an unsubscribe.
 *
 * TopStatus is the primary consumer.
 */
export function onReassessChange(handler: (count: number) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<{ count: number }>).detail;
    if (detail) handler(detail.count);
  };
  window.addEventListener(EVENT_NAME, wrapped);
  // Seed the subscriber with the current state so it doesn't miss a
  // signal that fired before mount (e.g. operator clicks Reassess
  // before TopStatus's effect has set up its listener — unlikely
  // but cheap to guard).
  handler(inFlight.size);
  return () => window.removeEventListener(EVENT_NAME, wrapped);
}

/** Test-only: snapshot the current in-flight count without subscribing. */
export function _reassessCountForTests(): number {
  return inFlight.size;
}
