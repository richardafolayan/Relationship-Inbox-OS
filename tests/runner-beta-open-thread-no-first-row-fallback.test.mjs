import test from "node:test";
import assert from "node:assert/strict";
import { resolveBetaThreadMatch, betaIdentityMatch } from "../apps/runner/dist/platforms/beta-adapter.js";

// Bug H4: BetaAdapter.openThreadFromInbox used to fall back to clicking the
// FIRST inbox thread when neither the title nor the hasText locator matched the
// target displayName. For an IG/TikTok thread with a null threadUrl that meant a
// send could be typed into — and sent to — whoever's conversation happened to be
// first. resolveBetaThreadMatch encodes the fix: a name-miss returns null (the
// caller then throws THREAD_NOT_FOUND) instead of selecting a row.

test("resolveBetaThreadMatch prefers the title locator when it matches", () => {
  assert.equal(resolveBetaThreadMatch({ hasTitleMatch: true, hasTextMatch: false }), "title");
  assert.equal(resolveBetaThreadMatch({ hasTitleMatch: true, hasTextMatch: true }), "title");
});

test("resolveBetaThreadMatch uses the text locator when only it matches", () => {
  assert.equal(resolveBetaThreadMatch({ hasTitleMatch: false, hasTextMatch: true }), "text");
});

test("resolveBetaThreadMatch returns null when NEITHER locator matches (no first-row fallback)", () => {
  // The regression guard: the old code clicked thread_item.first() here, opening
  // the wrong conversation. The fix returns null so the caller throws
  // THREAD_NOT_FOUND instead of acting on the wrong contact.
  assert.equal(resolveBetaThreadMatch({ hasTitleMatch: false, hasTextMatch: false }), null);
});

test("betaIdentityMatch matches the same contact case- and whitespace-insensitively", () => {
  assert.equal(betaIdentityMatch("Ada Lovelace", "ada lovelace"), true);
  assert.equal(betaIdentityMatch("  Ada   Lovelace ", "Ada Lovelace"), true);
  // Header may carry extra chrome around the name (online status, handle, etc.).
  assert.equal(betaIdentityMatch("Ada Lovelace  Active now", "Ada Lovelace"), true);
  // Target may be a longer scraped name than the header text.
  assert.equal(betaIdentityMatch("Ada", "Ada Lovelace"), true);
});

test("betaIdentityMatch rejects a different contact (the wrong-recipient case)", () => {
  assert.equal(betaIdentityMatch("Charles Babbage", "Ada Lovelace"), false);
});

test("betaIdentityMatch treats empty header or target as not-a-match", () => {
  assert.equal(betaIdentityMatch("", "Ada Lovelace"), false);
  assert.equal(betaIdentityMatch("Ada Lovelace", ""), false);
  assert.equal(betaIdentityMatch(undefined, undefined), false);
});
