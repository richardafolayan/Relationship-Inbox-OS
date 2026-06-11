import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  operatorNameResolution,
  BANTER_DISCIPLINE
} from "../apps/runner/dist/services/ai.js";

// Issue #685, the "phone handover" brief. On a 1:1 thread the contact spent
// an evening teasing that someone else must be on the operator's phone
// ("who's on <operator>'s phone bro….", "give the brother his device back.",
// "<operator> come back"). Two compounding failures turned that banter into
// homework:
//
//   1. The contact addresses the operator BY NAME in third person, and the
//      prompt's transcript-label rule (#463) teaches "any name inside a
//      message body is a third party" while SECOND_PERSON_RESOLUTION (#489)
//      only resolves pronouns — so the operator's own name was read as a
//      third party whose device the operator holds. The reassess prompt
//      also never carried the operator's configured name at all.
//   2. Nothing said an obligation must be meant in earnest, so the joke was
//      promoted into where_it_stands ("planning the phone handover"), a
//      required point ("Outline next steps for handing the phone") and
//      what_they_want — and the predraft composed a reply around the
//      invented errand. The Ask feature (strict only-answer-from-record
//      grounding) correctly said "Not on record", contradicting the brief.
//
// Fix: operatorNameResolution(operatorDisplayName) binds the rule and the
// configured name together (contactNameContext-style) and BANTER_DISCIPLINE
// forbids promoting jokes into obligation-bearing fields. These tests pin
// the language and the wiring; they do NOT run an LLM — behavioural
// verification is a live from-scratch Reassess of the affected thread.

// ── operatorNameResolution language ────────────────────────────────────
test("operatorNameResolution resolves the operator's name to second person, not a third party", () => {
  const fragment = operatorNameResolution("Ayo");
  assert.equal(typeof fragment, "string");
  assert.match(fragment, /OPERATOR NAME RESOLUTION/);
  // The vocative/direct-address failure mode must be taught.
  assert.match(fragment, /address/i);
  assert.match(fragment, /third person/i);
  // Resolution target: the operator, as a second-person pronoun.
  assert.match(fragment, /refers to the OPERATOR/);
  assert.match(fragment, /second-person pronoun/);
  // The output-side ban: never surface the operator's name as a third party.
  assert.match(fragment, /NEVER surface in output text/);
  assert.match(fragment, /handover/);
  // It must not weaken the #463 contact-name rule.
  assert.match(fragment, /NEVER the contact's name/i);
  // A genuinely different person sharing the name stays a third party.
  assert.match(fragment, /different person who happens to share the name/);
});

test("operatorNameResolution binds the configured name into the rule (rule and name travel together)", () => {
  const fragment = operatorNameResolution("Ayo");
  assert.match(fragment, /The operator's configured name is "Ayo"/);
  // Escape hatch for a genuinely different person with the same name.
  assert.match(fragment, /unless the transcript clearly establishes a different person/);
});

test("operatorNameResolution without a configured name keeps the generic rule and binds nothing", () => {
  for (const value of [undefined, null, "", "   "]) {
    const fragment = operatorNameResolution(value);
    assert.match(fragment, /OPERATOR NAME RESOLUTION/);
    assert.doesNotMatch(fragment, /configured name is/);
  }
});

test("operatorNameResolution leaks no real or example persona names", () => {
  // De-personalisation gate: the rule text must carry only bracketed
  // placeholders, never a copyable personal name (same check as the #489
  // recency tests). The configured name appears ONLY when passed in.
  const fragment = operatorNameResolution("");
  assert.doesNotMatch(fragment, /Richard|Annalise|Marianne|Seyi/);
  assert.match(fragment, /NEVER output a bracketed placeholder/);
});

// ── BANTER_DISCIPLINE language ─────────────────────────────────────────
test("BANTER_DISCIPLINE is exported and forbids promoting jokes into obligations", () => {
  assert.equal(typeof BANTER_DISCIPLINE, "string");
  assert.match(BANTER_DISCIPLINE, /BANTER IS NOT AN OBLIGATION/);
  // The failure mode: a tease pattern-matching to a task.
  assert.match(BANTER_DISCIPLINE, /who's on your phone/);
  assert.match(BANTER_DISCIPLINE, /NEVER a task, plan, errand, or logistics item/);
  // Every obligation-bearing field must be named as in-earnest-only.
  for (const field of [
    "where_it_stands",
    "what_they_want",
    "on_you",
    "required_points",
    "open_loops",
    "summary",
    "durable_context"
  ]) {
    assert.ok(
      BANTER_DISCIPLINE.includes(field),
      `BANTER_DISCIPLINE must scope the in-earnest rule to ${field}`
    );
  }
  assert.match(BANTER_DISCIPLINE, /IN EARNEST/);
  // The escape valve: banter informs tone, nothing else.
  assert.match(BANTER_DISCIPLINE, /tone_steer/);
  // No persona names.
  assert.doesNotMatch(BANTER_DISCIPLINE, /Richard|Marianne/);
});

// ── wiring into the assembled reassess prompt ──────────────────────────
test("both fragments are template-injected into the reassess prompt with the configured operator name", () => {
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  // Template-injected (the ${...} form), so prose mentions in comments
  // don't count.
  assert.ok(
    source.includes("${operatorNameResolution(operatorDisplayName)}"),
    "operatorNameResolution must be injected into the reassess prompt with the operator's name"
  );
  assert.ok(
    source.includes("${BANTER_DISCIPLINE}"),
    "BANTER_DISCIPLINE must be injected into the reassess prompt"
  );
  // The name must come from the operator profile (settings), so the rule
  // and the configured name travel together at runtime.
  assert.match(source, /operatorDisplayName = await settingsStore[\s\S]{0,200}getOperatorProfile/);
});
