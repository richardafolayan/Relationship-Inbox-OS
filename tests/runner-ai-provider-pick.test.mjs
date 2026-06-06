import test from "node:test";
import assert from "node:assert/strict";
import { pickActiveProvider } from "../apps/runner/dist/services/ai-providers.js";

// Key-presence fallback: an operator (e.g. a pilot) should only need ANY one
// AI key, without also flipping AI_PROVIDER. pickActiveProvider returns the
// requested provider when it has a key, else the first configured one.

test("uses the requested provider when it has a key", () => {
  assert.equal(pickActiveProvider("openai", ["openai"]), "openai");
  assert.equal(pickActiveProvider("gemini", ["openai", "gemini"]), "gemini");
  assert.equal(pickActiveProvider("glm", ["glm", "openai"]), "glm");
});

test("the pilot trap: default openai but only a Gemini key → uses gemini", () => {
  assert.equal(pickActiveProvider("openai", ["gemini"]), "gemini");
});

test("default openai but only a GLM key → uses glm", () => {
  assert.equal(pickActiveProvider("openai", ["glm"]), "glm");
});

test("requested provider unconfigured → falls back by preference (openai > gemini > glm)", () => {
  assert.equal(pickActiveProvider("gemini", ["glm", "openai"]), "openai");
  assert.equal(pickActiveProvider("openai", ["glm", "gemini"]), "gemini");
});

test("both keys present → keeps the requested provider (no surprise switch)", () => {
  assert.equal(pickActiveProvider("openai", ["openai", "gemini"]), "openai");
  assert.equal(pickActiveProvider("gemini", ["openai", "gemini"]), "gemini");
});

test("nothing configured → returns the requested provider (caller handles the null client)", () => {
  assert.equal(pickActiveProvider("openai", []), "openai");
  assert.equal(pickActiveProvider("gemini", []), "gemini");
});
