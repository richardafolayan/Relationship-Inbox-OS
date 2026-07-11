import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { classifyConsumerFailure } = await import(
  "../apps/dashboard/lib/consumer-failure.ts"
);

test("network send failures preserve delivery uncertainty and block blind retry", () => {
  const failure = classifyConsumerFailure(new TypeError("Failed to fetch"), {
    path: "/runner/control/thread/t1/send",
    method: "POST",
    phase: "network"
  });

  assert.equal(failure.code, "DELIVERY_UNCERTAIN");
  assert.equal(failure.retrySafe, false);
  assert.equal(failure.deliveryUncertain, true);
  assert.match(failure.nextAction, /check the conversation/i);
  assert.doesNotMatch(failure.message, /failed to fetch/i);
});

test("mutating network failures preserve data uncertainty", () => {
  const failure = classifyConsumerFailure(new TypeError("fetch failed"), {
    path: "/runner/control/thread/t1/archive",
    method: "POST",
    phase: "network"
  });

  assert.equal(failure.code, "ACTION_UNCERTAIN");
  assert.equal(failure.retrySafe, false);
  assert.equal(failure.dataUncertain, true);
});

test("significant failures map to calm recovery contracts", () => {
  const cases = [
    {
      expected: "RUNNER_OFFLINE",
      error: new TypeError("ECONNREFUSED"),
      context: { path: "/runner/health", method: "GET", phase: "network" }
    },
    {
      expected: "PARTIAL_STARTUP",
      error: new Error("Prisma init failed"),
      context: { path: "/runner/data/inbox", method: "GET", phase: "startup" }
    },
    {
      expected: "PERMISSION_REQUIRED",
      error: new Error("cannot open chat.db (Full Disk Access?)"),
      context: { path: "/runner/control/scan", method: "POST", status: 503 }
    },
    {
      expected: "CREDENTIALS_REQUIRED",
      error: new Error("OpenAI API key missing"),
      context: { path: "/runner/control/thread/t1/compose", method: "POST", status: 401 }
    },
    {
      expected: "DATABASE_UNAVAILABLE",
      error: new Error("Prisma database disk I/O error"),
      context: { path: "/runner/data/inbox", method: "GET", status: 500 }
    },
    {
      expected: "MALFORMED_DATA",
      error: new SyntaxError("Unexpected token < in JSON"),
      context: { path: "/runner/data/inbox", method: "GET", phase: "parse" }
    },
    {
      expected: "NOT_FOUND",
      error: new Error("Thread not found"),
      context: { path: "/runner/data/thread/stale", method: "GET", status: 404 }
    },
    {
      expected: "SCAN_FAILED",
      error: new Error("selector mismatch"),
      context: { path: "/runner/control/scan", method: "POST", status: 500 }
    },
    {
      expected: "AI_UNAVAILABLE",
      error: new Error("model provider unavailable"),
      context: { path: "/runner/control/thread/t1/reassess", method: "POST", status: 503 }
    },
    {
      expected: "TRANSCRIPTION_FAILED",
      error: new Error("whisper model failed"),
      context: { path: "/runner/control/transcribe", method: "POST", status: 502 }
    },
    {
      expected: "UPDATE_FAILED",
      error: new Error("update checksum mismatch"),
      context: { path: "/runner/system/update", method: "POST", status: 500 }
    },
    {
      expected: "INTEGRATION_UNAVAILABLE",
      error: new Error("profile locked"),
      context: { path: "/runner/control/platform/connect", method: "POST", status: 500 }
    }
  ];

  for (const entry of cases) {
    const failure = classifyConsumerFailure(entry.error, entry.context);
    assert.equal(failure.code, entry.expected);
    assert.ok(failure.title.length > 0);
    assert.ok(failure.message.length > 0);
    assert.ok(failure.nextAction.length > 0);
    assert.equal(typeof failure.retrySafe, "boolean");
    assert.equal(typeof failure.dataUncertain, "boolean");
    assert.equal(typeof failure.deliveryUncertain, "boolean");
    assert.doesNotMatch(failure.message, /prisma|checksum|selector mismatch|unexpected token/i);
  }
});

test("normal degraded banners keep technical artifacts in diagnostics", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/components/common/degraded-banner.tsx", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /\{errorSummary\}|\{stage \?|\{reason \?|\{requestId \?/);
  assert.doesNotMatch(source, /artifacts\/screenshots|artifacts\/dom_dumps|dom dump/i);
  assert.match(source, /View diagnostics/);
  assert.match(source, /Open Settings/);
});
