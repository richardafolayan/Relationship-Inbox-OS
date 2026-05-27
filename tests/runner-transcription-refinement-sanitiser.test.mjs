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

test("parseAndSanitise rejects a refinement that drops a phrase present in 2+ local attempts", () => {
  // Mirrors the Lanre regression: two local models both transcribed
  // "a serious food shop like i used to do" but the refiner removed
  // it for readability. With consensus 3-grams the sanitiser catches
  // this as a stylistic rewrite, not an ASR correction.
  //
  // The total transcript is long enough that dropping the consensus
  // phrase keeps shrinkRatio comfortably above 0.88 (so it's the
  // consensus guard that fires, not the shrink guard). This mirrors
  // the real Lanre proportions: ~1500 chars, ~40 chars dropped.
  const longTail =
    " and then um what's it called i didn't end up reading i don't even know what i wanted to do i think i wanted to read my non-fiction book well like non-fiction just i just have no desire to read it plus when i was about to read i got distracted because i basically saw this video on tiktok and it made me think about something like really deeply and i was just the concept of like is god just or like the argument is that god isn't just or like god can't be just and then all knowing and then all loving and all those things and all powerful and stuff like that so i was genuinely starting to think about what it actually means to be just so i was just sitting down and i was just like actually just writing about it and just like kind of looking at different videos online and just trying to see different perspectives i come to my own like thoughts you know and then it was just so hot so after i did that like i just laid on my bed naked and then i just fell asleep and then i woke up again and then what did i do after that oh i cleaned my room a bit and then this place is getting long oh oh";
  const phraseInBoth =
    "yeah i did do well when i say food shop i use food shop so loosely because the way i do a food shop is i buy the ingredients for the meal i want to cook like in time if i was doing like a serious food shop like i used to do like i'd buy for things i wanted to cook for the week" +
    longTail;
  const ctxWithRepeats = ctx({
    attempts: [
      { tier: "standard", model: "v3-turbo-q5", transcript: phraseInBoth },
      { tier: "max", model: "v3", transcript: phraseInBoth }
    ]
  });
  // Refiner dropped "a serious food shop like i used to do" — every
  // 3-gram inside that span is now missing.
  const droppedSpan =
    "yeah i did do well when i say food shop i use food shop so loosely because the way i do a food shop is i buy the ingredients for the meal i want to cook like in time if i was doing like i'd buy for things i wanted to cook for the week" +
    longTail;
  const out = parseRefinementResponse(
    JSON.stringify({
      correctedTranscript: droppedSpan,
      confidence: "high",
      changesMade: [],
      uncertainPhrases: []
    }),
    ctxWithRepeats
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_dropped_consensus_phrases");
});

test("parseAndSanitise accepts a refinement that fixes a homophone without changing structure", () => {
  // The Lanre theology fix ("good just" → "god just") should still
  // pass: the corrected text preserves every consensus 3-gram and the
  // shrink ratio is roughly 1.0.
  const local1 =
    "i was thinking about whether god is just or whether good is just it was on tiktok and it made me think really deeply about what it actually means to be just";
  const local2 =
    "i was thinking about whether god is just or whether good is just it was on tiktok and it made me think really deeply about what it actually means to be just";
  const ctxHomophone = ctx({
    attempts: [
      { tier: "standard", model: "v3-turbo-q5", transcript: local1 },
      { tier: "max", model: "v3", transcript: local2 }
    ]
  });
  const corrected =
    "i was thinking about whether god is just or whether god is just it was on tiktok and it made me think really deeply about what it actually means to be just";
  const out = parseRefinementResponse(
    JSON.stringify({
      correctedTranscript: corrected,
      confidence: "high",
      changesMade: [{ from: "good", to: "god", reason: "context: theology" }],
      uncertainPhrases: []
    }),
    ctxHomophone
  );
  assert.equal(out.kind, "ok");
  assert.match(out.result.correctedTranscript, /whether god is just or whether god/);
});

test("parseAndSanitise consensus guard does not fire with only one local attempt", () => {
  // Consensus by definition requires 2+ attempts. A single attempt
  // can't form consensus, so the guard short-circuits.
  const onlyOne = ctx({
    attempts: [
      {
        tier: "max",
        model: "v3",
        transcript:
          "yeah I did do well when I say food shop I use food shop so loosely because the way I do a food shop is I buy ingredients"
      }
    ]
  });
  // Heavily edited corrected; shrinkRatio is still > 0.88 so the
  // short-text guard doesn't fire either.
  const corrected =
    "yeah I did do well when I say food shop I use food shop so loosely because how I food shop is I buy ingredients";
  const out = parseRefinementResponse(
    JSON.stringify({
      correctedTranscript: corrected,
      confidence: "medium",
      changesMade: [],
      uncertainPhrases: []
    }),
    onlyOne
  );
  // Passes — no consensus to enforce. (The single-attempt case is
  // best-effort; the orchestrator only runs refinement when standard
  // OR max produced text, so in production there's usually one local
  // attempt to compare against.)
  assert.equal(out.kind, "ok");
});
