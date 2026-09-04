import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../apps/runner/dist/services/keyed-mutex.js";

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("KeyedMutex runExclusive serializes work per key", async () => {
  const mutex = createKeyedMutex();
  const order = [];
  const firstGate = createDeferred();

  const first = mutex.runExclusive("default:LINKEDIN", async () => {
    order.push("first:start");
    await firstGate.promise;
    order.push("first:end");
    return "first";
  });
  const second = mutex.runExclusive("default:LINKEDIN", async () => {
    order.push("second:start");
    order.push("second:end");
    return "second";
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["first:start"]);

  firstGate.resolve();
  const values = await Promise.all([first, second]);
  assert.deepEqual(values, ["first", "second"]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("KeyedMutex runWithQueueOne collapses multiple pending runs to one", async () => {
  const mutex = createKeyedMutex();
  const gate = createDeferred();
  const executed = [];

  const running = mutex.runWithQueueOne("default:LINKEDIN", async () => {
    executed.push("running");
    await gate.promise;
    return "running";
  });

  const pendingOne = mutex.runWithQueueOne("default:LINKEDIN", async () => {
    executed.push("pending-one");
    return "pending-one";
  });
  const pendingTwo = mutex.runWithQueueOne("default:LINKEDIN", async () => {
    executed.push("pending-two");
    return "pending-two";
  });

  gate.resolve();

  const results = await Promise.all([running, pendingOne, pendingTwo]);
  assert.deepEqual(results, ["running", "pending-one", "pending-one"]);
  assert.deepEqual(executed, ["running", "pending-one"]);
});

test("Instagram control work waits while a scan owns the shared page lock", async () => {
  const mutex = createKeyedMutex();
  const gate = createDeferred();
  const order = [];

  const scan = mutex.runWithQueueOne("instagram:INSTAGRAM", async () => {
    order.push("scan:start");
    await gate.promise;
    order.push("scan:end");
  });
  const control = mutex.runExclusive("instagram:INSTAGRAM", async () => {
    order.push("control:start");
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["scan:start"]);

  gate.resolve();
  await Promise.all([scan, control]);
  assert.deepEqual(order, ["scan:start", "scan:end", "control:start"]);
});
