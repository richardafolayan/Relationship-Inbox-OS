import test from "node:test";
import assert from "node:assert/strict";

// preview.ts is framework-free, so the tsx loader resolves this .ts import
// directly (same pattern as dashboard-horizon.test.mjs).
const { cleanAskSummary } = await import("../apps/dashboard/lib/preview.ts");

// cleanAskSummary repairs AI ask-summaries (whatTheyWant) that were stored
// hard-cut mid-word by the old fixed-length cap ("...current skills fo"). It
// only acts on values sitting exactly at a known cut length that do NOT end on
// a sentence boundary; everything else is returned untouched. (Follow-up to the
// always-fit Today summaries change, #474.)

const cutTo = (s, n) => Array.from(s).slice(0, n).join("");

test("repairs the Ngoni 120-char mid-word cut", () => {
  const full =
    "Ngoni asked what kind of project you are working on and you described your personal coding project and current skills focus on backend systems";
  const stored = cutTo(full, 120); // what the old blind safeTruncate stored
  assert.equal(Array.from(stored).length, 120);
  assert.ok(stored.endsWith("skills fo"));

  const out = cleanAskSummary(stored);
  assert.ok(!out.endsWith("fo"), "drops the bisected word");
  assert.ok(out.endsWith("skills"), `should end on a whole word, got: ${out}`);
  assert.ok(Array.from(out).length < 120);
});

test("leaves a 119-char summary untouched even without trailing punctuation", () => {
  // A blind cut yields EXACTLY 120 code points, never 119, so a natural
  // 119-char summary must keep its final whole word (the PM's over-trim flag).
  const base =
    "Ngoni asked what kind of project you are working on and you described your personal coding project and current focus area";
  const natural = cutTo(base, 119);
  assert.equal(Array.from(natural).length, 119);
  assert.ok(!/[.!?]$/.test(natural), "fixture has no terminal punctuation");
  assert.equal(cleanAskSummary(natural), natural, "119-char value must be returned unchanged");
});

test("leaves a 121-char summary untouched (only exactly 120 is a cut)", () => {
  const text =
    "She shared lots of photos from the recent Lagos trip and asked when you would next be free to grab some dinner soon";
  assert.ok(Array.from(text).length !== 120);
  assert.equal(cleanAskSummary(text), text);
});

test("leaves a cleanly-ended summary untouched (ends with punctuation)", () => {
  const ok = "Carlos confirmed Friday lunch, he's waiting on you to pick a time.";
  assert.equal(cleanAskSummary(ok), ok);
});

test("leaves a short summary untouched (not at a cut length)", () => {
  const ok = "She asked when you're free for dinner";
  assert.equal(cleanAskSummary(ok), ok);
});

test("leaves a value exactly at the cap untouched when it ends on punctuation", () => {
  // Build a clean sentence whose length is exactly 120 and ends with '.'.
  const base = "She shared photos from the Lagos trip and asked when you would next be free to grab dinner together sometime really soon";
  const exactly120 = cutTo(base, 119) + ".";
  assert.equal(Array.from(exactly120).length, 120);
  assert.equal(cleanAskSummary(exactly120), exactly120);
});

test("handles null / empty input", () => {
  assert.equal(cleanAskSummary(null), "");
  assert.equal(cleanAskSummary(undefined), "");
  assert.equal(cleanAskSummary("   "), "");
});
