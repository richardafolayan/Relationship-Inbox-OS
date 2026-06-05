import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeStyle,
  describeOperatorStyle,
  describeContactStyle,
  styleFingerprint
} from "../apps/runner/dist/services/style.js";

// --- analyzeStyle: sample threshold -----------------------------------

test("analyzeStyle returns null with no messages", () => {
  assert.equal(analyzeStyle([]), null);
});

test("analyzeStyle returns null with a single message", () => {
  assert.equal(analyzeStyle(["just the one"]), null);
});

test("analyzeStyle ignores blank messages and returns null below the threshold", () => {
  assert.equal(analyzeStyle(["hey", "   ", ""]), null);
});

test("analyzeStyle produces a profile at two messages", () => {
  const profile = analyzeStyle(["hey there", "how are you"]);
  assert.notEqual(profile, null);
  assert.equal(profile.sampleCount, 2);
});

// --- analyzeStyle: length ---------------------------------------------

test("analyzeStyle buckets terse messages as very short", () => {
  const profile = analyzeStyle(["yeah", "ok cool"]);
  assert.equal(profile.avgWords, 1.5);
  assert.equal(profile.lengthLabel, "very short");
});

test("analyzeStyle buckets six-word messages as short", () => {
  const profile = analyzeStyle(["one two three four five six", "one two three four five six"]);
  assert.equal(profile.avgWords, 6);
  assert.equal(profile.lengthLabel, "short");
});

test("analyzeStyle buckets long multi-clause messages as longer", () => {
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const profile = analyzeStyle([long, long]);
  assert.equal(profile.avgWords, 30);
  assert.equal(profile.lengthLabel, "longer");
});

// --- analyzeStyle: emoji ----------------------------------------------

test("analyzeStyle counts emoji per message and ranks the palette", () => {
  const profile = analyzeStyle(["love it 😭 😭", "nice 😭 🙏🏾"]);
  assert.equal(profile.emojiPerMessage, 2);
  assert.deepEqual(profile.topEmojis, ["😭", "🙏🏾"]);
});

test("analyzeStyle treats a skin-tone emoji as a single unit", () => {
  const profile = analyzeStyle(["thanks 🙏🏾", "appreciate it 🙏🏾"]);
  assert.equal(profile.emojiPerMessage, 1);
  assert.deepEqual(profile.topEmojis, ["🙏🏾"]);
});

test("analyzeStyle reports no emoji when there are none", () => {
  const profile = analyzeStyle(["all words here", "still just words"]);
  assert.equal(profile.emojiPerMessage, 0);
  assert.deepEqual(profile.topEmojis, []);
});

// --- analyzeStyle: full stops -----------------------------------------

test("analyzeStyle full-stop rate is 1 when every message ends with one", () => {
  const profile = analyzeStyle(["ok.", "sounds good."]);
  assert.equal(profile.fullStopRate, 1);
});

test("analyzeStyle does not count ellipses as full stops", () => {
  const profile = analyzeStyle(["hmm...", "let me think..."]);
  assert.equal(profile.fullStopRate, 0);
});

test("analyzeStyle does not count a decimal point as a full stop", () => {
  const profile = analyzeStyle(["it is 3.5 hours away", "about 2.5 more"]);
  assert.equal(profile.fullStopRate, 0);
});

test("analyzeStyle full-stop rate is a fraction across mixed messages", () => {
  const profile = analyzeStyle(["done.", "yeah", "ok", "cool"]);
  assert.equal(profile.fullStopRate, 0.25);
});

// --- analyzeStyle: capitalisation -------------------------------------

test("analyzeStyle lowercase rate is 1 when every message starts lowercase", () => {
  const profile = analyzeStyle(["hey there", "whats up"]);
  assert.equal(profile.lowercaseRate, 1);
});

test("analyzeStyle lowercase rate is 0 when messages are capitalised", () => {
  const profile = analyzeStyle(["Hey there", "Whats up"]);
  assert.equal(profile.lowercaseRate, 0);
});

test("analyzeStyle finds the first letter past a leading emoji", () => {
  const profile = analyzeStyle(["😭 hey", "yeah ok"]);
  assert.equal(profile.lowercaseRate, 1);
});

// --- analyzeStyle: determinism ----------------------------------------

test("analyzeStyle is order-independent", () => {
  assert.deepEqual(
    analyzeStyle(["a b", "c d e", "f g h i"]),
    analyzeStyle(["f g h i", "a b", "c d e"])
  );
});

test("analyzeStyle returns the full profile shape", () => {
  const profile = analyzeStyle(["yo", "wuu g", "u good"]);
  assert.deepEqual(profile, {
    sampleCount: 3,
    avgWords: 1.7,
    lengthLabel: "very short",
    emojiPerMessage: 0,
    topEmojis: [],
    fullStopRate: 0,
    lowercaseRate: 1
  });
});

// --- describe* fragments ----------------------------------------------

test("describeOperatorStyle and describeContactStyle return empty for null", () => {
  assert.equal(describeOperatorStyle(null), "");
  assert.equal(describeContactStyle(undefined), "");
});

test("describeOperatorStyle surfaces the measured signals", () => {
  const fragment = describeOperatorStyle(analyzeStyle(["yo", "wuu g", "u good"]));
  assert.match(fragment, /Observed operator style/);
  assert.match(fragment, /very short/);
  assert.match(fragment, /1\.7 words/);
  assert.match(fragment, /the operator almost never ends a sentence with a full stop/);
  assert.match(fragment, /lowercase/);
  assert.match(fragment, /does not use emoji/);
});

test("describeContactStyle surfaces the contact's emoji palette", () => {
  const fragment = describeContactStyle(analyzeStyle(["love it 😭 😭", "nice 😭 🙏🏾"]));
  assert.match(fragment, /Observed contact style/);
  assert.match(fragment, /😭 🙏🏾/);
});

// --- styleFingerprint -------------------------------------------------

test("styleFingerprint is stable for the same inputs", () => {
  const operator = analyzeStyle(["hey", "how are you"]);
  const contact = analyzeStyle(["good thanks", "you?"]);
  assert.equal(styleFingerprint(operator, contact), styleFingerprint(operator, contact));
});

test("styleFingerprint changes when a profile changes", () => {
  const terse = analyzeStyle(["yo", "wuu g"]);
  const wordy = analyzeStyle([
    "thanks so much for reaching out, this is genuinely really helpful",
    "appreciate you taking the time to write all of that out for me"
  ]);
  assert.notEqual(styleFingerprint(terse, null), styleFingerprint(wordy, null));
});

test("styleFingerprint is constant when both profiles are null", () => {
  assert.equal(styleFingerprint(null, null), "##");
});
