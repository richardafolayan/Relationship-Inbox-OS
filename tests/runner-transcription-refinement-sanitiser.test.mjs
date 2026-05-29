import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRefinementUserPrompt,
  parseRefinementResponse
} from "../apps/runner/dist/services/transcription/index.js";
import {
  onlyPatchedRegionsChanged,
  pickBaseAttempt
} from "../apps/runner/dist/services/transcription/text-refinement-service.js";

// Unit tests for the PATCH-based refinement sanitiser (#386). The
// refiner proposes substring corrections against the highest-tier
// local transcript (the base). The app, not the model, applies only
// safe patches deterministically by splicing them into the base, and
// rejects (keeps the base verbatim) on any guard.

function ctx(overrides = {}) {
  return {
    messageId: "m1",
    threadId: "t1",
    direction: "IN",
    speakerRole: "contact",
    attempts: [
      {
        tier: "max",
        model: "ggml-large-v3.bin",
        transcript: "yeah i did do well when i say future i use food shop so loosely"
      }
    ],
    nearbyMessages: [
      { direction: "OUT", timestamp: "12:00", text: "Did you do a food shop?" },
      { direction: "OUT", timestamp: "13:00", text: "What did you cook?" }
    ],
    ...overrides
  };
}

function patch(from, to, extra = {}) {
  return {
    from,
    to,
    type: "asr_word_error",
    confidence: "high",
    evidence: "context",
    ...extra
  };
}

function payload(corrections, extra = {}) {
  return JSON.stringify({
    baseModel: "ggml-large-v3.bin",
    corrections,
    uncertainPhrases: [],
    rejectReason: null,
    ...extra
  });
}

test("buildRefinementUserPrompt presents the base as authoritative and asks for patches", () => {
  const prompt = buildRefinementUserPrompt(ctx());
  assert.match(prompt, /BASE transcript/);
  assert.match(prompt, /ggml-large-v3\.bin/);
  assert.match(prompt, /food shop/);
  assert.match(prompt, /Did you do a food shop\?/);
  assert.match(prompt, /Return JSON patches only/);
});

test("buildRefinementUserPrompt labels lower tiers as evidence only", () => {
  const prompt = buildRefinementUserPrompt(
    ctx({
      attempts: [
        { tier: "standard", model: "v3-turbo", transcript: "lower tier text here" },
        { tier: "max", model: "v3", transcript: "the authoritative base text" }
      ]
    })
  );
  assert.match(prompt, /BASE transcript \(model=v3, tier=max\)/);
  assert.match(prompt, /the authoritative base text/);
  assert.match(prompt, /EVIDENCE ONLY/);
  assert.match(prompt, /tier=standard/);
});

test("buildRefinementUserPrompt notes empty nearby context", () => {
  const prompt = buildRefinementUserPrompt(ctx({ nearbyMessages: [] }));
  assert.match(prompt, /Nearby thread messages: \(none\)/);
});

test("pickBaseAttempt picks the highest tier, breaking ties by last entry", () => {
  const base = pickBaseAttempt([
    { tier: "fast", model: "f", transcript: "fast" },
    { tier: "max", model: "m", transcript: "max" },
    { tier: "standard", model: "s", transcript: "standard" }
  ]);
  assert.equal(base.tier, "max");
  assert.equal(pickBaseAttempt([]), null);
});

