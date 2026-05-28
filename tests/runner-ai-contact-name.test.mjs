import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTACT_NAME_DISCIPLINE } from "../apps/runner/dist/services/ai.js";

// Issues #396 / #399. Pilot saw the AI write "the contact" generically
// instead of the person's actual name, and saw it pick a name out of
// transcript content (an operator's outbound message contained the word
// "Mayowa") and use it as the contact's name in a thread whose
// displayName was "Ayo Johnson".
//
// The fix is a new CONTACT_NAME_DISCIPLINE prompt fragment, mirrored
// from PREDRAFT_FIDELITY_REMINDER / BRIEF_FIDELITY_REMINDER. Tests pin
// the language into place and confirm wiring across the three prompts
// that produce contact-referencing text.

test("CONTACT_NAME_DISCIPLINE is exported and names the displayName authority rule", () => {
  assert.equal(typeof CONTACT_NAME_DISCIPLINE, "string");
  assert.ok(CONTACT_NAME_DISCIPLINE.length > 0);
  // Must teach displayName authority.
  assert.match(CONTACT_NAME_DISCIPLINE, /CONTACT NAME/);
  assert.match(CONTACT_NAME_DISCIPLINE, /displayName/);
  // Must explicitly ban "the contact" generic phrasing (#396).
  assert.match(CONTACT_NAME_DISCIPLINE, /the contact/);
  assert.match(CONTACT_NAME_DISCIPLINE, /the recipient/);
  // Must explicitly call out the Mayowa-style transcript-leak case (#399).
  assert.match(CONTACT_NAME_DISCIPLINE, /Mayowa/);
  assert.match(CONTACT_NAME_DISCIPLINE, /Ayo/);
  assert.match(CONTACT_NAME_DISCIPLINE, /not the contact's name/i);
  // Fallback path for blank/placeholder displayNames.
  assert.match(CONTACT_NAME_DISCIPLINE, /they\/them/);
});

test("CONTACT_NAME_DISCIPLINE is wired into all three contact-referencing prompts", () => {
  // updateThreadSummary (brief), generateSuggestedReplies (chips),
  // composeInVoice (operator-typed rewrite) — all three feed user-facing
  // text that might reference the contact. The constant must appear in
  // each one's assembled prompt.
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  const occurrences = source.split("CONTACT_NAME_DISCIPLINE").length - 1;
  // Expect at least 4: the export declaration + one reference in each
  // of the three prompts (updateThreadSummary, generateSuggestedReplies,
  // composeInVoice).
  assert.ok(
    occurrences >= 4,
    `expected at least 4 references to CONTACT_NAME_DISCIPLINE in compiled ai.js (export + 3 prompts), found ${occurrences}`
  );
});

test("CONTACT_NAME_DISCIPLINE explicitly bans operator/contact confusion (#400)", () => {
  // Pilot R-0039: AI wrote the OPERATOR's name (Richard) when it
  // should have written the CONTACT's name (Seyi). The operator's
  // name leaks via the operator profile block and/or via the contact
  // addressing the operator by name in inbound messages ("Hi Richard").
  // The constant must explicitly name this failure mode so the model
  // doesn't repeat it.
  assert.match(CONTACT_NAME_DISCIPLINE, /OPERATOR's own name as the contact's name/);
  // The Seyi/Richard worked example must be present as the canonical
  // regression fixture (parallels the Mayowa/Ayo example for #399).
  assert.match(CONTACT_NAME_DISCIPLINE, /Seyi/);
  assert.match(CONTACT_NAME_DISCIPLINE, /Richard/);
  // Must teach the model to re-read the displayName when uncertain.
  assert.match(CONTACT_NAME_DISCIPLINE, /re-read the recipient\/displayName/i);
});

test("CONTACT_NAME_DISCIPLINE allows natural name shortening (Ayo Johnson → Ayo)", () => {
  // The rule must explicitly allow shortening — operators say "Ayo" not
  // "Ayo Johnson" in casual replies. The example in the constant pins
  // that affordance so the model doesn't mechanically write the full
  // name every time.
  assert.match(CONTACT_NAME_DISCIPLINE, /Ayo Johnson/);
  assert.match(
    CONTACT_NAME_DISCIPLINE,
    /natural shortening/i
  );
});
