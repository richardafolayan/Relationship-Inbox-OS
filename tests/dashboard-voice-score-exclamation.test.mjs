import test from "node:test";
import assert from "node:assert/strict";

// voice-score.ts is framework-free, so the tsx loader resolves this .ts import
// directly (same pattern as dashboard-clean-ask-summary.test.mjs).
const { buildCorpusStats, scoreDraftAgainstCorpus } = await import(
  "../apps/dashboard/lib/voice-score.ts"
);

// Regression for P3-PL10: the corpus side counted '!' on post-splitSentences
// pieces, but SENTENCE_RE consumes the terminating '.', '!', '?'. So an
// exclamation-heavy corpus collapsed to ~0 exclamationsPerSentence while the
// draft side counted every '!'. The two were not comparable, inverting the
// signal: an on-voice draft was penalised as "More exclamation marks".

const EXCLAIM_HEAVY = [
  "Thanks so much!",
  "Wow! Amazing! Incredible!",
  "Great to hear! See you soon!"
];

test("exclamation-heavy corpus yields a non-zero exclamationsPerSentence", () => {
  const stats = buildCorpusStats(EXCLAIM_HEAVY);
  // Before the fix the terminating '!' were stripped by splitSentences, so this
  // collapsed to 0; an exclamatory corpus must report ~1 per sentence.
  assert.ok(
    stats.exclamationsPerSentence >= 0.9,
    `expected ~1 excl/sentence for an exclamatory corpus, got ${stats.exclamationsPerSentence}`
  );
});

test("an on-voice exclamatory draft emits no exclamation signal", () => {
  const stats = buildCorpusStats(EXCLAIM_HEAVY);
  const res = scoreDraftAgainstCorpus("Wow! Amazing! Incredible!", stats);
  // Same shape as the corpus, so the exclamation densities match: no signal,
  // no exclamation penalty. (Before the fix this was flagged "More exclamation
  // marks than your voice", the exact opposite of the operator's habit.)
  assert.equal(
    res.signals.some((s) => /exclamation/i.test(s.signal)),
    false,
    `on-voice draft should emit no exclamation signal, got ${JSON.stringify(res.signals)}`
  );
});

test("a flat-voice corpus flags an exclamation-heavy draft as MORE", () => {
  const stats = buildCorpusStats([
    "Thanks for that.",
    "Let me check.",
    "I will get back to you."
  ]);
  const res = scoreDraftAgainstCorpus("Wow! Great!", stats);
  const sig = res.signals.find((s) => /exclamation/i.test(s.signal));
  assert.ok(sig, "expected an exclamation signal");
  assert.match(sig.signal, /More exclamation/);
});
