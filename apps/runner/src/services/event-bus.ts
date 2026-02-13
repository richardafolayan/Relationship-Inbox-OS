import type { RunnerEvent } from "@inbox-os/core";
import type { EventBus, RunnerEventInput } from "../types/runtime";

const MAX_EVENTS = 500;

export function createEventBus(): EventBus {
  let sequence = 0;
  const subscribers = new Set<(event: RunnerEvent) => void>();
  const events: RunnerEvent[] = [];

  function nextEventId(): number {
    sequence += 1;
    return sequence;
  }

  function emit(eventInput: RunnerEventInput): RunnerEvent {
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
      listener(event);
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
