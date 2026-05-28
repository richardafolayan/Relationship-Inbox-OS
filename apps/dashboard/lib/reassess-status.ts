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

const inFlight = new Set<string>();

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
 * Idempotent for the same threadId — calling start twice for the
 * same thread counts as one in-flight reassess. The returned stop
 * is also idempotent.
 */
export function signalReassessStart(threadId: string): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (!inFlight.has(threadId)) {
    inFlight.add(threadId);
    emit();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    inFlight.delete(threadId);
    emit();
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
