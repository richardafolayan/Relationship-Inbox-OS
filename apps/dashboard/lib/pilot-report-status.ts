"use client";

// Tracks in-flight pilot-feedback report submissions for the TopStatus
// ticker (issue #421 / R-0047). The feedback modal closes immediately
// on submit (#383 / R-0030), so the operator had no signal the report
// was still uploading — only a discrete success / error toast at the
// end. Pilot asked for a "Sending report…" ticker mirroring the
// "Scanning iMessage" / "Sending to Carlos" pattern.
//
// Implementation mirrors lib/reassess-status: a lightweight
// dashboard-side custom-event bus the TopStatus subscribes to. No
// /runner/health round-trip — the submit lives entirely in the
// dashboard so client-side state is the source of truth.

const EVENT_NAME = "inbox-pilot-report-status";

const inFlight = new Set<string>();
let counter = 0;

function emit() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ count: number }>(EVENT_NAME, { detail: { count: inFlight.size } })
  );
}

/**
 * Mark a pilot-report submission as in flight. Returns a stop function
 * — callers must invoke it in `.finally` so the ticker never gets
 * stuck "Sending report…" on a thrown promise.
 *
 * Each call gets a fresh internal id, so two rapid-fire submits show
 * "Sending 2 reports" rather than collapsing into one.
 */
export function signalReportSendStart(): () => void {
  if (typeof window === "undefined") return () => undefined;
  counter += 1;
  const id = `r${counter}`;
  inFlight.add(id);
  emit();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    inFlight.delete(id);
    emit();
  };
}

/**
 * Subscribe to in-flight-count changes. Fires with the current count
 * on every signal. Returns an unsubscribe. Seeded with the current
 * count on mount so a subscriber that mounts after submit still gets
 * the right state.
 */
export function onReportSendChange(handler: (count: number) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<{ count: number }>).detail;
    if (detail) handler(detail.count);
  };
  window.addEventListener(EVENT_NAME, wrapped);
  handler(inFlight.size);
  return () => window.removeEventListener(EVENT_NAME, wrapped);
}

/** Test-only: snapshot the current in-flight count without subscribing. */
export function _reportSendCountForTests(): number {
  return inFlight.size;
}
