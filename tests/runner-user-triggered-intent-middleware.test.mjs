import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createUserTriggeredIntentMiddleware } from "../apps/runner/src/services/user-triggered-intent-middleware.ts";

test("user intent is registered before the next route middleware starts", () => {
  const calls = [];
  const response = new EventEmitter();
  const middleware = createUserTriggeredIntentMiddleware((threadId) => {
    calls.push(`register:${threadId}`);
    return () => calls.push(`release:${threadId}`);
  });

  middleware(
    { params: { threadId: "thread-1" } },
    response,
    () => calls.push("next")
  );

  assert.deepEqual(calls, ["register:thread-1", "next"]);
  response.emit("finish");
  response.emit("close");
  assert.deepEqual(calls, ["register:thread-1", "next", "release:thread-1"]);
});

test("a synchronous downstream failure releases the user intent", () => {
  const response = new EventEmitter();
  let releases = 0;
  const middleware = createUserTriggeredIntentMiddleware(() => () => {
    releases += 1;
  });

  assert.throws(
    () => middleware(
      { params: { threadId: "thread-1" } },
      response,
      () => {
        throw new Error("downstream failed");
      }
    ),
    /downstream failed/
  );
  assert.equal(releases, 1);
});

test("non-send requests pass through without registering intent", () => {
  const response = new EventEmitter();
  let registrations = 0;
  let nextCalls = 0;
  const middleware = createUserTriggeredIntentMiddleware(
    () => {
      registrations += 1;
      return () => {};
    },
    () => undefined
  );

  middleware({}, response, () => {
    nextCalls += 1;
  });

  assert.equal(registrations, 0);
  assert.equal(nextCalls, 1);
});
