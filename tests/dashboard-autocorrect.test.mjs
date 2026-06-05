import test from "node:test";
import assert from "node:assert/strict";

// #466 (pilot R-0065). The dashboard ships ESM TypeScript; this test must be
// invoked with `node --import tsx --test ...` so the tsx hook resolves the
// .ts import below — see test:all in the root package.json.
const { autocorrectAtCaret, correctWord } = await import(
  "../apps/dashboard/lib/autocorrect.ts"
);

// Simulate "the user just typed a space after `word`", placing it
// mid-sentence (after "ok ") so sentence-start capitalisation doesn't
// confound the typo assertions. Returns the corrected word's text with the
// lead stripped, or null when nothing changed.
function commit(word) {
  const lead = "ok ";
  const full = `${lead}${word} `;
  const r = autocorrectAtCaret(full, full.length);
  return r ? r.text.slice(lead.length) : null;
}

test("fixes a high-confidence typo on word commit", () => {
  assert.equal(commit("teh"), "the ");
  assert.equal(commit("definately"), "definitely ");
  assert.equal(commit("seperate"), "separate ");
});

test("expands a no-apostrophe contraction that isn't a valid word", () => {
  assert.equal(commit("dont"), "don't ");
  assert.equal(commit("youre"), "you're ");
  assert.equal(commit("wouldnt"), "wouldn't ");
});

test("uppercases the standalone pronoun i and its contractions anywhere", () => {
  assert.equal(commit("i"), "I ");
  assert.equal(commit("im"), "I'm ");
  assert.equal(commit("ive"), "I've ");
});

test("preserves a leading capital when fixing a typo", () => {
  assert.equal(commit("Teh"), "The ");
});

test("capitalises the first letter of a sentence", () => {
  // start of text
  assert.equal(autocorrectAtCaret("hello ", "hello ".length).text, "Hello ");
  // after a sentence terminator
  assert.equal(autocorrectAtCaret("Done. now ", "Done. now ".length).text, "Done. Now ");
});

test("does not capitalise a normal mid-sentence word", () => {
  // "there" is already correct and not at a sentence start -> no change
  assert.equal(commit("there"), null);
});

test("leaves protected tokens untouched (urls, emails, handles, hashtags, numbers, acronyms)", () => {
  assert.equal(commit("dont@example.com"), null);
  assert.equal(commit("github.com/teh"), null);
  assert.equal(commit("@dont"), null);
  assert.equal(commit("#teh"), null);
  assert.equal(commit("teh123"), null);
  assert.equal(commit("ASAP"), null);
});

test("only fires on a whitespace commit, not on every keystroke", () => {
  // caret sitting on the last letter of an as-yet-uncommitted typo -> no fix
  assert.equal(autocorrectAtCaret("teh", 3), null);
});

test("does not touch an already-correct contraction", () => {
  assert.equal(commit("don't"), null);
});

test("exposes original + corrected so the caller can offer an undo", () => {
  const r = autocorrectAtCaret("teh ", "teh ".length);
  assert.ok(r);
  assert.equal(r.original, "teh");
  assert.equal(r.corrected, "The"); // sentence-start here, so capitalised
  assert.equal(r.start, 0);
});

test("correctWord is a pure helper: typo + sentence-start compose", () => {
  assert.equal(correctWord("teh", true), "The");
  assert.equal(correctWord("teh", false), "the");
  assert.equal(correctWord("definately", false), "definitely");
  assert.equal(correctWord("fine", false), "fine");
});

test("returns null when nothing needs correcting", () => {
  assert.equal(commit("there"), null);
  assert.equal(commit("fine"), null);
});
