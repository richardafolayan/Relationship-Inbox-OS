import test from "node:test";
import assert from "node:assert/strict";
import { safeTruncate, stripUnpairedSurrogates, cleanText } from "../apps/runner/dist/platforms/utils.js";

test("safeTruncate keeps 4-byte emojis whole when the cut lands on a surrogate boundary", () => {
  // Reproduce Sarah Nwisi sync-fail bug: trailing 😂 (😂) at chars
  // 137-138 and 139-140; .slice(0, 140) splits the second emoji and produces
  // an unpaired \uD83D, which Prisma's SQLite driver later rejects with
  // "unexpected end of hex escape".
  const text = "I'm glad you feel a little relieved! You seem like you're doing PLENTY fine academically so I'm sure you have no reason to stress at alll😂😂";
  const truncated = safeTruncate(text, 140);
  // The naive .slice(0, 140) would have length 140 with an unpaired surrogate
  // at the end; safeTruncate either keeps both emojis (if they fit as code
  // points) or drops the second one entirely. Either way no unpaired surrogate.
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(truncated), false);
});

test("safeTruncate counts code points, not UTF-16 code units", () => {
  // Two emojis = 2 code points in Array.from terms, but 4 UTF-16 units.
  // A 3-code-point limit should fit the prefix "ab" + one emoji.
  const text = "ab\u{1F602}\u{1F602}";
  assert.equal(Array.from(text).length, 4);
  const truncated = safeTruncate(text, 3);
  assert.equal(Array.from(truncated).length, 3);
  // Last code point is the first emoji.
  assert.equal(Array.from(truncated)[2], "\u{1F602}");
});

test("safeTruncate is a no-op when text is shorter than the limit", () => {
  assert.equal(safeTruncate("hello", 100), "hello");
  assert.equal(safeTruncate("", 100), "");
});

test("stripUnpairedSurrogates removes lone high or low surrogates", () => {
  // Synthesise an unpaired surrogate the way a bad slice would.
  const broken = "abc\uD83D"; // high surrogate, no following low — invalid
  assert.equal(stripUnpairedSurrogates(broken), "abc");

  const broken2 = "\uDE02xyz"; // low surrogate without preceding high
  assert.equal(stripUnpairedSurrogates(broken2), "xyz");

  // Properly paired emoji passes through untouched.
  const valid = "abc\u{1F602}xyz";
  assert.equal(stripUnpairedSurrogates(valid), valid);
});

test("cleanText strips unpaired surrogates AND collapses whitespace", () => {
  // Defence in depth: cleanText is the helper most call sites use; once it
  // strips surrogates, naive callers don't have to remember to.
  const broken = "  Sarah:  hello\uD83D  world  ";
  assert.equal(cleanText(broken), "Sarah: hello world");
});