test("applies a safe patch and returns the patched transcript", () => {
  const out = parseRefinementResponse(
    payload([patch("future", "food shop", { evidence: "meal planning context" })]),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.equal(
    out.result.correctedTranscript,
    "yeah i did do well when i say food shop i use food shop so loosely"
  );
  assert.equal(out.result.changesMade.length, 1);
  assert.equal(out.result.changesMade[0].from, "future");
  assert.equal(out.result.changesMade[0].to, "food shop");
  assert.equal(out.result.changesMade[0].reason, "meal planning context");
  assert.equal(out.result.confidence, "high");
});

test("drops a patch whose from is not a substring of the base", () => {
  const out = parseRefinementResponse(payload([patch("kubernetes pods", "food shop")]), ctx());
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_all_patches_dropped");
});

test("a from that exists only in a lower tier (not the base) cannot anchor a patch", () => {
  const out = parseRefinementResponse(
    payload([patch("loweronly", "food shop")]),
    ctx({
      attempts: [
        { tier: "standard", model: "v3-turbo", transcript: "this has loweronly token" },
        { tier: "max", model: "v3", transcript: "the base has no such token here at all" }
      ]
    })
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_all_patches_dropped");
});

test("drops a low-confidence patch", () => {
  const out = parseRefinementResponse(
    payload([patch("future", "food shop", { confidence: "low" })]),
    ctx()
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_all_patches_dropped");
});

test("empty corrections keeps the base verbatim (skipped, base stays selected)", () => {
  const out = parseRefinementResponse(payload([]), ctx());
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_no_corrections");
});

test("honours the model's own rejectReason", () => {
  const out = parseRefinementResponse(
    payload([patch("future", "food shop")], { rejectReason: "too garbled to patch" }),
    ctx()
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_self_rejected");
});

test("rejects invalid JSON", () => {
  const out = parseRefinementResponse("not json", ctx());
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_invalid_json");
});

test("rejects an empty response", () => {
  const out = parseRefinementResponse("   ", ctx());
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_empty_response");
});

test("rejects a patch whose replacement introduces a duplicated window", () => {
  // The Lanre "looking at different videos online ... looking at
  // different videos online" failure: a patch whose `to` duplicates a
  // phrase already in the base is rejected outright.
  const base =
    "i was just like kind of looking at different videos online and just trying to see different perspectives you know";
  const out = parseRefinementResponse(
    payload([
      patch(
        "and just trying to see different perspectives",
        "and just like kind of looking at different videos online",
        { type: "obvious_context_fix" }
      )
    ]),
    ctx({ attempts: [{ tier: "max", model: "v3", transcript: base }] })
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_introduced_duplicate");
});

test("rejects a patch that shrinks the transcript below 88% of the base", () => {
  const base =
    "yeah i did do well when i say food shop i use food shop so loosely because the way i do a food shop is i buy the ingredients for the meal i want to cook";
  const out = parseRefinementResponse(
    payload([
      patch(
        "because the way i do a food shop is i buy the ingredients for the meal i want to cook",
        ""
      )
    ]),
    ctx({ attempts: [{ tier: "max", model: "v3", transcript: base }] })
  );
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "refinement_too_short");
});

test("caps changesMade and uncertainPhrases at 10", () => {
  const tokens = Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(2));
  const base = tokens.join(" ");
  const corrections = tokens.slice(0, 12).map((tok) => patch(tok, tok.toUpperCase()));
  const uncertain = Array.from({ length: 16 }, (_, i) => `phrase${i}`);
  const out = parseRefinementResponse(
    payload(corrections, { uncertainPhrases: uncertain }),
    ctx({ attempts: [{ tier: "max", model: "v3", transcript: base }] })
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.changesMade.length, 10);
  assert.equal(out.result.uncertainPhrases.length, 10);
});

test("strips em / en dashes from the patched output and metadata", () => {
  const out = parseRefinementResponse(
    payload([patch("future", "food — shop", { confidence: "medium", evidence: "fix – dash" })], {
      uncertainPhrases: ["weird — phrase"]
    }),
    ctx()
  );
  assert.equal(out.kind, "ok");
  assert.ok(!/[—–]/.test(out.result.correctedTranscript), "no dash in transcript");
  assert.ok(!/[—–]/.test(out.result.changesMade[0].to), "no dash in change.to");
  assert.ok(!/[—–]/.test(out.result.uncertainPhrases[0]), "no dash in uncertain");
  assert.equal(out.result.confidence, "medium");
});

test("drift guard: onlyPatchedRegionsChanged accepts a clean splice, rejects a silent edit", () => {
  // The splice in parseAndSanitise makes out-of-patch drift impossible
  // by construction, so it cannot be triggered through the public
  // parser. We test the guard function directly: a clean output passes,
  // a silent edit OUTSIDE the patch span ("foo" -> "FOO") is caught.
  const base = "hello world foo bar";
  const patches = [{ to: "WORLD", baseStart: 6, baseEnd: 11 }];
  assert.equal(onlyPatchedRegionsChanged(base, "hello WORLD foo bar", patches), true);
  assert.equal(onlyPatchedRegionsChanged(base, "hello WORLD FOO bar", patches), false);
});

test("applies multiple non-overlapping patches in base order", () => {
  const base = "the good lord and the futur are near";
  const out = parseRefinementResponse(
    payload([
      patch("futur", "future"),
      patch("good lord", "Good Lord", { type: "casing_only" })
    ]),
    ctx({ attempts: [{ tier: "max", model: "v3", transcript: base }] })
  );
  assert.equal(out.kind, "ok");
  assert.equal(out.result.correctedTranscript, "the Good Lord and the future are near");
  assert.equal(out.result.changesMade.length, 2);
});

test("rawJson records accepted corrections and dropped patches for audit", () => {
  const out = parseRefinementResponse(
    payload([
      patch("future", "food shop"),
      patch("not in base", "whatever"),
      patch("food", "FOOD", { confidence: "low" })
    ]),
    ctx()
  );
  assert.equal(out.kind, "ok");
  const audit = JSON.parse(out.result.rawJson);
  assert.equal(audit.corrections.length, 1);
  assert.equal(audit.corrections[0].from, "future");
  assert.ok(audit.dropped.some((d) => d.reason === "patch_from_not_found"));
  assert.ok(audit.dropped.some((d) => d.reason === "low_confidence"));
});
