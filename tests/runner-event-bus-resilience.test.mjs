import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../apps/runner/dist/services/event-bus.js";

const sampleEvent = { type: "SEND_QUEUE_UPDATED", jobId: "t", activeCount: 1 };

test("emit: a throwing subscriber does not abort delivery to the others", () => {
  const bus = createEventBus();
  const received = [];
  bus.subscribe(() => {
    throw new Error("bad SSE write on a half-closed socket");
  });
  bus.subscribe((event) => {
    received.push(event);
  });

  // Must not throw, and the healthy subscriber must still get the event.
  const event = bus.emit({ ...sampleEvent });
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "SEND_QUEUE_UPDATED");
  assert.equal(received[0].eventId, event.eventId);
});

test("emit: does not throw back into the emitter even if every subscriber throws", () => {
  const bus = createEventBus();
  bus.subscribe(() => { throw new Error("boom1"); });
  bus.subscribe(() => { throw new Error("boom2"); });

  assert.doesNotThrow(() => bus.emit({ ...sampleEvent }));
});

test("emit: order independence — a first-registered thrower doesn't block later ones", () => {
  const bus = createEventBus();
  const order = [];
  bus.subscribe(() => { order.push("a"); throw new Error("a threw"); });
  bus.subscribe(() => { order.push("b"); });
  bus.subscribe(() => { order.push("c"); throw new Error("c threw"); });

  bus.emit({ ...sampleEvent });
  assert.deepEqual(order, ["a", "b", "c"], "every subscriber is still invoked");
});

test("emit: events are still recorded and returned despite a throwing subscriber", () => {
  const bus = createEventBus();
  bus.subscribe(() => { throw new Error("nope"); });
  const event = bus.emit({ ...sampleEvent });
  assert.ok(event.eventId > 0);
  assert.equal(bus.newestEventId(), event.eventId);
});
