import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRefinementUserPrompt,
  parseRefinementResponse
} from "../apps/runner/dist/services/transcription/index.js";

// Tests for the patch-based refiner output sanitiser (#386).
// parseAndSanitise no longer accepts a `correctedTranscript`; it
// returns an array of structured patches. The full-transcript
// validation (shrink, duplicate-introduction, drift) moved into
// the orchestrator's applyRefinementPatches helper — those guards
// are exercised in runner-transcription-refinement-patches.test.mjs.

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
        transcript: "yeah I did do well when I say food shop"
      },
      {
        tier: "max",
        model: "ggml-large-v3.bin",
        transcript: "yeah I did do well when I say food shop loosely"
      }
    ],
    nearbyMessages: [
      { direction: "OUT", timestamp: "12:00", text: "Did you do a food shop?" }
    ],
    ...overrides
  };
}

test("buildRefinementUserPrompt labels the highest-tier attempt as BASE and others as evidence", () => {
  const prompt = buildRefinementUserPrompt(ctx());
  assert.match(prompt, /BASE \(highest-tier/);
  assert.match(prompt, /tier=max model=ggml-large-v3\.bin/);
  assert.match(prompt, /OTHER ATTEMPTS \(evidence only/);
  assert.match(prompt, /tier=standard model=ggml-large-v3-turbo-q5_0\.bin/);
});

test("buildRefinementUserPrompt mentions exact-substring requirement", () => {
  const prompt = buildRefinementUserPrompt(ctx());
  assert.match(prompt, /exact substring of the BASE transcript/);
});

test("parseAndSanitise accepts a clean patch list", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      baseModel: "ggml-large-v3.bin",
      corrections: [
        {
          from: "future",
          to: "food shop",
          type: "asr_word_error",
          confidence: "high",
          evidence: "Surrounding context is about meal planning."
        }
      ],
      uncertainPhrases: [],
      rejectReason: null
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.baseModel, "ggml-large-v3.bin");
  assert.equal(out.result.corrections.length, 1);
  assert.equal(out.result.corrections[0].from, "future");
  assert.equal(out.result.corrections[0].to, "food shop");
  assert.equal(out.result.corrections[0].confidence, "high");
  assert.equal(out.result.rejectReason, null);
});

test("parseAndSanitise treats empty corrections as a clean pass-through", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      baseModel: "ggml-large-v3.bin",
      corrections: [],
      uncertainPhrases: ["maybe something at 0:42"],
      rejectReason: null
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.corrections.length, 0);
  assert.equal(out.result.uncertainPhrases.length, 1);
});

test("parseAndSanitise drops malformed patches (missing `from`, same from/to) without rejecting the whole batch", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      baseModel: "ggml-large-v3.bin",
      corrections: [
        { from: "", to: "x", confidence: "high" },
        { from: "alpha", to: "alpha", confidence: "high" },
        { from: "future", to: "food shop", type: "asr_word_error", confidence: "high" }
      ],
      uncertainPhrases: [],
      rejectReason: null
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.corrections.length, 1);
  assert.equal(out.result.corrections[0].from, "future");
});

test("parseAndSanitise caps corrections at 20 entries", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    from: `from${i}`,
    to: `to${i}`,
    type: "asr_word_error",
    confidence: "medium"
  }));
  const out = parseRefinementResponse(
    JSON.stringify({
      baseModel: "ggml-large-v3.bin",
      corrections: many,
      uncertainPhrases: [],
      rejectReason: null
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.corrections.length, 20);
});

test("parseAndSanitise strips em / en dashes from `to`, `evidence`, and `uncertainPhrases`", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      baseModel: "ggml-large-v3.bin",
      corrections: [
        {
          from: "future",
          to: "food shop — properly",
          confidence: "high",
          evidence: "context — clear"
        }
      ],
      uncertainPhrases: ["weird — phrase"],
      rejectReason: null
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.ok(!/[–—]/.test(out.result.corrections[0].to));
  assert.ok(!/[–—]/.test(out.result.corrections[0].evidence));
  assert.ok(!/[–—]/.test(out.result.uncertainPhrases[0]));
});

test("parseAndSanitise rejects invalid JSON / empty response", () => {
  const invalid = parseRefinementResponse("not json", ctx());
  assert.equal(invalid.kind, "skipped");
  assert.equal(invalid.reason, "refinement_invalid_json");
  const empty = parseRefinementResponse("", ctx());
  assert.equal(empty.kind, "skipped");
  assert.equal(empty.reason, "refinement_empty_response");
});

test("parseAndSanitise normalises invalid type/confidence values to safe defaults", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      baseModel: "ggml-large-v3.bin",
      corrections: [
        { from: "future", to: "food shop", type: "bogus", confidence: "ultra" }
      ]
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.corrections[0].type, "asr_word_error");
  assert.equal(out.result.corrections[0].confidence, "medium");
});

test("parseAndSanitise surfaces a model-self-reject reason verbatim", () => {
  const out = parseRefinementResponse(
    JSON.stringify({
      baseModel: "ggml-large-v3.bin",
      corrections: [],
      uncertainPhrases: [],
      rejectReason: "not confident in any single-word fix"
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.match(out.result.rejectReason, /not confident/);
});
