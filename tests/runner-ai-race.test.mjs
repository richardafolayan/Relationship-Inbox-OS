import test from "node:test";
import assert from "node:assert/strict";
import { raceAiProviders } from "../apps/runner/dist/services/ai-race.js";

// Issue #382 / pilot R-0029. raceAiProviders is the foundation for
// "dispatch slow visible AI calls to two providers, take the first
// valid result". These tests cover the first-VALID-result behaviour
// (not just first-response), the both-invalid path, and the loser
// outcome reporting.

const ok = (providerId) => ({ providerId, call: async () => ({ ok: true, providerId }) });
const okSlow = (providerId, ms) => ({
  providerId,
  call: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, providerId }), ms))
});
const errFast = (providerId, msg = "boom") => ({
  providerId,
  call: async () => {
    throw new Error(msg);
  }
});
const invalidFast = (providerId) => ({ providerId, call: async () => ({ ok: false, providerId }) });

const validate = (r) => r != null && r.ok === true;

test("raceAiProviders: returns the first valid result", async () => {
  const out = await raceAiProviders({
    primary: okSlow("openai", 30),
    secondary: okSlow("gemini", 5),
    validate
  });
  // Gemini was faster — should win.
  assert.equal(out.winnerProviderId, "gemini");
  assert.equal(out.result.ok, true);
  assert.equal(out.loser.kind, "still_running");
  assert.equal(out.loser.providerId, "openai");
});

test("raceAiProviders: waits for the other if the fast one is invalid", async () => {
  // Fast secondary returns invalid; primary takes longer but is valid.
  // The race must wait and pick primary, not return secondary's invalid.
  const out = await raceAiProviders({
    primary: okSlow("openai", 30),
    secondary: { providerId: "gemini", call: async () => ({ ok: false, providerId: "gemini" }) },
    validate
  });
  assert.equal(out.winnerProviderId, "openai");
  assert.equal(out.result.ok, true);
  assert.equal(out.loser.kind, "invalid");
  assert.equal(out.loser.providerId, "gemini");
});

test("raceAiProviders: waits for the other if the fast one rejected", async () => {
  const out = await raceAiProviders({
    primary: okSlow("openai", 30),
    secondary: errFast("gemini", "rate limit"),
    validate
  });
  assert.equal(out.winnerProviderId, "openai");
  assert.equal(out.loser.kind, "rejected");
  assert.equal(out.loser.providerId, "gemini");
  assert.match(String(out.loser.error?.message ?? out.loser.error), /rate limit/);
});

test("raceAiProviders: bubbles the primary's error when both fail", async () => {
  await assert.rejects(
    raceAiProviders({
      primary: errFast("openai", "openai boom"),
      secondary: errFast("gemini", "gemini boom"),
      validate
    }),
    /openai boom/
  );
});

test("raceAiProviders: bubbles a generic error when both return invalid (no rejection)", async () => {
  await assert.rejects(
    raceAiProviders({
      primary: invalidFast("openai"),
      secondary: invalidFast("gemini"),
      validate
    }),
    /both openai and gemini returned invalid results/
  );
});

test("raceAiProviders: primary wins on tie when primary returns first", async () => {
  // Primary returns at 5ms with valid, secondary at 10ms with valid.
  // Primary should be the winner (first valid).
  const out = await raceAiProviders({
    primary: okSlow("openai", 5),
    secondary: okSlow("gemini", 20),
    validate
  });
  assert.equal(out.winnerProviderId, "openai");
});

test("raceAiProviders: records winner duration in milliseconds", async () => {
  const out = await raceAiProviders({
    primary: okSlow("openai", 25),
    secondary: okSlow("gemini", 100),
    validate
  });
  assert.equal(out.winnerProviderId, "openai");
  // Allow loose bounds — node timers can jitter, especially on busy CI.
  assert.ok(out.winnerDurationMs >= 20, `expected >= 20ms, got ${out.winnerDurationMs}`);
  assert.ok(out.winnerDurationMs < 100, `expected < 100ms, got ${out.winnerDurationMs}`);
});
