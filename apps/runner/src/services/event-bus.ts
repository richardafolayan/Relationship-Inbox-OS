import type { RunnerEvent } from "@inbox-os/core";
import type { EventBus, RunnerEventInput } from "../types/runtime";

const MAX_EVENTS = 500;

// A scan that touches N threads emits one THREAD_UPDATED per persisted
// thread (some paths more), and every one reaches every SSE client and
// schedules a dashboard refetch. Coalesce per-thread bursts: the first emit
// broadcasts immediately (live feel preserved), further emits for the same
// thread inside the window are absorbed into ONE trailing emit, so clients
// always still see the final state.
const THREAD_UPDATED_COALESCE_MS = 300;

export function createEventBus(): EventBus {
  let sequence = 0;
  const subscribers = new Set<(event: RunnerEvent) => void>();
  const events: RunnerEvent[] = [];
  const pendingThreadUpdates = new Map<string, { lastInput: RunnerEventInput; suppressed: boolean }>();

  function nextEventId(): number {
    sequence += 1;
    return sequence;
  }

  function emit(eventInput: RunnerEventInput): RunnerEvent {
    if (eventInput.type === "THREAD_UPDATED") {
      const pending = pendingThreadUpdates.get(eventInput.threadId);
      if (pending) {
        // Absorbed into the trailing emit. Nothing is broadcast or buffered
        // for this call; the returned event object exists only because the
        // signature promises one (no THREAD_UPDATED caller reads it).
        pending.suppressed = true;
        pending.lastInput = eventInput;
        return {
          ...eventInput,
          eventId: sequence,
          at: eventInput.at ?? new Date().toISOString()
        } as RunnerEvent;
      }
      const threadId = eventInput.threadId;
      const timer = setTimeout(() => {
        const state = pendingThreadUpdates.get(threadId);
        pendingThreadUpdates.delete(threadId);
        if (state?.suppressed) {
          // Trailing emit re-enters emit() and opens a fresh window, so a
          // sustained storm still settles to at most ~3 events/second/thread.
          emit(state.lastInput);
        }
      }, THREAD_UPDATED_COALESCE_MS);
      timer.unref?.();
      pendingThreadUpdates.set(eventInput.threadId, { lastInput: eventInput, suppressed: false });
      // Fall through: the leading emit broadcasts immediately.
    }

    const event = {
      ...eventInput,
      eventId: nextEventId(),
      at: eventInput.at ?? new Date().toISOString()
    } as RunnerEvent;

    events.push(event);
    if (events.length > MAX_EVENTS) {
      events.shift();
    }

    for (const listener of subscribers) {
      try {
        listener(event);
      } catch (error) {
        // One bad subscriber must not abort delivery to the others, nor unwind
        // into the emitter (e.g. send-queue tick()) where it would surface as a
        // process-level unhandledRejection. The classic case is an SSE listener
        // doing res.write() on a half-closed socket. Log and keep going.
        console.warn(
          `[event-bus] subscriber threw for ${event.type}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return event;
  }

  function subscribe(listener: (event: RunnerEvent) => void): () => void {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function listSince(eventId?: number): RunnerEvent[] {
    if (!eventId || Number.isNaN(eventId)) {
      return [...events];
    }

    return events.filter((event) => event.eventId > eventId);
  }

  function newestEventId(): number {
    return events[events.length - 1]?.eventId ?? 0;
  }

  function oldestEventId(): number {
    return events[0]?.eventId ?? newestEventId();
  }

  return {
    nextEventId,
    emit,
    subscribe,
    listSince,
    newestEventId,
    oldestEventId
  };
}
