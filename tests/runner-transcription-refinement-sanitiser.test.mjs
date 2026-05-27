import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRefinementUserPrompt,
  parseRefinementResponse
} from "../apps/runner/dist/services/transcription/index.js";

// Unit tests for the GPT-5-nano refinement sanitiser. The orchestrator
// guarantees that refinement only runs after at least one local tier
// succeeds, so every test here passes a non-empty attempts array.

function ctx(overrides = {}) {
  return {
    messageId: "m1",
    threadId: "t1",
    direction: "IN",
    speakerRole: "contact",
    attempts: [
      {
        tier: "standard",
        model: "ggml-large-v3-turbo-q5_0.bin",
        transcript: "yeah I did do well when I say food shop I use food shop so loosely"
      }
    ],
    nearbyMessages: [
      { direction: "OUT", timestamp: "12:00", text: "Did you do a food shop?" },
      { direction: "OUT", timestamp: "13:00", text: "What did you cook?" }
    ],
    ...overrides
  };
}

test("buildRefinementUserPrompt includes attempts and nearby context", () => {
  const prompt = buildRefinementUserPrompt(ctx());
  assert.match(prompt, /tier=standard/);
  assert.match(prompt, /ggml-large-v3-turbo-q5_0\.bin/);
  assert.match(prompt, /food shop/);
  assert.match(prompt, /Did you do a food shop\?/);
  assert.match(prompt, /Return JSON only/);
});

test("buildRefinementUserPrompt notes empty nearby context", () => {
  const prompt = buildRefinementUserPrompt(ctx({ nearbyMessages: [] }));
  assert.match(prompt, /Nearby thread messages: \(none\)/);
});

test("parseAndSanitise returns the corrected transcript for a clean response", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      correctedTranscript:
        "yeah I did do well when I say food shop I use food shop so loosely because the way I do a food shop is I buy ingredients",
      confidence: "high",
      changesMade: [
        { from: "future", to: "food shop", reason: "context: previous message" }
      ],
      uncertainPhrases: []
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.match(out.result.correctedTranscript, /food shop/);
  assert.equal(out.result.confidence, "high");
  assert.equal(out.result.changesMade.length, 1);
});

test("parseAndSanitise drops a refinement that's drastically shorter than the local transcript", () => {
  const longLocal = "yeah I did do well when I say food shop I use food shop so loosely because the way I do a food shop is I buy the ingredients for the meal I want to cook";
  const out = parseRefinementResponse(
    JSON.stringify({
      correctedTranscript: "yeah",
      confidence: "low",
      changesMade: [],
      uncertainPhrases: []
    }),
    ctx({
      attempts: [
        { tier: "standard", model: "v3-turbo-q5", transcript: longLocal }
      ]
    })
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_too_short");
});

test("parseAndSanitise drops a hallucinated refinement (novel content)", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      // Completely unrelated content — no tokens overlap with the
      // local transcript or nearby messages.
      correctedTranscript:
        "kubernetes pods orchestration manifest deployment ingress controller",
      confidence: "high",
      changesMade: [],
      uncertainPhrases: []
    }),
    ctx()
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_hallucinated");
});

test("parseAndSanitise caps changesMade and uncertainPhrases at 10 each", () => {
  const manyChanges = Array.from({ length: 20 }, (_, i) => ({
    from: `from${i}`,
    to: `to${i}`,
    reason: `reason${i}`
  }));
  const manyUncertain = Array.from({ length: 20 }, (_, i) => `phrase${i}`);
  const out = parseRefinementResponse(
    JSON.stringify({
      correctedTranscript:
        "yeah I did do well when I say food shop I use food shop so loosely",
      confidence: "medium",
      changesMade: manyChanges,
      uncertainPhrases: manyUncertain
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.changesMade.length, 10);
  assert.equal(out.result.uncertainPhrases.length, 10);
});

test("parseAndSanitise strips em / en dashes from output", () => {
  // Keep the corrected text close to the local transcript so the
  // hallucination guard doesn't fire — we're only checking dash
  // stripping here. The em / en dashes are inserted in places that
  // wouldn't normally appear in raw Whisper output.
  const out = parseRefinementResponse(
    JSON.stringify({
      correctedTranscript:
        "yeah I did do well — when I say food shop I use food shop – so loosely",
      confidence: "medium",
      changesMade: [{ from: "future—nope", to: "food shop", reason: "fix dash" }],
      uncertainPhrases: ["weird — phrase"]
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.ok(!/[—–]/.test(out.result.correctedTranscript), "no em/en dash should remain");
  assert.ok(!/[—–]/.test(out.result.changesMade[0].from), "changes must be dash-free");
  assert.ok(!/[—–]/.test(out.result.uncertainPhrases[0]));
});

test("parseAndSanitise rejects empty or non-string correctedTranscript", () => {
  const empty = parseRefinementResponse(
    JSON.stringify({ correctedTranscript: "", confidence: "low" }),
    ctx()
  );
  assert.equal(empty.kind, "skipped");
  assert.equal(empty.reason, "refinement_empty_transcript");
});

test("parseAndSanitise rejects invalid JSON", () => {
  const out = parseRefinementResponse("not json", ctx());
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_invalid_json");
});
