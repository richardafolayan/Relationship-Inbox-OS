import test from "node:test";
import assert from "node:assert/strict";
import { classifyLlmError } from "../apps/runner/dist/services/ai.js";

// `classifyLlmError` turns an OpenAI / Z.AI SDK error into an operator hint
// that gets logged when an AI call falls back. The three failure modes below
// are the ones that confused the user: an account with no credits, a model
// that isn't in the catalog, and a missing/invalid API key. If any of these
// stops being recognised the operator will see a generic "Reason: ..." instead
// of the specific fix instruction — so this test pins the message shapes for
// both providers.

test("openai: insufficient_quota by code (OpenAI SDK uses code)", () => {
  const result = classifyLlmError({ code: "insufficient_quota", message: "You exceeded your current quota" }, "openai");
  assert.match(result, /out of credits/i);
  assert.match(result, /https:\/\/platform\.openai\.com\/settings\/organization\/billing\/overview/);
});

test("openai: insufficient_quota by HTTP status (429)", () => {
  // Defensive: SDK might omit code but include status on the error.
  const result = classifyLlmError({ status: 429, message: "rate limit / quota" }, "openai");
  assert.match(result, /out of credits/i);
});

test("openai: model not found by code", () => {
  const result = classifyLlmError({ code: "model_not_found", message: "The model `gpt-5` does not exist" }, "openai");
  assert.match(result, /model not available/i);
  assert.match(result, /gpt-4o-mini/);
});

test("openai: model not found inferred from message wording", () => {
  // Some SDK / API versions don't set a code, only the message — handle both.
  const result = classifyLlmError(new Error("The model `made-up-model` does not exist"), "openai");
  assert.match(result, /model not available/i);
});

test("openai: invalid_api_key by status 401", () => {
  const result = classifyLlmError({ status: 401, message: "Incorrect API key provided" }, "openai");
  assert.match(result, /OPENAI_API_KEY is missing or invalid/i);
});

test("openai: invalid_api_key by code", () => {
  const result = classifyLlmError({ code: "invalid_api_key", message: "bad key" }, "openai");
  assert.match(result, /OPENAI_API_KEY is missing or invalid/i);
});

test("openai: unknown error falls through to a Reason: line", () => {
  const result = classifyLlmError(new Error("network timeout after 30s"), "openai");
  assert.match(result, /^Reason: network timeout after 30s/);
});

test("openai: non-Error rejection still produces a Reason", () => {
  const result = classifyLlmError("plain string", "openai");
  assert.match(result, /^Reason:/);
});

// --- GLM (Z.AI) provider branches ---

test("glm: 1113 insufficient balance from BigModel surfaces the recharge hint", () => {
  // Z.AI / BigModel returns code "1113" and a Chinese-or-English balance
  // message, often with HTTP 429. The classifier should explain that
  // free-tier flash models bypass it.
  const result = classifyLlmError({ status: 429, message: "Insufficient balance or no resource package. Please recharge." }, "glm");
  assert.match(result, /Z\.AI account has no balance/i);
  assert.match(result, /glm-4\.7-flash/);
});

test("glm: chinese balance error matched by message", () => {
  // BigModel sometimes returns the message in Chinese — match either.
  const result = classifyLlmError({ message: "余额不足或无可用资源包,请充值。" }, "glm");
  assert.match(result, /Z\.AI account has no balance/i);
});

test("glm: model_not_found points at flash variants", () => {
  const result = classifyLlmError({ code: "model_not_found", message: "model `glm-9` does not exist" }, "glm");
  assert.match(result, /GLM model not available/i);
  assert.match(result, /glm-4\.7-flash/);
});

test("glm: 401 surfaces Z_AI_API_KEY hint, not OPENAI_API_KEY", () => {
  const result = classifyLlmError({ status: 401, message: "Incorrect API key" }, "glm");
  assert.match(result, /Z_AI_API_KEY is missing or invalid/i);
  assert.doesNotMatch(result, /OPENAI_API_KEY/);
});

test("glm: unknown error falls through to a Reason: line", () => {
  const result = classifyLlmError(new Error("connection reset"), "glm");
  assert.match(result, /^Reason: connection reset/);
});
