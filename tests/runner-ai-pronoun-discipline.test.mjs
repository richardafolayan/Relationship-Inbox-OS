import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRONOUN_DISCIPLINE } from "../apps/runner/dist/services/ai.js";

// Pilot R-0090 (#757). A female contact was summarised as "he". The #416
// pronoun rule sat buried mid-paragraph inside CONTACT_NAME_DISCIPLINE and
// the smaller default models skim past it; PRONOUN_DISCIPLINE is the
// standalone, prominently-placed restatement. These tests pin the language
// and the wiring so it can't silently drop out of the prompts.

const aiSource = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/services/ai.ts", import.meta.url)),
  "utf8"
);

test("PRONOUN_DISCIPLINE states the they/them default and the evidence bar", () => {
  assert.equal(typeof PRONOUN_DISCIPLINE, "string");
  assert.match(PRONOUN_DISCIPLINE, /PRONOUNS \(strict\)/);
  assert.match(PRONOUN_DISCIPLINE, /Default to "they"\/"them"/);
  // he/she requires categorical evidence, and a name never qualifies.
  assert.match(PRONOUN_DISCIPLINE, /categorical evidence/);
  assert.match(PRONOUN_DISCIPLINE, /A NAME IS NEVER EVIDENCE/);
  // The name-over-pronoun fallback must be taught.
  assert.match(PRONOUN_DISCIPLINE, /prefer the contact's name over any pronoun/);
  // Self-check line so the model audits its own output.
  assert.match(PRONOUN_DISCIPLINE, /Self-check before output/);
});

test("every prompt that injects contactNameContext also injects PRONOUN_DISCIPLINE", () => {
  // The three user-facing-prose prompts (thread summary/brief, suggested
  // replies, compose-in-voice) inject contactNameContext; each must carry
  // the standalone pronoun block right next to it.
  const nameInjections = aiSource.match(/\$\{contactNameContext\(input\.displayName\)\}/g) ?? [];
  const pronounInjections = aiSource.match(/\$\{PRONOUN_DISCIPLINE\}/g) ?? [];
  assert.ok(nameInjections.length >= 3, `expected >=3 contactNameContext sites, got ${nameInjections.length}`);
  assert.equal(
    pronounInjections.length,
    nameInjections.length,
    "PRONOUN_DISCIPLINE must be injected wherever contactNameContext is"
  );
  assert.match(
    aiSource,
    /\$\{contactNameContext\(input\.displayName\)\}\n\n\$\{PRONOUN_DISCIPLINE\}/,
    "PRONOUN_DISCIPLINE travels immediately after the recipient context"
  );
});

test("SUMMARY_VERSION was bumped so cached summaries regenerate", () => {
  const scanQueue = readFileSync(
    fileURLToPath(new URL("../apps/runner/src/services/scan-queue.ts", import.meta.url)),
    "utf8"
  );
  // v9-identity summaries predate the pronoun block; anything cached under
  // it must invalidate. If the version ever moves past v10, this test only
  // requires it isn't the pre-pronoun value.
  assert.doesNotMatch(scanQueue, /SUMMARY_VERSION = "v9-identity"/);
  assert.match(scanQueue, /SUMMARY_VERSION = "v1[0-9]-/);
});

// #767: the prompts' own few-shot examples must not model unevidenced
// gendered pronouns (example-poisoning, same mechanism as the Seyi name
// leak). The permitted evidenced-case illustrations live inside
// PRONOUN_DISCIPLINE itself ("as her mum", "my sister Lanre").
test("few-shot example lines carry no unevidenced gendered pronouns", () => {
  const exampleLines = aiSource
    .split("\n")
    .filter((line) => /Examples?[ :(]/.test(line) && /"/.test(line));
  assert.ok(exampleLines.length >= 8, `expected example lines, got ${exampleLines.length}`);
  for (const line of exampleLines) {
    assert.doesNotMatch(
      line,
      /"(He|She)['\s]|,\s(he|she)['\s]|\b(he|she)'(s|d)\s/,
      `gendered example: ${line.trim().slice(0, 120)}`
    );
  }
});
