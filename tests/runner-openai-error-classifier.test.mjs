import test from "node:test";
import assert from "node:assert/strict";
import { classifyOpenAiError } from "../apps/runner/dist/services/ai.js";

// `classifyOpenAiError` turns an OpenAI SDK error into an operator hint that
// gets logged when an AI call falls back. The three failure modes below are
// the ones that confused the user: an account with no credits, a model that
// isn't in the catalog, and a missing/invalid API key. If any of these stops
// being recognised the operator will see a generic "Reason: ..." instead of
// the specific fix instruction — so this test pins the message shapes.

test("insufficient_quota by code (OpenAI SDK uses code)", () => {
  const result = classifyOpenAiError({ code: "insufficient_quota", message: "You exceeded your current quota" });
  assert.match(result, /out of credits/i);
  assert.match(result, /https:\/\/platform\.openai\.com\/settings\/organization\/billing\/overview/);
});

test("insufficient_quota by HTTP status (429)", () => {
  // Defensive: SDK might omit code but include status on the error.
  const result = classifyOpenAiError({ status: 429, message: "rate limit / quota" });
  assert.match(result, /out of credits/i);
});

test("model not found by code", () => {
  const result = classifyOpenAiError({ code: "model_not_found", message: "The model `gpt-5` does not exist" });
  assert.match(result, /model not available/i);
  assert.match(result, /gpt-4o-mini/);
});

test("model not found inferred from message wording", () => {
  // Some SDK / API versions don't set a code, only the message — handle both.
  const result = classifyOpenAiError(new Error("The model `made-up-model` does not exist"));
  assert.match(result, /model not available/i);
});

test("invalid_api_key by status 401", () => {
  const result = classifyOpenAiError({ status: 401, message: "Incorrect API key provided" });
  assert.match(result, /OPENAI_API_KEY is missing or invalid/i);
});

test("invalid_api_key by code", () => {
  const result = classifyOpenAiError({ code: "invalid_api_key", message: "bad key" });
  assert.match(result, /OPENAI_API_KEY is missing or invalid/i);
});

test("unknown error falls through to a Reason: line", () => {
  const result = classifyOpenAiError(new Error("network timeout after 30s"));
  assert.match(result, /^Reason: network timeout after 30s/);
});

test("non-Error rejection still produces a Reason", () => {
  const result = classifyOpenAiError("plain string");
  assert.match(result, /^Reason:/);
});
