import test from "node:test";
import assert from "node:assert/strict";
import { geminiExtraBody } from "../apps/runner/dist/services/ai.js";

// `geminiExtraBody` is the helper that makes Gemma viable through Google's
// OpenAI-compat endpoint. Without it Gemma 4 emits unfiltered <thought>
// reasoning traces and every JSON-mode call fails to parse. With it,
// thinking_level=MINIMAL is spread into the request and parsing works.
//
// The smoke test (apps/runner/src/scripts/gemini-smoke.ts) exercises the
// real endpoint end-to-end. This file pins the helper's contract directly
// so a future refactor of the model-detection regex (or a typo in the
// thinking-config payload shape) gets caught at unit-test time, not in
// production after the smoke run drifts out of CI memory.

test("geminiExtraBody: gemini + gemma model returns the thinking_level=MINIMAL extra", () => {
  const result = geminiExtraBody("gemini", "gemma-4-31b-it");
  assert.deepEqual(result, {
    extra_body: {
      google: {
        thinking_config: {
          thinking_level: "MINIMAL"
        }
      }
    }
  });
});

test("geminiExtraBody: gemini + non-Gemma model returns empty extras", () => {
  // Gemini-2.x / 3.x flash served via the same endpoint don't need the
  // thinking flag — sending it is harmless but adds wire-level noise.
  // The helper opts in only for Gemma.
  const result = geminiExtraBody("gemini", "gemini-3-flash-preview");
  assert.deepEqual(result, {});
});

test("geminiExtraBody: openai never receives Gemini extras", () => {
  // OpenAI rejects unknown body fields with HTTP 400. The helper must
  // be a true no-op for any non-Gemini provider.
  const result = geminiExtraBody("openai", "gpt-5-nano");
  assert.deepEqual(result, {});
});

test("geminiExtraBody: glm never receives Gemini extras", () => {
  // Z.AI's compat layer doesn't recognise Google's extra_body shape.
  // Same no-op contract as OpenAI.
  const result = geminiExtraBody("glm", "glm-4.7-flash");
  assert.deepEqual(result, {});
});

test("geminiExtraBody: gemma matching is case-insensitive", () => {
  // Future model ids may arrive with a capital G ("Gemma-4-...") if
  // Google standardises naming. The regex (/^gemma/i) covers it.
  const result = geminiExtraBody("gemini", "Gemma-4-31b-it");
  assert.equal(typeof result.extra_body, "object");
});

test("geminiExtraBody: matches any gemma-prefixed id (catches future Gemma 5 etc.)", () => {
  // Pinning the prefix-only contract — anything starting with "gemma"
  // gets the extras. If Google ships gemma-5-7b-it we want it covered
  // by default; an operator can opt out by setting GEMINI_MODEL to a
  // non-Gemma id.
  const result = geminiExtraBody("gemini", "gemma-5-7b-it");
  assert.equal(typeof result.extra_body, "object");
});

test("geminiExtraBody: empty model string is no-op (defensive)", () => {
  // If GEMINI_MODEL env is unset, runnerConfig falls back to the default
  // — empty model shouldn't ever reach this helper, but defensively
  // verify the regex doesn't false-match.
  const result = geminiExtraBody("gemini", "");
  assert.deepEqual(result, {});
});

test("geminiExtraBody: a model id that contains 'gemma' but doesn't start with it is NOT matched", () => {
  // Anchor check — `/^gemma/i` requires the prefix. "my-gemma-fork"
  // shouldn't accidentally trigger the extras (such an id would only
  // appear if an operator deliberately renames the model).
  const result = geminiExtraBody("gemini", "my-gemma-fork-1b");
  assert.deepEqual(result, {});
});
