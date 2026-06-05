import test from "node:test";
import assert from "node:assert/strict";
import {
  capAskSummary,
  truncateAtWord,
  ASK_SUMMARY_MAX_CODE_POINTS
} from "../apps/runner/dist/platforms/utils.js";

// capAskSummary caps the stored ask-summary (whatTheyWant). The Today hero
// renders it IN FULL via <FitText> (shrinks the font, never clips) and the
// needs-reply row wraps it, so the budget is generous (200 code points, not
// the old 120). Its only job is to stop a runaway multi-sentence model
// response from forcing the hero font to its readability floor — a COMPLETE
// ask the model wrote is stored verbatim. When the cap does fire it backs up
// to a whole word AND drops any dangling connective, so the stored value never
// reads "...acknowledge the update and gently" — the regression Richard
// re-flagged ("Still seems to be clipped?") after the earlier mid-word fix.

test("the ask-summary budget is 200 code points (not the old 120)", () => {
  assert.equal(ASK_SUMMARY_MAX_CODE_POINTS, 200);
});

test("stores a complete BSC-ball ask in full — the exact regression", () => {
  // The model's full second-person ask. Under 200 chars, so it must survive
  // intact; the old 120 cap amputated it to "...acknowledge the update and
  // gently".
  const full =
    "You last asked about her plans for the BSC ball and who is going; you should acknowledge the update and gently encourage her to come along.";
  assert.ok(
    Array.from(full).length <= 200,
    `fixture must be within budget (got ${Array.from(full).length})`
  );
  assert.ok(
    Array.from(full).length > 120,
    "fixture must be the kind of ask the old 120 cap chopped"
  );
  const out = capAskSummary(full);
  assert.equal(out, full, "a complete sub-200 ask is stored verbatim");
  assert.ok(out.endsWith("come along."), "the thought is finished, not clipped at 'gently'");
});

test("returns a short complete ask unchanged", () => {
  const ask = "Carlos confirmed Friday lunch, he's waiting on you to pick a time.";
  assert.equal(capAskSummary(ask), ask);
});

test("trims surrounding whitespace but keeps the text", () => {
  assert.equal(
    capAskSummary("  She asked when you're free for dinner  "),
    "She asked when you're free for dinner"
  );
});

test("handles null / undefined / blank", () => {
  assert.equal(capAskSummary(null), "");
  assert.equal(capAskSummary(undefined), "");
  assert.equal(capAskSummary("   "), "");
});

test("caps an over-long ask at the 200-code-point word boundary (no mid-word)", () => {
  const giant = "acknowledge the recent update and reply to her soon ".repeat(20);
  assert.ok(Array.from(giant).length > 200, "fixture must exceed the budget");
  const out = capAskSummary(giant);
  assert.ok(Array.from(out).length <= 200, "stays within budget");
  assert.ok(!/\s$/u.test(out), "no dangling separator");
  // The final token appears as a whole word in the source (never bisected).
  const lastWord = out.split(/\s+/).pop();
  assert.ok(
    new RegExp("(^|\\s)" + lastWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s|$)").test(giant),
    `final word "${lastWord}" should be whole`
  );
});

test("drops a dangling connective the hard cap exposes (no '...and' tail)", () => {
  // Build a string whose 200-code-point word-boundary cut lands right after
  // the connective "and", then assert capAskSummary removes it.
  let text = "";
  while (Array.from(text).length < 190) text += "detail ";
  text +=
    "and tail words that push the whole string well beyond two hundred characters in total length here";

  const hard = truncateAtWord(text, ASK_SUMMARY_MAX_CODE_POINTS);
  assert.ok(/\band$/u.test(hard), `precondition: raw cut ends on "and" (got ${JSON.stringify(hard)})`);

  const out = capAskSummary(text);
  assert.ok(
    !/\b(and|to|with|on|of|the|for)$/u.test(out),
    `must not end on a connective (got ${JSON.stringify(out)})`
  );
  assert.ok(out.endsWith("detail"), `ends on the last substantive word (got ${JSON.stringify(out)})`);
  assert.ok(Array.from(out).length < Array.from(hard).length, "dropped the dangling word");
});

test("keeps a legitimate '...on you' ending when within budget (no over-trim)", () => {
  // "you" is in the connective set, but the drop only runs AFTER a hard cut.
  // A complete sub-200 ask that genuinely ends in "you" must be preserved.
  const ask = "She has shared the venue and is now waiting on you";
  assert.ok(Array.from(ask).length <= 200);
  assert.equal(capAskSummary(ask), ask);
});

test("never guts the summary chasing function words (substance floor)", () => {
  // A pathological over-budget string that is mostly connectives still keeps a
  // substantive lead rather than collapsing to empty.
  const text = "Reply about the weekend plans " + "and then and so and to and with ".repeat(20);
  const out = capAskSummary(text);
  assert.ok(Array.from(out).length >= 30, `keeps a substantive lead (got ${JSON.stringify(out)})`);
});

test("does not bisect an emoji when capping (code-point safe)", () => {
  const text = "acknowledge the update ".repeat(8) + "\u{1F602}".repeat(100);
  const out = capAskSummary(text);
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out);
  assert.equal(unpaired, false);
  assert.ok(Array.from(out).length <= 200);
});
