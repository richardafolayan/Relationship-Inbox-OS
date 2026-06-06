import test from "node:test";
import assert from "node:assert/strict";

// Q12 regression. The dashboard ships ESM TypeScript; this test must be
// invoked with `node --import tsx --test ...` so the tsx hook resolves the
// .ts import below — see test:all in the root package.json.
const { autocorrectAtCaret } = await import(
  "../apps/dashboard/lib/autocorrect.ts"
);

// Simulate "the user just typed a space at the end of the text", committing
// the final word. Returns the corrected full text, or null when nothing
// changed (i.e. the word was left exactly as typed).
function commitEnd(text) {
  const r = autocorrectAtCaret(text, text.length);
  return r ? r.text : null;
}

test("a period closing a known abbreviation does not capitalise the next word", () => {
  // Each of these would become "... <Abbrev>. Word " under the buggy
  // single-character terminator test. The following word must stay as typed.
  assert.equal(commitEnd("Let's meet at 3 p.m. today "), null);
  assert.equal(commitEnd("Call me at 9 a.m. tomorrow "), null);
  assert.equal(commitEnd("Use e.g. this "), null);
  assert.equal(commitEnd("Stuff i.e. that "), null);
  assert.equal(commitEnd("Read the docs etc. and "), null);
  assert.equal(commitEnd("Compare vs. that "), null);
  assert.equal(commitEnd("Ask Mr. jones "), null);
  assert.equal(commitEnd("Ask Mrs. jones "), null);
  assert.equal(commitEnd("Ask Ms. jones "), null);
  assert.equal(commitEnd("Talk to Dr. smith "), null);
  assert.equal(commitEnd("See the U.S. team "), null);
});

test("a single-letter-dot run (initials/abbrev) is not a sentence boundary", () => {
  assert.equal(commitEnd("The A.B. case "), null);
});

test("a genuine full stop still starts a new sentence", () => {
  // commitEnd corrects only the final (space-committed) word, so the word
  // right after a genuine full stop is the one that gets capitalised.
  assert.equal(commitEnd("Done. now "), "Done. Now ");
  assert.equal(commitEnd("Ok. yes "), "Ok. Yes ");
});

test("! and ? remain unconditional sentence terminators", () => {
  assert.equal(commitEnd("Stop! go "), "Stop! Go ");
  assert.equal(commitEnd("What? yes "), "What? Yes ");
});

test("start of text still capitalises", () => {
  assert.equal(commitEnd("hello "), "Hello ");
});
