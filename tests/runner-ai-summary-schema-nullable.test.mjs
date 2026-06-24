import test from "node:test";
import assert from "node:assert/strict";
import { summarySchema } from "../apps/runner/dist/services/ai.js";

// Regression for the live failure: gpt-5-nano (and other providers) return
// `urgency_hint: null` instead of omitting it, even though the prompt says
// "string or omit if none". Under the old `z.string().optional()` schema that
// threw "Expected string, received null", which failed the WHOLE summary parse,
// so a provider that answered correctly was logged as a failure and the
// fallback chain exhausted (both Gemini AND OpenAI "failed"). `.nullish()`
// must accept null so the valid answer is kept.
const baseSummary = {
  summary: "You owe Ashley a reply about the venue.",
  what_they_want: "Confirm whether the hall is booked.",
  open_loops: ["Venue confirmation outstanding"],
  remember: [],
  tone_notes: [],
  needs_reply: true
};

test("summarySchema accepts urgency_hint: null (no longer a hard parse failure)", () => {
  const parsed = summarySchema.parse({ ...baseSummary, urgency_hint: null });
  // null is allowed and round-trips as null (callers normalise null -> undefined).
  assert.equal(parsed.urgency_hint, null);
});

test("summarySchema accepts an omitted urgency_hint", () => {
  const parsed = summarySchema.parse({ ...baseSummary });
  assert.equal(parsed.urgency_hint, undefined);
});

test("summarySchema accepts a string urgency_hint", () => {
  const parsed = summarySchema.parse({ ...baseSummary, urgency_hint: "Reply today" });
  assert.equal(parsed.urgency_hint, "Reply today");
});

test("summarySchema still rejects a non-string, non-null urgency_hint", () => {
  assert.throws(() => summarySchema.parse({ ...baseSummary, urgency_hint: 42 }));
});
