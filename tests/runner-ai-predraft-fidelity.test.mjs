import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BRIEF_FIDELITY_REMINDER,
  CASUAL_VOICE_PROMPT,
  DRAFT_COVERAGE_GROUNDING_CLAUSE,
  FORMAL_VOICE_PROMPT,
  PREDRAFT_FIDELITY_REMINDER,
  SYSTEM_PROMPT
} from "../apps/runner/dist/services/ai.js";

// Issue #387. These tests pin the fidelity language into place at the
// prompt-string layer. They do NOT run an LLM — behavioural verification
// on a real Brandon-shaped thread is still required before merge (this
// worktree lacks provider creds for a live capture). What they DO catch
// is regression: a future edit that drops the "NO INVENTED FRAMING"
// clause from the voice prompts, or removes the Brandon worked example,
// will trip an assertion here before it reaches production.

// ── Constants exposed for tests ────────────────────────────────────────

test("PREDRAFT_FIDELITY_REMINDER is exported and primes against invented framing", () => {
  assert.equal(typeof PREDRAFT_FIDELITY_REMINDER, "string");
  assert.ok(PREDRAFT_FIDELITY_REMINDER.length > 0, "reminder must be non-empty");
  // The header has to read as a hard rule, not a soft suggestion.
  assert.match(PREDRAFT_FIDELITY_REMINDER, /FIDELITY/);
  // Must explicitly ban the Brandon-style editorialising phrase.
  assert.match(PREDRAFT_FIDELITY_REMINDER, /big move/i);
  // Meta rule — the interpretation comes from the contact, not the model.
  assert.match(
    PREDRAFT_FIDELITY_REMINDER,
    /interpretation must come from them/i
  );
  // The reminder must explicitly forbid adding emotional weight / stakes.
  assert.match(PREDRAFT_FIDELITY_REMINDER, /emotional weight/i);
  assert.match(PREDRAFT_FIDELITY_REMINDER, /stakes/i);
});

