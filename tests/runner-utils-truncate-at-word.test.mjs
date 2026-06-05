import test from "node:test";
import assert from "node:assert/strict";
import { truncateAtWord, safeTruncate } from "../apps/runner/dist/platforms/utils.js";

// truncateAtWord caps a summary at N code points WITHOUT ending mid-word, so
// the stored whatTheyWant never reads "...current skills fo". It backs the hard
// safeTruncate up to the last whole-word boundary. (Follow-up to #474, the
// always-fit Today summaries change.)

const wholeWordInSource = (out, source) => {
  const last = out.split(/\s+/).pop();
  return new RegExp("(^|\\s)" + last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s|$)").test(source);
};

test("returns the text unchanged when it already fits the limit", () => {
  assert.equal(truncateAtWord("a short ask", 120), "a short ask");
});

test("trims surrounding whitespace but keeps short text", () => {
  assert.equal(truncateAtWord("  hello there  ", 120), "hello there");
});

test("backs up to the last whole word instead of cutting mid-word", () => {
  const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  // safeTruncate(…,22) lands inside "delta" -> "alpha bravo charlie de".
  const out = truncateAtWord(text, 22);
  assert.ok(Array.from(out).length <= 22, "stays within the limit");
  assert.equal(out, "alpha bravo charlie");
  assert.ok(!/[\s,;:]$/u.test(out), "no dangling separator");
});

test("keeps the final word when the cut already lands on a space boundary", () => {
  const text = "alpha bravo charlie delta echo";
  // 19 code points = "alpha bravo charlie"; the next char is a space, so the
  // cut is already at a boundary -> "charlie" must NOT be dropped.
  assert.equal(truncateAtWord(text, 19), "alpha bravo charlie");
});

test("keeps the final word when the cut lands just before punctuation", () => {
  const text = "pick a time. He then asked about the date for the call.";
  // 11 code points = "pick a time"; the next char is '.', a boundary.
  assert.equal(truncateAtWord(text, 11), "pick a time");
});

test("reproduces and fixes the Ngoni case (120-char mid-word cut)", () => {
  const full =
    "Ngoni asked what kind of project you are working on and you described your personal coding project and current skills focus on backend systems";
  // What the old blind cap stored:
  assert.equal(safeTruncate(full, 120).endsWith("skills fo"), true);
  // What the word-boundary cap stores now:
  const out = truncateAtWord(full, 120);
  assert.ok(Array.from(out).length <= 120);
  assert.ok(!out.endsWith("fo"), "must not end mid-word");
  assert.ok(out.endsWith("skills"), `expected to end on a whole word, got: ${out}`);
  assert.ok(wholeWordInSource(out, full));
});

test("falls back to a hard cut for a single oversized token", () => {
  const giant = "x".repeat(200);
  const out = truncateAtWord(giant, 120);
  assert.equal(Array.from(out).length, 120);
});

test("does not bisect an emoji at the boundary (code-point safe)", () => {
  const text = "thanks so much for the update " + "\u{1F602}".repeat(100);
  const out = truncateAtWord(text, 50);
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out);
  assert.equal(unpaired, false);
});
