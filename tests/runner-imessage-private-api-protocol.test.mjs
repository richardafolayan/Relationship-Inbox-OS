import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeRequest,
  decodeResponse,
  PrivateApiError,
  PRIVATE_API_PROTOCOL_VERSION
} from "../apps/runner/dist/platforms/imessage-private-api/protocol.js";

// The wire protocol is the contract between the runner and the external
// helper bundle (and the local mock). These tests pin the framing so a
// careless change can't silently desync the two implementations.

test("encodeRequest emits a single NDJSON line", () => {
  const line = encodeRequest({ id: "abc", op: "ping", params: {} });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.indexOf("\n"), line.length - 1, "exactly one trailing newline");
  assert.deepEqual(JSON.parse(line), { id: "abc", op: "ping", params: {} });
});

test("decodeResponse parses an ok result", () => {
  const res = decodeResponse(JSON.stringify({ id: "x", ok: true, result: { messageGuid: "g1" } }));
  assert.equal(res.ok, true);
  assert.equal(res.id, "x");
  assert.deepEqual(res.result, { messageGuid: "g1" });
});

test("decodeResponse parses a structured error", () => {
  const res = decodeResponse(
    JSON.stringify({ id: "x", ok: false, error: { code: "unsupported_kind", message: "nope" } })
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "unsupported_kind");
  assert.equal(res.error.message, "nope");
});

test("decodeResponse tolerates a trailing newline", () => {
  const res = decodeResponse(`${JSON.stringify({ id: "x", ok: true, result: {} })}\n`);
  assert.equal(res.ok, true);
});

test("decodeResponse defaults a missing error code to internal", () => {
  const res = decodeResponse(JSON.stringify({ id: "x", ok: false, error: { message: "boom" } }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "internal");
});

test("decodeResponse throws on malformed payloads", () => {
  assert.throws(() => decodeResponse(""), TypeError);
  assert.throws(() => decodeResponse("not json"), TypeError);
  assert.throws(() => decodeResponse(JSON.stringify({ ok: true, result: {} })), TypeError, "missing id");
  assert.throws(() => decodeResponse(JSON.stringify({ id: "x" })), TypeError, "missing ok");
});

test("PrivateApiError carries the structured code", () => {
  const err = new PrivateApiError("unsupported_kind", "nope");
  assert.equal(err.code, "unsupported_kind");
  assert.equal(err.name, "PrivateApiError");
  assert.equal(err instanceof Error, true);
});

test("protocol version is exported", () => {
  assert.equal(typeof PRIVATE_API_PROTOCOL_VERSION, "number");
});