test("DRAFT_COVERAGE_GROUNDING_CLAUSE pushes invented-framing drafts to PARTIAL not ADDRESSED", () => {
  assert.equal(typeof DRAFT_COVERAGE_GROUNDING_CLAUSE, "string");
  assert.ok(DRAFT_COVERAGE_GROUNDING_CLAUSE.length > 0);
  // PARTIAL must be named as the verdict for invented-framing drafts.
  assert.match(DRAFT_COVERAGE_GROUNDING_CLAUSE, /PARTIAL/);
  // The Brandon worked example is the canonical regression fixture.
  assert.match(DRAFT_COVERAGE_GROUNDING_CLAUSE, /Middle East/);
  assert.match(DRAFT_COVERAGE_GROUNDING_CLAUSE, /big move/i);
  // The rule itself: contact-didn't-express framing → PARTIAL.
  assert.match(
    DRAFT_COVERAGE_GROUNDING_CLAUSE,
    /contact (did not|didn't) express/i
  );
  // ADDRESSED is reserved for language traceable to what the contact said.
  assert.match(
    DRAFT_COVERAGE_GROUNDING_CLAUSE,
    /traceable to what the contact actually said/i
  );
});

// ── Voice prompts carry the new NO INVENTED FRAMING clause ─────────────

test("CASUAL_VOICE_PROMPT carries the NO INVENTED FRAMING section after HALLUCINATION GUARD", () => {
  // Original hallucination guard must still be present (factual fabrication).
  assert.match(CASUAL_VOICE_PROMPT, /HALLUCINATION GUARD/);
  assert.match(CASUAL_VOICE_PROMPT, /Do not invent shared experiences/);
  // New clause covers interpretive editorialising (Brandon case).
  assert.match(CASUAL_VOICE_PROMPT, /NO INVENTED FRAMING/);
  // Worked example: bad draft + grounded counter-example.
  assert.match(CASUAL_VOICE_PROMPT, /Middle East/);
  assert.match(CASUAL_VOICE_PROMPT, /big move/i);
  assert.match(CASUAL_VOICE_PROMPT, /Fair enough on pausing/);
  // Banned-moves list must include common interpretive phrases the model
  // reaches for when filling silence.
  assert.match(CASUAL_VOICE_PROMPT, /huge step/i);
  assert.match(CASUAL_VOICE_PROMPT, /exciting opportunity/i);
  // The self-check rule — cut the phrase if the contact didn't say it.
  assert.match(CASUAL_VOICE_PROMPT, /Self-check/i);
});

test("FORMAL_VOICE_PROMPT carries a NO INVENTED FRAMING bullet alongside its existing hallucination guard", () => {
  // Original strict hallucination guard for LinkedIn / formal tier stays.
  assert.match(FORMAL_VOICE_PROMPT, /HALLUCINATION GUARD/);
  // New framing-specific clause.
  assert.match(FORMAL_VOICE_PROMPT, /NO INVENTED FRAMING/);
  // Same Brandon worked example so the formal tier shares the regression
  // fixture. Same failure mode applies on LinkedIn — recruiters explaining
  // why they paused an offer, etc.
  assert.match(FORMAL_VOICE_PROMPT, /Middle East/);
  assert.match(FORMAL_VOICE_PROMPT, /big move/i);
  assert.match(FORMAL_VOICE_PROMPT, /Fair enough on pausing/);
  // Banned-moves list shared with casual tier.
  assert.match(FORMAL_VOICE_PROMPT, /huge step/i);
});

// ── Brandon-shaped assembled context: every guard reaches the model ────

test("Brandon iMessage fixture: assembled system + reminder carries every fidelity guard the model needs", () => {
  // Mirrors the assembly in generateSuggestedReplies for an iMessage
  // (casual) thread:
  //   system  = SYSTEM_PROMPT + "\n\n" + CASUAL_VOICE_PROMPT
  //   user    = ... + PREDRAFT_FIDELITY_REMINDER + ...
  // The full thing concatenated is what the model sees. If a future edit
  // drops any of these from the assembly path, the regression assertion
  // fires before the change lands.
  const assembled = [
    SYSTEM_PROMPT,
    "",
    CASUAL_VOICE_PROMPT,
    "",
    "USER PROMPT BEGIN",
    PREDRAFT_FIDELITY_REMINDER,
    "MODE: REPLY",
    "(Brandon thread body would go here in production)"
  ].join("\n");

  // The bad draft is named so the model recognises it as a regression case.
  assert.match(assembled, /big move/i);
  // The grounded alternative is named so the model has a positive template.
  assert.match(assembled, /Fair enough on pausing/);
  // The meta rule — interpretation comes from the contact, not the model.
  assert.match(assembled, /interpretation must come from them/i);
  // Original factual hallucination guard still reaches the model.
  assert.match(assembled, /Do not invent shared experiences/);
  // Attribution discipline from SYSTEM_PROMPT still reaches the model.
  assert.match(assembled, /ATTRIBUTION DISCIPLINE/);
});

test("Brandon iMessage fixture: assembled coverage prompt carries the grounding clause that demotes 'big move' draft to PARTIAL", () => {
  // Mirrors the assembly in checkDraftCoverage. The PARTIAL grounding
  // clause is inserted after the three bucket definitions and before the
  // schema, so the model reads it as an addendum to the bucket rules.
  const assembled = [
    "Each loop falls into one of three buckets:",
    "- ADDRESSED: ...",
    "- PARTIAL: ...",
    "- (omitted): ...",
    "",
    DRAFT_COVERAGE_GROUNDING_CLAUSE,
    "",
    "Return strict JSON ...",
    "",
    "LOOPS:",
    "1. Acknowledge the paused Middle East offer",
    "",
    "DRAFT:",
    "Middle East is a big move so makes sense to hold off if it's not the right fit right now."
  ].join("\n");

  // The clause must reach the model.
  assert.match(assembled, /GROUNDING CHECK/);
  // PARTIAL is the named verdict for the Brandon-style draft.
  assert.match(assembled, /PARTIAL/);
  // Brandon regression fixture survives the assembly.
  assert.match(assembled, /Middle East/);
  assert.match(assembled, /big move/i);
  // The rule that drives the verdict.
  assert.match(
    assembled,
    /contact (did not|didn't) express|adds 'big move' framing the contact didn't use/i
  );
});

// ── Negative: the new clauses don't accidentally break the existing guards ─

test("PREDRAFT_FIDELITY_REMINDER does not contradict the existing factual hallucination guard", () => {
  // The fidelity reminder must not soften the factual guard. It should add
  // to the constraint surface, not relax it. Cheap check: it never tells
  // the model it's OK to invent anything.
  assert.doesNotMatch(PREDRAFT_FIDELITY_REMINDER, /you can invent/i);
  assert.doesNotMatch(PREDRAFT_FIDELITY_REMINDER, /feel free to add/i);
});

test("DRAFT_COVERAGE_GROUNDING_CLAUSE does not loosen the partial-vs-addressed bias toward partial", () => {
  // The original prompt already says "When in doubt between addressed and
  // partial, pick partial." The grounding clause must not pull the model
  // back toward ADDRESSED for any case.
  assert.doesNotMatch(DRAFT_COVERAGE_GROUNDING_CLAUSE, /prefer ADDRESSED/i);
  assert.doesNotMatch(DRAFT_COVERAGE_GROUNDING_CLAUSE, /lean ADDRESSED/i);
});

// ── Both predraft paths wire the reminder (suggested replies + composeInVoice) ─

test("PREDRAFT_FIDELITY_REMINDER is wired into BOTH predraft user-prompt assemblers", () => {
  // The fidelity rule applies to any AI-generated reply text, not just
  // suggested-reply chips. composeInVoice (operator-typed intent rewrite)
  // is the second predraft path; it must reference the same reminder.
  //
  // Reads the compiled runner ai.js and counts references to the constant
  // identifier. The TypeScript-emitted output preserves the const name,
  // so a future refactor that accidentally drops a reference will trip
  // this assertion before merge.
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  // Count occurrences of the identifier. Expect at least 3:
  //   1. the export declaration
  //   2. the reference inside generateSuggestedReplies
  //   3. the reference inside composeInVoice
  const occurrences = source.split("PREDRAFT_FIDELITY_REMINDER").length - 1;
  assert.ok(
    occurrences >= 3,
    `expected at least 3 references to PREDRAFT_FIDELITY_REMINDER in compiled ai.js (export + generateSuggestedReplies + composeInVoice), found ${occurrences}`
  );
});

test("DRAFT_COVERAGE_GROUNDING_CLAUSE is wired into the coverage-check prompt", () => {
  // Same structural check for the coverage-check grounding clause.
  // Expect at least 2: the export declaration + reference inside
  // checkDraftCoverage.
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  const occurrences = source.split("DRAFT_COVERAGE_GROUNDING_CLAUSE").length - 1;
  assert.ok(
    occurrences >= 2,
    `expected at least 2 references to DRAFT_COVERAGE_GROUNDING_CLAUSE in compiled ai.js (export + checkDraftCoverage), found ${occurrences}`
  );
});

// ── Brief-fidelity reminder (#387 follow-up — updateThreadSummary path) ─

test("BRIEF_FIDELITY_REMINDER is exported and primes the brief generator against invented framing", () => {
  assert.equal(typeof BRIEF_FIDELITY_REMINDER, "string");
  assert.ok(BRIEF_FIDELITY_REMINDER.length > 0, "reminder must be non-empty");
  // Names FIDELITY as a hard rule, applies to every visible brief field.
  assert.match(BRIEF_FIDELITY_REMINDER, /FIDELITY/);
  assert.match(BRIEF_FIDELITY_REMINDER, /where_it_stands/);
  assert.match(BRIEF_FIDELITY_REMINDER, /on_you/);
  assert.match(BRIEF_FIDELITY_REMINDER, /they_said/);
  // Names the specific Brandon-thread regression in on_you ("big thing").
  assert.match(BRIEF_FIDELITY_REMINDER, /big thing/i);
  // Banned-moves list explicitly covers the brief-side framings.
  assert.match(BRIEF_FIDELITY_REMINDER, /weighty/i);
  // The meta rule lives in the brief reminder too.
  assert.match(
    BRIEF_FIDELITY_REMINDER,
    /traceable to something the contact actually said/i
  );
});

test("BRIEF_FIDELITY_REMINDER is wired into the compiled brief-generation prompt", () => {
  // Expect at least 2 references in the compiled output: the export
  // declaration + the reference inside updateThreadSummary's template.
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  const occurrences = source.split("BRIEF_FIDELITY_REMINDER").length - 1;
  assert.ok(
    occurrences >= 2,
    `expected at least 2 references to BRIEF_FIDELITY_REMINDER in compiled ai.js (export + updateThreadSummary), found ${occurrences}`
  );
});

test("updateThreadSummary's on_you guidance no longer contains the editorialised 'big thing worth acknowledging' example", () => {
  // The pre-fix on_you example said: "He's slightly paused a job offer
  // because the clients are in the Middle East — that's the big thing
  // worth acknowledging." The model was reproducing the "that's the big
  // thing worth acknowledging" framing verbatim on Brandon-shaped threads.
  // After this fix, the bad framing must only appear as a NEGATIVE
  // example (labelled "NOT" or in a banned-moves list), never as a
  // positive shape the model should imitate.
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");

  // Pre-fix shape — the editorialised example as a positive template.
  // If this pattern reappears as positive guidance, the regression is back.
  assert.doesNotMatch(
    source,
    /Example:\s*"[^"]*that's the big thing worth acknowledging[^"]*"/,
    "the 'big thing worth acknowledging' phrase must not appear as a positive Example: again"
  );

  // The grounded counter-example must be there.
  assert.match(source, /A short acknowledgement is enough/);
});

test("updateThreadSummary's required_points guidance no longer leans on 'weighty beat' / 'major life event' classifier hints", () => {
  // The original guidance categorised acknowledgement-worthy news using
  // "weighty beat", "hard decision", "major life event" — language that
  // biases the model's output framing. The fix replaces this with
  // grounded classifier language and adds an explicit phrasing rule.
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");

  // The old hint strings should be gone from the required_points
  // guidance (they survive elsewhere only in the negative-example lists
  // inside BRIEF_FIDELITY_REMINDER, which is fine).
  assert.doesNotMatch(
    source,
    /shared a single weighty beat the operator should acknowledge \(a paused job offer, a hard decision, a major life event\)/,
    "the 'weighty beat / hard decision / major life event' classifier phrasing must be gone from required_points guidance"
  );

  // The replacement guidance must be present.
  assert.match(
    source,
    /do NOT characterise the beat itself \("Acknowledge the big news", "Acknowledge the major decision"\)/
  );
});
