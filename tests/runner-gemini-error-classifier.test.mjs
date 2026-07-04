import test from "node:test";
import assert from "node:assert/strict";
import { classifyLlmError } from "../apps/runner/dist/services/ai.js";
import { providerRegistry } from "../apps/runner/dist/services/ai-providers.js";

// Gemini API errors arrive in three shapes through the OpenAI-compat endpoint:
//   1. OpenAI SDK shape:     { status, code, message }
//   2. Google REST shape:    { error: { code, status, message } } with a
//                            string-form `status` like "RESOURCE_EXHAUSTED"
//   3. SDK-wrapped REST:     { response: { status, data: { error: ... } } }
// The classifier must read all three to surface useful operator hints.
// classifyLlmError returns a "Reason: <human-readable hint>" line for logs.

// ── Auth (HTTP 401 / "API key invalid" wording) ────────────────────────────

test("gemini: HTTP 401 surfaces GEMINI_API_KEY hint", () => {
  const result = classifyLlmError({ status: 401, message: "Unauthorized" }, "gemini");
  assert.match(result, /GEMINI_API_KEY is missing or invalid/i);
  assert.match(result, /aistudio\.google\.com/);
  assert.doesNotMatch(result, /OPENAI_API_KEY/);
  assert.doesNotMatch(result, /Z_AI_API_KEY/);
});

test("gemini: 'API key invalid' phrasing in nested error.message", () => {
  // Google REST shape — the SDK doesn't always set `status`; the auth signal
  // can live entirely in error.message text.
  const result = classifyLlmError(
    { error: { code: 401, status: "UNAUTHENTICATED", message: "API key invalid" } },
    "gemini"
  );
  assert.match(result, /GEMINI_API_KEY/);
});

// ── Balance (HTTP 403 with quota / billing wording) ────────────────────────

test("gemini: HTTP 403 with 'quota' wording is treated as balance, not auth", () => {
  const result = classifyLlmError(
    { status: 403, message: "Quota exceeded for free tier" },
    "gemini"
  );
  assert.match(result, /quota exhausted/i);
  assert.doesNotMatch(result, /GEMINI_API_KEY is missing/i);
});

test("gemini: HTTP 403 with 'billing' wording is treated as balance", () => {
  const result = classifyLlmError(
    { status: 403, message: "billing not enabled for this project" },
    "gemini"
  );
  assert.match(result, /quota exhausted/i);
});

// ── Rate limit (HTTP 429 or googleStatus RESOURCE_EXHAUSTED) ───────────────

test("gemini: HTTP 429 is rate limit, not balance", () => {
  const result = classifyLlmError({ status: 429, message: "Too many requests" }, "gemini");
  assert.match(result, /rate limit/i);
  assert.doesNotMatch(result, /quota exhausted/i);
});

test("gemini: rate-limit classification is non-retriable so the wrapper falls over to OpenAI", () => {
  // Rate-limit windows can take tens of seconds to clear. Retrying
  // Gemini three times with backoff routinely blew past the dashboard's
  // 30s request timeout, leaving the operator with a "socket hang up"
  // instead of a reply. Mark non-retriable so modelJson walks the
  // fallback chain (OpenAI / gpt-5-nano) immediately. This is the
  // behavioural contract for the reassess + suggested-replies paths.
  const cls = providerRegistry.gemini.classifyError({ status: 429, message: "Too many requests" });
  assert.equal(cls.kind, "rate_limit");
  assert.equal(cls.retriable, false);
  assert.match(cls.message, /OpenAI fallback/i);
});

test("gemini: 5xx classification stays retriable (transient hiccup, not a sustained limit)", () => {
  // A flaky 500 from Gemini is worth one or two retries with backoff —
  // the bucket-style 429 rationale doesn't apply. Guards against an
  // over-broad "all gemini errors skip retries" change.
  const cls = providerRegistry.gemini.classifyError({ status: 503, message: "Service unavailable" });
  assert.equal(cls.kind, "service_overloaded");
  assert.equal(cls.retriable, true);
});

