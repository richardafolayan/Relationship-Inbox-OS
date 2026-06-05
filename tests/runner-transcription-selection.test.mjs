import test from "node:test";
import assert from "node:assert/strict";
import {
  pickHigherTier,
  selectBestTranscript
} from "../apps/runner/dist/services/transcription/selection.js";

// selectBestTranscript is a pure helper: given an attempt list it
// returns the single transcript the rest of the app should display.
// The never-downgrade rule is unit-testable in isolation, with no
// prisma or whisper dependency.

test("selectBestTranscript returns null on an empty list", () => {
  assert.equal(selectBestTranscript([]), null);
});

test("selectBestTranscript skips empty and failed attempts", () => {
  const out = selectBestTranscript([
    { tier: "fast", model: "f", provider: "local-whisper", status: "transcribed", transcript: "" },
    { tier: "standard", model: "s", provider: "local-whisper", status: "failed", transcript: null },
    { tier: "max", model: "m", provider: "local-whisper", status: "skipped", transcript: "shouldn't pick this" }
  ]);
  assert.equal(out, null);
});

test("selectBestTranscript picks the highest local tier", () => {
  const out = selectBestTranscript([
    { tier: "fast", model: "small.en", provider: "local-whisper", status: "transcribed", transcript: "fast text" },
    { tier: "standard", model: "v3-turbo-q5", provider: "local-whisper", status: "transcribed", transcript: "standard text" }
  ]);
  assert.equal(out?.tier, "standard");
  assert.equal(out?.transcript, "standard text");
});

test("selectBestTranscript prefers refinement over the highest local tier", () => {
  const out = selectBestTranscript([
    { tier: "fast", model: "small.en", provider: "local-whisper", status: "transcribed", transcript: "fast" },
    { tier: "max", model: "v3", provider: "local-whisper", status: "transcribed", transcript: "max" },
    { tier: "refinement", model: "gpt-5-nano", provider: "openai-text-refiner", status: "transcribed", transcript: "refined" }
  ]);
  assert.equal(out?.tier, "refinement");
  assert.equal(out?.transcript, "refined");
});

test("selectBestTranscript ignores a failed refinement and falls back to max", () => {
  const out = selectBestTranscript([
    { tier: "max", model: "v3", provider: "local-whisper", status: "transcribed", transcript: "max wins" },
    { tier: "refinement", model: "gpt-5-nano", provider: "openai-text-refiner", status: "failed", transcript: null }
  ]);
  assert.equal(out?.tier, "max");
  assert.equal(out?.transcript, "max wins");
});

test("pickHigherTier returns the candidate when it outranks current", () => {
  const current = { tier: "fast", model: "f", provider: "local-whisper", transcript: "x" };
  const candidate = { tier: "standard", model: "s", provider: "local-whisper", transcript: "y" };
  const out = pickHigherTier(current, candidate);
  assert.equal(out?.tier, "standard");
});

test("pickHigherTier returns current when candidate is lower-tier (never downgrade)", () => {
  const current = { tier: "max", model: "m", provider: "local-whisper", transcript: "good" };
  const candidate = { tier: "fast", model: "f", provider: "local-whisper", transcript: "bad" };
  const out = pickHigherTier(current, candidate);
  assert.equal(out?.tier, "max");
  assert.equal(out?.transcript, "good");
});

test("pickHigherTier accepts a first candidate when current is null", () => {
  const out = pickHigherTier(null, {
    tier: "fast",
    model: "small.en",
    provider: "local-whisper",
    transcript: "hello"
  });
  assert.equal(out?.tier, "fast");
  assert.equal(out?.transcript, "hello");
});

test("pickHigherTier returns null when both inputs are null", () => {
  assert.equal(pickHigherTier(null, null), null);
});
