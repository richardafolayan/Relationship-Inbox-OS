import test from "node:test";
import assert from "node:assert/strict";

// risk.ts is framework-free, so the tsx loader resolves this .ts import
// directly (same pattern as dashboard-toast-gesture.test.mjs).
const { initials } = await import("../apps/dashboard/lib/risk.ts");

// Regression for P3-PL7: initials() filtered name tokens with the
// code-point-aware regex /^\p{L}/u but then extracted the first character
// with plain UTF-16 indexing (word[0]). For a first letter in the
// Supplementary Plane (code point >= U+10000) that returned a lone high
// surrogate, so the avatar rendered a broken/replacement glyph. The fix
// spreads the token ([...word][0]) to extract the first code point whole.

test("astral letter-led token yields a single complete glyph, not a lone surrogate", () => {
  // U+20000 is a CJK Extension-B ideograph (surrogate pair D840 DC00).
  const out = initials("\u{20000} Wong");
  assert.equal(out, "\u{20000}W");
  // No lone surrogate left behind.
  assert.ok(!/[\uD800-\uDFFF]/.test(out.replace(/[\u{10000}-\u{10FFFF}]/gu, "")));
});

test("math-script first letter is not split into a lone high surrogate", () => {
  // U+1D4D9 MATHEMATICAL BOLD SCRIPT CAPITAL J (surrogate pair D835 DCD9).
  const out = initials("\u{1D4D9}ohn");
  assert.equal([...out].length, 1);
  assert.equal(out, "\u{1D4D9}");
});

test("no-letter astral fallback yields a complete glyph", () => {
  // U+1F389 PARTY POPPER, no letter token -> first-token fallback branch.
  assert.equal(initials("\u{1F389}"), "\u{1F389}");
});

test("ascii and accented (BMP) names are unaffected", () => {
  assert.equal(initials("John Smith"), "JS");
  assert.equal(initials("José García"), "JG");
  assert.equal(initials("Cynthia (ACS)"), "C");
});
