import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRefinementResponse } from "../apps/runner/dist/services/transcription/index.js";

// Lanre benchmark gate for patch-based refinement (#386). Every prompt
// / sanitiser change runs against tests/fixtures/refinement-benchmark.json:
//   - all mustFix patches are applied (the `to` appears, the `from` is gone)
//   - all mustPreserve substrings survive
//   - none of the mustNotIntroduce strings appear
//
// The base transcript below is a synthesised large-v3-style voice note
// (lowercase, run-on, with the self-referential ending) that contains
// every mustFix `from`, every mustPreserve substring, and a SINGLE
// occurrence of the phrase the duplicate guard must protect. No real
// third-party content is used.

const benchmark = JSON.parse(
  readFileSync(new URL("./fixtures/refinement-benchmark.json", import.meta.url), "utf8")
);

const BASE_TRANSCRIPT =
  "yeah i did do well when i say food shop i use food shop so loosely because the way i do a food shop is i buy the ingredients for the meal i want to cook like in time if i was doing like a serious food shop like i used to do like i'd buy for things i wanted to cook for the week and then um i basically saw this video on tiktok and i was just like kind of looking at different videos online and just trying to see different perspectives i come to my own thoughts you know and then oh i cleaned my room a bit and then this place is getting long";

function baseCtx() {
  return {
    messageId: "lanre-food-shops",
    threadId: "t-lanre",
    direction: "IN",
    speakerRole: "contact",
    attempts: [{ tier: "max", model: "ggml-large-v3.bin", transcript: BASE_TRANSCRIPT }],
    nearbyMessages: [
      { direction: "OUT", timestamp: "12:00", text: "How was your day? did you do a food shop?" }
    ]
  };
}

function payload(corrections) {
  return JSON.stringify({
    baseModel: "ggml-large-v3.bin",
    corrections,
    uncertainPhrases: [],
    rejectReason: null
  });
}

test("benchmark base contains every fixture anchor", () => {
  for (const [from] of benchmark.mustFix) {
    assert.ok(BASE_TRANSCRIPT.includes(from), `base should contain mustFix from: "${from}"`);
  }
  for (const phrase of benchmark.mustPreserve) {
    assert.ok(BASE_TRANSCRIPT.includes(phrase), `base should contain mustPreserve: "${phrase}"`);
  }
  for (const phrase of benchmark.mustNotIntroduce) {
    assert.ok(
      !BASE_TRANSCRIPT.includes(phrase),
      `base should NOT already contain mustNotIntroduce: "${phrase}"`
    );
  }
});

test("Lanre benchmark: mustFix applied, mustPreserve kept, mustNotIntroduce absent", () => {
  const corrections = benchmark.mustFix.map(([from, to]) => ({
    from,
    to,
    type: "obvious_context_fix",
    confidence: "high",
    evidence: "voice note self-reference"
  }));

  const out = parseRefinementResponse(payload(corrections), baseCtx());
  assert.equal(out.kind, "ok", "valid corrections should produce a refined transcript");
  const text = out.result.correctedTranscript;

  for (const [from, to] of benchmark.mustFix) {
    assert.ok(text.includes(to), `mustFix not applied, expected: "${to}"`);
    assert.ok(!text.includes(from), `mustFix left the original in place: "${from}"`);
  }
  for (const phrase of benchmark.mustPreserve) {
    assert.ok(text.includes(phrase), `mustPreserve dropped: "${phrase}"`);
  }
  for (const phrase of benchmark.mustNotIntroduce) {
    assert.ok(!text.includes(phrase), `mustNotIntroduce appeared: "${phrase}"`);
  }
});

test("Lanre benchmark: a patch that would introduce the banned duplicate is rejected", () => {
  // If the refiner tries to merge lower-tier text in a way that
  // recreates the banned duplicate, the duplicate guard must reject the
  // whole pass (keeping large-v3 verbatim) rather than emit it.
  const corrections = [
    {
      from: "and just trying to see different perspectives",
      to: "and just like kind of looking at different videos online",
      type: "obvious_context_fix",
      confidence: "high",
      evidence: "bad merge from a lower tier"
    }
  ];
  const out = parseRefinementResponse(payload(corrections), baseCtx());
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_introduced_duplicate");
});
