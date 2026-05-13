import test from "node:test";
import assert from "node:assert/strict";
import {
  softenCasualTrailingPeriod,
  applyVoiceRules,
  enforceSentenceStartCapitals
} from "../apps/runner/dist/services/ai.js";

test("softenCasualTrailingPeriod strips a trailing period from a short single-clause reply", () => {
  assert.equal(
    softenCasualTrailingPeriod("Hey, really appreciate that man."),
    "Hey, really appreciate that man"
  );
});

test("softenCasualTrailingPeriod strips a trailing period from a short two-clause reply", () => {
  assert.equal(
    softenCasualTrailingPeriod("Yhh i'm down, what time you thinking."),
    "Yhh i'm down, what time you thinking"
  );
});

test("softenCasualTrailingPeriod strips a one-word ack period", () => {
  assert.equal(softenCasualTrailingPeriod("Bet."), "Bet");
});

test("softenCasualTrailingPeriod leaves ellipsis intact", () => {
  assert.equal(softenCasualTrailingPeriod("hmm let me think..."), "hmm let me think...");
});

test("softenCasualTrailingPeriod leaves question marks intact", () => {
  assert.equal(softenCasualTrailingPeriod("you good?"), "you good?");
});

test("softenCasualTrailingPeriod leaves multi-sentence replies alone", () => {
  assert.equal(
    softenCasualTrailingPeriod("Hey. Hope you're good."),
    "Hey. Hope you're good."
  );
});

test("softenCasualTrailingPeriod leaves long-prose replies alone", () => {
  const long = "Sorry it's been ages, been buried in uni work and a few client deliverables that ran longer than expected, but really good to hear from you man, hope you've been keeping well.";
  assert.equal(softenCasualTrailingPeriod(long), long);
});

test("softenCasualTrailingPeriod is a no-op on empty input", () => {
  assert.equal(softenCasualTrailingPeriod(""), "");
});

test("applyVoiceRules still strips em-dashes / semicolons / colons", () => {
  assert.equal(
    applyVoiceRules("Hey — quick thought; let me know: works?"),
    "Hey , quick thought. let me know, works?"
  );
});

test("enforceSentenceStartCapitals capitalises after a question mark", () => {
  assert.equal(
    enforceSentenceStartCapitals("hope you're good? things have been wild"),
    "Hope you're good? Things have been wild"
  );
});

test("enforceSentenceStartCapitals capitalises after a full stop", () => {
  assert.equal(
    enforceSentenceStartCapitals("Bet. catch you later"),
    "Bet. Catch you later"
  );
});

test("enforceSentenceStartCapitals capitalises the first character of the message", () => {
  assert.equal(
    enforceSentenceStartCapitals("yhh fairs bro"),
    "Yhh fairs bro"
  );
});

test("enforceSentenceStartCapitals leaves mid-sentence lowercase 'i' alone", () => {
  assert.equal(
    enforceSentenceStartCapitals("yhh i'm down, what time you thinking"),
    "Yhh i'm down, what time you thinking"
  );
});

test("enforceSentenceStartCapitals is a no-op when sentences are already capitalised", () => {
  const input = "Hey, hope you're good? Things have been wild. Catch you soon";
  assert.equal(enforceSentenceStartCapitals(input), input);
});

test("enforceSentenceStartCapitals doesn't touch messages starting with an emoji", () => {
  assert.equal(
    enforceSentenceStartCapitals("🌚 you serious"),
    "🌚 you serious"
  );
});

test("enforceSentenceStartCapitals handles multiple sentence boundaries", () => {
  assert.equal(
    enforceSentenceStartCapitals("Damn fairs bro, you good? wanna talk? lmk"),
    "Damn fairs bro, you good? Wanna talk? Lmk"
  );
});

test("enforceSentenceStartCapitals is a no-op on empty input", () => {
  assert.equal(enforceSentenceStartCapitals(""), "");
});
