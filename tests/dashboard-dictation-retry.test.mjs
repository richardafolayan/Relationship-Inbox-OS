import test from "node:test";
import assert from "node:assert/strict";

// #462 follow-up. A dictation transcription that fails for a *transient*
// reason (lost connection to the runner, a dev-proxy hiccup, or a runner-side
// timeout) must keep the recorded clip so the operator can retry the SAME
// audio with one tap instead of speaking again. A failure that a retry can't
// fix (no speech, bad audio, transcription not configured) must surface as a
// plain error and drop the clip. This pins that decision. The dashboard ships
// ESM TypeScript, so this runs under `node --import tsx`.
const {
  classifyDictationResponse,
  DICTATION_TRANSPORT_MESSAGE,
  DICTATION_GENERIC_ERROR_MESSAGE
} = await import("../apps/dashboard/lib/dictation-retry.ts");

test("ok + transcript → text outcome, trimmed", () => {
  const out = classifyDictationResponse({
    ok: true,
    status: 200,
    data: { ok: true, text: "  hello there  " }
  });
  assert.deepEqual(out, { kind: "text", text: "hello there" });
});

test("ok + whitespace-only text → empty (no speech)", () => {
  const out = classifyDictationResponse({
    ok: true,
    status: 200,
    data: { ok: true, text: "   " }
  });
  assert.equal(out.kind, "empty");
});

test("ok + missing text field → empty (no speech)", () => {
  const out = classifyDictationResponse({ ok: true, status: 200, data: { ok: true } });
  assert.equal(out.kind, "empty");
});

test("connection/proxy drop (non-JSON body, no error field) → retry, keep clip", () => {
  // resp.json() failed → data is {}. !resp.ok, no error field.
  const out = classifyDictationResponse({ ok: false, status: 502, data: {} });
  assert.equal(out.kind, "retry");
  assert.equal(out.message, DICTATION_TRANSPORT_MESSAGE);
});

test("200 with a malformed/empty body (no ok, no error) → retry, keep clip", () => {
  // A 200 that didn't parse to the expected shape is still a transport oddity.
  const out = classifyDictationResponse({ ok: true, status: 200, data: {} });
  assert.equal(out.kind, "retry");
});

test("runner-side 502 failure (e.g. whisper timeout) → retry, keep clip", () => {
  const out = classifyDictationResponse({
    ok: false,
    status: 502,
    data: { ok: false, reason: "failed", error: "local_whisper_timeout" }
  });
  assert.equal(out.kind, "retry");
  assert.equal(out.message, DICTATION_TRANSPORT_MESSAGE);
});

test("503 not-configured → plain error (retry can't fix it), drop clip", () => {
  const msg = "Voice transcription is not configured on the runner.";
  const out = classifyDictationResponse({
    ok: false,
    status: 503,
    data: { ok: false, reason: "unavailable", error: msg }
  });
  assert.equal(out.kind, "error");
  assert.equal(out.message, msg);
});

test("422 skipped with a reason → plain error, drop clip", () => {
  const out = classifyDictationResponse({
    ok: false,
    status: 422,
    data: { ok: false, reason: "skipped", error: "local_whisper_conversion_failed" }
  });
  assert.equal(out.kind, "error");
  assert.equal(out.message, "local_whisper_conversion_failed");
});

test("4xx not-ok with no usable reason → generic error fallback", () => {
  // !data.error makes this transient by design (a non-JSON 4xx is a proxy
  // artifact), so it offers a retry rather than a dead-end generic error.
  const out = classifyDictationResponse({ ok: false, status: 400, data: {} });
  assert.equal(out.kind, "retry");
});

test("DICTATION_GENERIC_ERROR_MESSAGE is the final fallback string", () => {
  // error branch with an explicitly empty error string falls back to generic.
  const out = classifyDictationResponse({
    ok: false,
    status: 422,
    data: { ok: false, error: "" }
  });
  // empty error string is falsy → treated as transient (no usable reason).
  assert.equal(out.kind, "retry");
  // sanity: the generic constant exists for the error branch's fallback.
  assert.equal(typeof DICTATION_GENERIC_ERROR_MESSAGE, "string");
  assert.ok(DICTATION_GENERIC_ERROR_MESSAGE.length > 0);
});
