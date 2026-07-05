import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pilot R-0088 (#755): Ask AI answers general questions ("what's a sell
// offer?") from general knowledge, clearly labelled, while personal facts
// stay transcript-grounded. These pin the prompt split and the rail copy.

const aiSource = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/services/ai.ts", import.meta.url)),
  "utf8"
);
const threadPage = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);

test("the ask prompt splits personal facts (grounded) from general questions (allowed)", () => {
  assert.match(aiSource, /FACTS ABOUT THIS PERSON OR CONVERSATION come only from the provided context/);
  assert.match(aiSource, /GENERAL QUESTIONS are welcome \(pilot R-0088\)/);
  // General answers must be labelled as such, never attributed to the contact.
  assert.match(aiSource, /make the source obvious by opening that part with "In general,"/);
  assert.match(aiSource, /NEVER dress general knowledge up as something this contact said or did/);
  // The closing fabrication rule must scope to personal facts, not ban the
  // general path it just opened.
  assert.match(aiSource, /General knowledge is allowed only for general questions, clearly framed as such/);
});

test("the rail copy tells the operator general questions are allowed", () => {
  assert.match(threadPage, /or something general/);
  assert.match(threadPage, /general questions get a general answer, clearly labelled/);
  assert.doesNotMatch(threadPage, /It won't make anything up\./);
});
