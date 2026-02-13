import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../apps/runner/dist/services/event-bus.js";

test("event bus emits sequential ids and supports subscribe/unsubscribe", () => {
  const bus = createEventBus();
  const seen = [];

  const unsubscribe = bus.subscribe((event) => {
    seen.push(event.eventId);
  });

  const first = bus.emit({
    type: "SCAN_PROGRESS",
    jobId: "job-1",
    platform: "LINKEDIN",
    stage: "Connecting"
  });
  const second = bus.emit({
    type: "SCAN_PROGRESS",
    jobId: "job-1",
    platform: "LINKEDIN",
    stage: "Collecting candidates"
  });

  unsubscribe();
  bus.emit({
    type: "SCAN_PROGRESS",
    jobId: "job-1",
    platform: "LINKEDIN",
    stage: "Done"
  });

  assert.equal(first.eventId, 1);
  assert.equal(second.eventId, 2);
  assert.deepEqual(seen, [1, 2]);
});

test("event bus keeps only the latest 500 events and replays since id", () => {
  const bus = createEventBus();

  for (let i = 0; i < 510; i += 1) {
    bus.emit({
      type: "SCAN_PROGRESS",
      jobId: `job-${i}`,
      platform: "LINKEDIN",
      stage: `step-${i}`
    });
  }

  const replayAll = bus.listSince();
  assert.equal(replayAll.length, 500);
  assert.equal(bus.oldestEventId(), 11);
  assert.equal(bus.newestEventId(), 510);

  const replayFrom500 = bus.listSince(500);
  assert.equal(replayFrom500.length, 10);
  assert.equal(replayFrom500[0]?.eventId, 501);
  assert.equal(replayFrom500[9]?.eventId, 510);
});
