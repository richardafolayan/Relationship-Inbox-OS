import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  abandonUnstartedUserTriggeredIntent,
  beginUserTriggeredIntentOperation,
  createUserTriggeredIntentMiddleware,
  resolveFocusPolicyMutationIntentKey,
  resolveUserTriggeredIntentThreadId,
  userTriggeredIntentVersion
} from "../apps/runner/src/services/user-triggered-intent-middleware.ts";

test("the resolver covers every path shape accepted by the Express send routes", () => {
  for (const path of [
    "/control/thread/thread-1/send",
    "/control/thread/thread-1/send/",
    "/control/thread/thread-1/SEND",
    "/CONTROL/THREAD/thread-1/retry-send",
    "/control/thread/thread-1/SEND-POLL/"
  ]) {
    assert.equal(
      resolveUserTriggeredIntentThreadId({ method: "POST", path }),
      "thread-1"
    );
  }
  assert.equal(
    resolveUserTriggeredIntentThreadId({ method: "GET", path: "/control/thread/thread-1/send" }),
    undefined
  );
  assert.equal(
    resolveUserTriggeredIntentThreadId({ method: "POST", path: "/control/thread/thread-1/open" }),
    undefined
  );
});

test("focus-policy and platform-selection writes register a mutation intent at request arrival", () => {
  for (const path of [
    "/control/operator-profile",
    "/control/operator-profile/",
    "/CONTROL/OPERATOR-PROFILE",
    "/control/settings",
    "/control/settings/",
    "/control/setup/preferences",
    "/CONTROL/SETUP/PREFERENCES/"
  ]) {
    assert.equal(
      resolveFocusPolicyMutationIntentKey({ method: "POST", path }),
      "focus-policy"
    );
  }
  assert.equal(
    resolveFocusPolicyMutationIntentKey({ method: "GET", path: "/control/operator-profile" }),
    undefined
  );
  assert.equal(
    resolveFocusPolicyMutationIntentKey({ method: "POST", path: "/control/setup/complete" }),
    undefined
  );
});

test("user intent is registered before the next route middleware starts", () => {
  const calls = [];
  const response = new EventEmitter();
  let completeOperation = () => {};
  const middleware = createUserTriggeredIntentMiddleware((threadId) => {
    calls.push(`register:${threadId}`);
    return () => calls.push(`release:${threadId}`);
  });

  middleware(
    { params: { threadId: "thread-1" } },
    response,
    () => {
      calls.push("next");
      completeOperation = beginUserTriggeredIntentOperation(response);
    }
  );

  assert.deepEqual(calls, ["register:thread-1", "next"]);
  response.emit("finish");
  response.emit("close");
  assert.deepEqual(calls, ["register:thread-1", "next"]);
  completeOperation();
  assert.deepEqual(calls, ["register:thread-1", "next", "release:thread-1"]);
});

test("durable intent registration completes before body parsing continues", async () => {
  const calls = [];
  const response = new EventEmitter();
  let persist;
  const ready = new Promise((resolve) => {
    persist = resolve;
  });
  const middleware = createUserTriggeredIntentMiddleware(() => ({
    release: () => calls.push("release"),
    ready
  }));

  middleware({ params: { threadId: "thread-1" } }, response, () => {
    calls.push("next");
    assert.equal(userTriggeredIntentVersion(response), 7);
  });
  assert.deepEqual(calls, []);
  persist(7);
  await ready;
  await Promise.resolve();
  assert.deepEqual(calls, ["next"]);
  beginUserTriggeredIntentOperation(response)();
  assert.deepEqual(calls, ["next", "release"]);
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

test("a closed response keeps intent active until the started route operation completes", () => {
  const response = new EventEmitter();
  let releases = 0;
  let completeOperation = () => {};
  const middleware = createUserTriggeredIntentMiddleware(() => () => {
    releases += 1;
  });

  middleware(
    { params: { threadId: "thread-1" } },
    response,
    () => {
      completeOperation = beginUserTriggeredIntentOperation(response);
    }
  );

  response.emit("finish");
  response.emit("close");
  assert.equal(releases, 0);

  completeOperation();
  assert.equal(releases, 1);
  response.emit("finish");
  assert.equal(releases, 1);
});

test("transport close cannot release intent before a deferred route operation starts", () => {
  const response = new EventEmitter();
  let releases = 0;
  const middleware = createUserTriggeredIntentMiddleware(() => () => {
    releases += 1;
  });

  middleware(
    { params: { threadId: "thread-1" } },
    response,
    () => {}
  );

  response.emit("close");
  assert.equal(releases, 0);
  const completeOperation = beginUserTriggeredIntentOperation(response);
  completeOperation();
  assert.equal(releases, 1);
});

test("transport errors never release an accepted request operation", () => {
  for (const operationStarted of [false, true]) {
    const response = new EventEmitter();
    response.on("error", () => {});
    let releases = 0;
    let completeOperation = () => {};
    const middleware = createUserTriggeredIntentMiddleware(() => () => {
      releases += 1;
    });
    middleware(
      { params: { threadId: "thread-1" } },
      response,
      () => {
        if (operationStarted) {
          completeOperation = beginUserTriggeredIntentOperation(response);
        }
      }
    );

    response.emit("error", new Error("socket failed"));
    assert.equal(releases, 0);
    if (operationStarted) {
      completeOperation();
    } else {
      abandonUnstartedUserTriggeredIntent(response);
    }
    assert.equal(releases, 1);
    response.emit("finish");
    assert.equal(releases, 1);
  }
});

test("the terminal error or fallthrough path abandons an operation that never starts", () => {
  const response = new EventEmitter();
  let releases = 0;
  const middleware = createUserTriggeredIntentMiddleware(() => () => {
    releases += 1;
  });
  middleware(
    { params: { threadId: "thread-1" } },
    response,
    () => {}
  );

  abandonUnstartedUserTriggeredIntent(response);
  abandonUnstartedUserTriggeredIntent(response);
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
