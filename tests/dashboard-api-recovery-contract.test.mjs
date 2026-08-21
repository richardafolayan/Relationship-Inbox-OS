import test from "node:test";
import assert from "node:assert/strict";

const { apiGet, apiGetRaw, apiPost, ApiRequestError, invalidateCache, peekCache } = await import("../apps/dashboard/lib/api.ts");

test("API response failures keep technical detail off the consumer message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "PrismaClientKnownRequestError: stack at runner/src/index.ts:7538"
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  try {
    await assert.rejects(
      apiGetRaw("/runner/data/inbox"),
      (error) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.failure.code, "DATABASE_UNAVAILABLE");
        assert.doesNotMatch(error.message, /Prisma|stack|index\.ts/i);
        assert.match(error.rawText, /PrismaClientKnownRequestError/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed success payloads become a recoverable data failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<!doctype html><title>framework error</title>", { status: 200 });
  try {
    await assert.rejects(
      apiGetRaw("/runner/data/inbox"),
      (error) => {
        assert.equal(error.failure.code, "MALFORMED_DATA");
        assert.equal(error.failure.retrySafe, true);
        assert.doesNotMatch(error.message, /doctype|framework error/i);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a lost send response is never converted into a definite failure or success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    await assert.rejects(
      apiPost("/runner/control/thread/t1/send", { text: "hello", clientSendId: "id" }),
      (error) => {
        assert.equal(error.failure.code, "DELIVERY_UNCERTAIN");
        assert.equal(error.failure.deliveryUncertain, true);
        assert.equal(error.failure.retrySafe, false);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an explicit forced read queues a post-inflight refresh", async () => {
  const originalFetch = globalThis.fetch;
  const path = "/runner/data/inbox?forced-refresh-contract=1";
  invalidateCache(path);
  const gates = [];
  let calls = 0;
  globalThis.fetch = async () => {
    const call = calls++;
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    gates[call] = release;
    const version = await waiting;
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const older = apiGet(path, { ttlMs: 5000 });
    assert.equal(calls, 1);
    const forced = apiGet(path, { ttlMs: 0 });
    assert.equal(calls, 1, "forced read waits for the pre-change request first");

    gates[0](1);
    assert.deepEqual(await older, { version: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, "a second network read starts after the older request settles");

    const forcedAgain = apiGet(path, { ttlMs: 0 });
    assert.equal(calls, 2, "a newer force waits behind the active refresh");
    gates[1](2);
    assert.deepEqual(await forced, { version: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3, "a force during the refresh queues one more post-inflight read");
    gates[2](3);
    assert.deepEqual(await forcedAgain, { version: 3 });
    assert.deepEqual(peekCache(path), { version: 3 });
  } finally {
    globalThis.fetch = originalFetch;
    invalidateCache(path);
  }
});