test("gemini: request timeout falls through to OpenAI instead of retrying Gemini", () => {
  const cls = providerRegistry.gemini.classifyError({ message: "Request timed out." });
  assert.equal(cls.kind, "service_overloaded");
  assert.equal(cls.retriable, false);
  assert.match(cls.message, /OpenAI fallback/i);
});

test("gemini: nested googleStatus RESOURCE_EXHAUSTED maps to rate_limit", () => {
  // Google REST shape with no top-level `status` — only the nested string.
  const result = classifyLlmError(
    { error: { status: "RESOURCE_EXHAUSTED", message: "Rate exceeded" } },
    "gemini"
  );
  assert.match(result, /rate limit/i);
});

test("gemini: SDK-wrapped REST shape is also recognised", () => {
  // The OpenAI SDK sometimes wraps the body under response.data — the
  // classifier walks that path too.
  const result = classifyLlmError(
    { response: { status: 429, data: { error: { status: "RESOURCE_EXHAUSTED", message: "rate" } } } },
    "gemini"
  );
  assert.match(result, /rate limit/i);
});

// ── Service overload (HTTP 5xx) ────────────────────────────────────────────

test("gemini: HTTP 500 is service_overloaded and retriable", () => {
  const result = classifyLlmError({ status: 500, message: "internal error" }, "gemini");
  assert.match(result, /500/);
  assert.match(result, /transient/i);
});

test("gemini: HTTP 503 is service_overloaded", () => {
  const result = classifyLlmError({ status: 503, message: "service unavailable" }, "gemini");
  assert.match(result, /503/);
  assert.match(result, /transient/i);
});

// ── Model not found ────────────────────────────────────────────────────────

test("gemini: model_not_found code surfaces GEMINI_MODEL hint", () => {
  const result = classifyLlmError(
    { code: "model_not_found", message: "model `gemma-99` does not exist" },
    "gemini"
  );
  assert.match(result, /Gemini model not available/i);
  assert.match(result, /GEMINI_MODEL/);
  // Both smoke-confirmed working ids should be discoverable from the hint.
  assert.match(result, /gemma-4-31b-it/);
  assert.match(result, /gemini-3-flash-preview/);
});

test("gemini: model_not_found inferred from message wording", () => {
  const result = classifyLlmError(
    new Error("The model `gemini-9000` was not found"),
    "gemini"
  );
  assert.match(result, /Gemini model not available/i);
});

test("gemini: googleStatus NOT_FOUND maps to model_not_found", () => {
  const result = classifyLlmError(
    { error: { status: "NOT_FOUND", message: "model is invalid" } },
    "gemini"
  );
  assert.match(result, /Gemini model not available/i);
});

test("gemini: model_not_found points operators at the smoke-test value space", () => {
  // The hint must let an operator find the smoke-test script without
  // having to open the runner source — that's how they discover other
  // working ids (gemma-4-31b-it default, gemini-3-flash-preview alt).
  const result = classifyLlmError(
    { code: "model_not_found", message: "model not found" },
    "gemini"
  );
  assert.match(result, /gemini-smoke\.ts/);
  assert.match(result, /thinking_level=MINIMAL/i);
});

// ── Unknown / fallthrough ──────────────────────────────────────────────────

test("gemini: unknown error falls through to a Reason: line", () => {
  const result = classifyLlmError(new Error("connection reset by peer"), "gemini");
  assert.match(result, /^Reason: connection reset by peer/);
});

test("gemini: non-Error rejection still produces a Reason", () => {
  const result = classifyLlmError("plain string", "gemini");
  assert.match(result, /^Reason:/);
});

test("gemini: empty / undefined error doesn't crash", () => {
  // Defensive — if the OpenAI SDK ever rejects with `undefined` (it has),
  // the classifier must still return a string starting with "Reason:".
  const result = classifyLlmError(undefined, "gemini");
  assert.match(result, /^Reason:/);
});
