import test from "node:test";
import assert from "node:assert/strict";

const { apiGetRaw, apiPost, ApiRequestError } = await import("../apps/dashboard/lib/api.ts");

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

test("an incomplete thread rescan is rejected and cannot be counted as a success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: "Message check incomplete. Some historical messages could not be verified safely.",
        freshnessComplete: false
      }),
      { status: 409, headers: { "content-type": "application/json" } }
    );
  try {
    await assert.rejects(
      apiPost("/runner/control/thread/t1/rescan", {}),
      (error) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, 409);
        assert.equal(error.failure.code, "SCAN_FAILED");
        assert.equal(error.failure.dataUncertain, true);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
