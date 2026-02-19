import test from "node:test";
import assert from "node:assert/strict";
import { needsReplyFromPreview } from "../apps/runner/dist/linkedin/linkedinRowSignals.js";

test("needsReplyFromPreview returns false when preview starts with You:", () => {
  assert.equal(needsReplyFromPreview("You: Hey Liz"), false);
});

test("needsReplyFromPreview returns true when preview does not start with You:", () => {
  assert.equal(needsReplyFromPreview(" Nana: Hello "), true);
});

test("needsReplyFromPreview is case-insensitive for You:", () => {
  assert.equal(needsReplyFromPreview("YOU: test"), false);
});

test("needsReplyFromPreview returns false for empty preview", () => {
  assert.equal(needsReplyFromPreview(""), false);
});

test("needsReplyFromPreview returns false for null preview", () => {
  assert.equal(needsReplyFromPreview(null), false);
});
