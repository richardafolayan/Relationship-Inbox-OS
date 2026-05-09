import test from "node:test";
import assert from "node:assert/strict";
import {
  providerRegistry,
  fallbackChain
} from "../apps/runner/dist/services/ai-providers.js";

// `services/ai.ts:modelJson` builds the per-call provider chain as
//   const chain = [activeId, ...fallbackChain.filter((id) => id !== activeId)];
// so the runtime fallback semantics are deterministic from the
// `providerRegistry` keys + the `fallbackChain` constant. Pinning those
// here catches:
//   - dropping a provider entry from the registry,
//   - accidentally adding gemini to the fallback chain (we want it explicit
//     and stable until we have weeks of reliability data),
//   - silently changing the chain order for an active = gemini caller.
// A full DI-mocked end-to-end fallback test would need refactoring
// `createAiService` to accept clients via DI. The chain-construction
// invariant is the load-bearing piece; verifying it is enough to catch
// the regressions we actually care about for this PR.

test("fallback: providerRegistry includes openai, glm, and gemini", () => {
  assert.ok(providerRegistry.openai);
  assert.ok(providerRegistry.glm);
  assert.ok(providerRegistry.gemini);
});

test("fallback: gemini provider entry has the expected display name and retry budget", () => {
  const entry = providerRegistry.gemini;
  assert.equal(entry.id, "gemini");
  assert.equal(entry.displayName, "Gemini API");
  // Conservative starting position — see geminiEntry comment in ai-providers.ts.
  assert.equal(entry.maxAttempts, 3);
  assert.equal(typeof entry.baseBackoffMs, "number");
  assert.ok(entry.baseBackoffMs >= 1000, "backoff should be at least 1s");
});

test("fallback: fallbackChain is exactly ['openai'] (gemini deliberately excluded)", () => {
  // Gemini is an unproven provider in the fallback target slot. Pinning the
  // chain to ["openai"] is intentional and load-bearing — a future PR that
  // adds gemini here should get explicit review attention.
  assert.deepEqual(fallbackChain, ["openai"]);
});

test("fallback: chain construction for active=gemini yields ['gemini', 'openai']", () => {
  // Mirror the construction in services/ai.ts:modelJson. The intent: when
  // the operator picks gemini and gemini fails, the runtime walks to
  // openai automatically.
  const activeId = "gemini";
  const chain = [activeId, ...fallbackChain.filter((id) => id !== activeId)];
  assert.deepEqual(chain, ["gemini", "openai"]);
});

test("fallback: chain construction for active=openai yields ['openai'] (no double-include)", () => {
  // When openai is itself the active provider, the chain shouldn't list
  // openai twice — there's no fallback target.
  const activeId = "openai";
  const chain = [activeId, ...fallbackChain.filter((id) => id !== activeId)];
  assert.deepEqual(chain, ["openai"]);
});

test("fallback: chain construction for active=glm still yields ['glm', 'openai'] (no regression)", () => {
  // The Phase 4 changes shouldn't regress GLM's existing fallback shape.
  const activeId = "glm";
  const chain = [activeId, ...fallbackChain.filter((id) => id !== activeId)];
  assert.deepEqual(chain, ["glm", "openai"]);
});

test("fallback: classifying gemini's own model_not_found returns retriable=false", () => {
  // The active-provider failure must be non-retriable for the fallback
  // walker to actually move on to openai. If the gemini classifier ever
  // accidentally marks `model_not_found` as retriable the chain would loop
  // on gemini until maxAttempts and waste the retry budget.
  const cls = providerRegistry.gemini.classifyError({
    code: "model_not_found",
    message: "model not found"
  });
  assert.equal(cls.kind, "model_not_found");
  assert.equal(cls.retriable, false);
});
