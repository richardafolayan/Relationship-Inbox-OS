# ADR 0006: Replayable local events with polling recovery

Status: Accepted

## Context

Scans, sends, AI updates, and platform callbacks should appear promptly in the
dashboard. Browser event streams can reconnect or lose more history than an
in-memory buffer retains.

## Decision

Publish typed runner events through a bounded in-memory event bus, deliver
them over server-sent events with monotonically increasing IDs, replay from
the browser's last event ID, and emit `RESYNC_REQUIRED` when the replay window
was exceeded. Keep visible polling of health and inbox data as the recovery
and time-derived-state path.

## Consequences

- Normal updates arrive without waiting for a polling interval.
- The event bus does not need durable storage.
- The dashboard must refresh canonical data after events rather than treating
  the event payload as the database.
- Polling remains necessary for reconnection, risk aging, and snooze expiry.

## Verification

- [`apps/runner/src/services/event-bus.ts`](../../apps/runner/src/services/event-bus.ts)
- [`apps/runner/src/services/sse-resume-cursor.ts`](../../apps/runner/src/services/sse-resume-cursor.ts)
- [`apps/runner/src/index.ts`](../../apps/runner/src/index.ts)
- [`apps/dashboard/app/events-proxy/route.ts`](../../apps/dashboard/app/events-proxy/route.ts)
- [`apps/dashboard/lib/inbox-events.ts`](../../apps/dashboard/lib/inbox-events.ts)
