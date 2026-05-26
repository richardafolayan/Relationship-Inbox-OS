import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitisePartialReason,
  PARTIAL_REASON_FALLBACK
} from "../apps/runner/dist/services/ai.js";

test("clean short reasons are returned unchanged", () => {
  const out = sanitisePartialReason("Almost there. Add the pricing range.");
  assert.equal(out, "Almost there. Add the pricing range.");
});

test("empty or whitespace reasons return undefined so the row drops", () => {
  assert.equal(sanitisePartialReason(""), undefined);
  assert.equal(sanitisePartialReason("   "), undefined);
  assert.equal(sanitisePartialReason(null), undefined);
  assert.equal(sanitisePartialReason(undefined), undefined);
});

test("em dashes are stripped", () => {
  const out = sanitisePartialReason("Mentions the offer — but does not say yes or no.");
  assert.ok(out);
  assert.ok(!out.includes("—"), "em-dash should be removed");
  assert.ok(!out.includes("–"), "en-dash should not appear");
});

test("en dashes are stripped", () => {
  const out = sanitisePartialReason("Almost there – add the date.");
  assert.ok(out);
  assert.ok(!out.includes("–"));
});

test("'you forgot' phrasing falls back to the neutral default", () => {
  const out = sanitisePartialReason("Looks like you forgot to confirm the date.");
  assert.equal(out, PARTIAL_REASON_FALLBACK);
});

test("'you missed' phrasing falls back to the neutral default", () => {
  const out = sanitisePartialReason("You missed the question about pricing.");
  assert.equal(out, PARTIAL_REASON_FALLBACK);
});

test("'ignored' phrasing falls back to the neutral default", () => {
  const out = sanitisePartialReason("The draft ignored the timing question.");
  assert.equal(out, PARTIAL_REASON_FALLBACK);
});

test("'neglected' phrasing falls back to the neutral default", () => {
  const out = sanitisePartialReason("Neglected to confirm a date.");
  assert.equal(out, PARTIAL_REASON_FALLBACK);
});

test("'failed to' phrasing falls back to the neutral default", () => {
  const out = sanitisePartialReason("Failed to answer the pricing question.");
  assert.equal(out, PARTIAL_REASON_FALLBACK);
});

test("over-long reasons are truncated to 120 characters", () => {
  const long = "a".repeat(250);
  const out = sanitisePartialReason(long);
  assert.ok(out);
  assert.ok(out.length <= 120, `expected <= 120 chars, got ${out.length}`);
});

test("banned phrase check is case insensitive", () => {
  const out = sanitisePartialReason("You FORGOT the date.");
  assert.equal(out, PARTIAL_REASON_FALLBACK);
});

test("static fallback contains no em or en dashes", () => {
  assert.ok(!PARTIAL_REASON_FALLBACK.includes("—"));
  assert.ok(!PARTIAL_REASON_FALLBACK.includes("–"));
});
