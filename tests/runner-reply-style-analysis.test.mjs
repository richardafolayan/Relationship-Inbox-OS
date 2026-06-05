import test from "node:test";
import assert from "node:assert/strict";
import {
  selectStyleSampleTexts,
  normaliseInferredStyle,
  isInferredStyleEmpty,
  emptyInferredStyle,
  STYLE_ANALYSIS_SAMPLE_LIMIT
} from "../apps/runner/dist/services/reply-style-analysis.js";

// --- selectStyleSampleTexts -------------------------------------------

test("keeps only OUT messages", () => {
  const rows = [
    { text: "mine", direction: "OUT", sentVia: null },
    { text: "theirs", direction: "IN", sentVia: null }
  ];
  assert.deepEqual(selectStyleSampleTexts(rows), ["mine"]);
});

test("excludes runner-automated sends to avoid analysing the AI's own voice", () => {
  const rows = [
    { text: "hand-typed", direction: "OUT", sentVia: null },
    { text: "ai draft", direction: "OUT", sentVia: "automation" }
  ];
  assert.deepEqual(selectStyleSampleTexts(rows), ["hand-typed"]);
});

test("returns oldest-first even though rows arrive newest-first", () => {
  const rows = [
    { text: "newest", direction: "OUT", sentVia: null },
    { text: "middle", direction: "OUT", sentVia: null },
    { text: "oldest", direction: "OUT", sentVia: null }
  ];
  assert.deepEqual(selectStyleSampleTexts(rows), ["oldest", "middle", "newest"]);
});

test("drops empty and placeholder-only bubbles", () => {
  const rows = [
    { text: "  ", direction: "OUT", sentVia: null },
    { text: "[Photo]", direction: "OUT", sentVia: null },
    { text: "[ voice note ]", direction: "OUT", sentVia: null },
    { text: "real words", direction: "OUT", sentVia: null }
  ];
  assert.deepEqual(selectStyleSampleTexts(rows), ["real words"]);
});

test("a placeholder with extra prose is kept", () => {
  const rows = [{ text: "[Photo] look at this", direction: "OUT", sentVia: null }];
  assert.deepEqual(selectStyleSampleTexts(rows), ["[Photo] look at this"]);
});

test("caps each message length", () => {
  const long = "x".repeat(500);
  const [out] = selectStyleSampleTexts([{ text: long, direction: "OUT", sentVia: null }]);
  assert.ok(out.length < long.length, "long message should be truncated");
});

test("respects the limit and keeps the newest rows when truncating", () => {
  // 5 rows newest-first; limit 2 keeps the two newest, returned oldest-first.
  const rows = [
    { text: "n1", direction: "OUT", sentVia: null },
    { text: "n2", direction: "OUT", sentVia: null },
    { text: "n3", direction: "OUT", sentVia: null },
    { text: "n4", direction: "OUT", sentVia: null },
    { text: "n5", direction: "OUT", sentVia: null }
  ];
  assert.deepEqual(selectStyleSampleTexts(rows, 2), ["n2", "n1"]);
});

test("missing direction or text fields are treated as not-usable", () => {
  const rows = [
    { sentVia: null },
    { text: null, direction: "OUT", sentVia: null },
    { text: "ok", direction: "OUT", sentVia: null }
  ];
  assert.deepEqual(selectStyleSampleTexts(rows), ["ok"]);
});

test("default limit is the exported sample limit", () => {
  const rows = Array.from({ length: STYLE_ANALYSIS_SAMPLE_LIMIT + 10 }, (_, i) => ({
    text: `m${i}`,
    direction: "OUT",
    sentVia: null
  }));
  assert.equal(selectStyleSampleTexts(rows).length, STYLE_ANALYSIS_SAMPLE_LIMIT);
});

// --- normaliseInferredStyle -------------------------------------------

test("a clean object passes through", () => {
  const out = normaliseInferredStyle({
    about: "You write short, friendly notes.",
    preferred_style: "warm",
    common_phrases: "no worries, sounds good",
    avoided_phrases: "",
    interests: "running, design"
  });
  assert.equal(out.about, "You write short, friendly notes.");
  assert.equal(out.preferredStyle, "warm");
  assert.equal(out.commonPhrases, "no worries, sounds good");
  assert.equal(out.avoidedPhrases, "");
  assert.equal(out.interests, "running, design");
});

test("an invalid preferred_style collapses to empty", () => {
  assert.equal(normaliseInferredStyle({ preferred_style: "bubbly" }).preferredStyle, "");
  assert.equal(normaliseInferredStyle({ preferred_style: "" }).preferredStyle, "");
});

test("preferred_style is case-insensitive", () => {
  assert.equal(normaliseInferredStyle({ preferred_style: "WARM" }).preferredStyle, "warm");
});

test("phrase arrays join to a comma list", () => {
  const out = normaliseInferredStyle({
    common_phrases: ["no worries", "sounds good", "", "  cheers  "]
  });
  assert.equal(out.commonPhrases, "no worries, sounds good, cheers");
});

test("over-long fields are clamped", () => {
  const out = normaliseInferredStyle({ about: "y".repeat(10000) });
  assert.ok(out.about.length <= 4000, "about should be clamped to its max");
});

test("a non-object yields an empty suggestion", () => {
  assert.ok(isInferredStyleEmpty(normaliseInferredStyle(null)));
  assert.ok(isInferredStyleEmpty(normaliseInferredStyle("nope")));
  assert.ok(isInferredStyleEmpty(normaliseInferredStyle(42)));
});

test("an all-blank object is reported empty", () => {
  const out = normaliseInferredStyle({
    about: "   ",
    preferred_style: "nonsense",
    common_phrases: [],
    avoided_phrases: "",
    interests: ""
  });
  assert.ok(isInferredStyleEmpty(out));
});

// --- empties ----------------------------------------------------------

test("emptyInferredStyle is empty and a fresh object each call", () => {
  const a = emptyInferredStyle();
  const b = emptyInferredStyle();
  assert.ok(isInferredStyleEmpty(a));
  assert.notEqual(a, b);
});
