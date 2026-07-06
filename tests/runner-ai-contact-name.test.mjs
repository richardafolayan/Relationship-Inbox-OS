import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTACT_NAME_DISCIPLINE, contactNameContext } from "../apps/runner/dist/services/ai.js";

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

test("contactNameContext binds the naming rule to the actual recipient name", () => {
  // The "Seyi" mislabel: the prompts injected CONTACT_NAME_DISCIPLINE
  // (which says "the contact's name is the value passed as Recipient:
  // <name>" and carries a worked example using "Seyi") but never passed a
  // Recipient line — so the model named the contact "Seyi". contactNameContext
  // makes the rule and the name inseparable: the returned fragment carries
  // BOTH the discipline text AND the real Recipient header.
  const ctx = contactNameContext("The Jess");
  assert.equal(typeof ctx, "string");
  // The rule travels with the fragment...
  assert.match(ctx, /CONTACT NAME/);
  assert.ok(ctx.includes(CONTACT_NAME_DISCIPLINE));
  // ...and so does the authoritative name the rule points at.
  assert.match(ctx, /Recipient: The Jess/);
});

test("contactNameContext: a real displayName is passed through as the recipient", () => {
  const ctx = contactNameContext("Jess");
  assert.match(ctx, /Recipient: Jess/);
  // A real name must NOT trigger the unknown-recipient fallback.
  assert.doesNotMatch(ctx, /unknown contact or group chat/);
});

test("contactNameContext: placeholder displayNames (phone/email/number-group) get an explicit unknown-recipient instruction, never the raw handle as a name", () => {
  // The residual "Seyi" leak: a group chat whose displayName is two phone
  // numbers. A raw "Recipient: +447…" left the naming vacuum that made the
  // model copy the example name. These must route to the unknown-recipient
  // instruction instead — and must NOT present the raw handle as the name.
  const cases = [
    "+447700900001, +447700900002", // number-only group chat
    "+447700900003", // bare phone
    "someone@example.com", // bare email
    "", // blank
    "   " // whitespace-only
  ];
  for (const dn of cases) {
    const ctx = contactNameContext(dn);
    assert.match(ctx, /unknown contact or group chat/, `expected unknown-recipient instruction for ${JSON.stringify(dn)}`);
    assert.match(ctx, /they.*them|the group/i);
    // The rule still travels with it.
    assert.match(ctx, /CONTACT NAME/);
    // The raw phone number must never be offered as the recipient's name.
    assert.doesNotMatch(ctx, /Recipient: \+44/);
  }
});

test("contactNameContext: a group chat carrying real names is NOT treated as nameless", () => {
  // Over-triggering guard: a group whose displayName lists real names should
  // keep passing those names through, not collapse to "the group".
  const ctx = contactNameContext("Israel Anuwe, Teni, Keisha");
  assert.match(ctx, /Recipient: Israel Anuwe, Teni, Keisha/);
  assert.doesNotMatch(ctx, /unknown contact or group chat/);
});

test("contactNameContext is wired into all three contact-referencing prompts", () => {
  // updateThreadSummary (brief), generateSuggestedReplies (chips),
  // composeInVoice (operator-typed rewrite) — all three feed user-facing
  // text that might reference the contact, so all three must inject the
  // rule+name fragment, NOT CONTACT_NAME_DISCIPLINE on its own (which was
  // the bug: rule without name → contact mislabelled "Seyi").
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  const wired = source.split("contactNameContext(input.displayName)").length - 1;
  assert.ok(
    wired >= 3,
    `expected contactNameContext(input.displayName) in all 3 contact-referencing prompts, found ${wired}`
  );
  // Guard the regression directly: the discipline block must never be
  // template-injected into a prompt bare again. The `${CONTACT_NAME_DISCIPLINE}`
  // injection form must appear EXACTLY once — inside contactNameContext,
  // bound to the Recipient line. A prompt that interpolated it directly
  // (the original bug) would push this above one and strand the rule from
  // its name. (Counts the `${…}` form specifically so prose mentions of
  // the constant in comments don't inflate the count.)
  const bareInjections = source.split("${CONTACT_NAME_DISCIPLINE}").length - 1;
  assert.equal(
    bareInjections,
    1,
    `\${CONTACT_NAME_DISCIPLINE} must be injected only inside contactNameContext (exactly 1), found ${bareInjections} — a prompt is injecting the naming rule without the Recipient name`
  );
});

test("CONTACT_NAME_DISCIPLINE bans guessing gendered pronouns (#416)", () => {
  // Pilot R-0045: AI guessed "he" for Praise (a girl). Names cross
  // cultures — gendered guesses misfire. The rule must require
  // name-or-neutral when pronoun is uncertain.
  assert.match(CONTACT_NAME_DISCIPLINE, /GENDER \/ PRONOUNS/);
  // Specific ban on guessing.
  assert.match(CONTACT_NAME_DISCIPLINE, /NEVER guess/);
  // Acceptable fallback path: name or they/them.
  assert.match(CONTACT_NAME_DISCIPLINE, /name.*they\/them|they\/them/i);
  // Worked example using "Praise" — pilot's regression case.
  assert.match(CONTACT_NAME_DISCIPLINE, /Praise/);
});

test("CONTACT_NAME_DISCIPLINE bans operator/contact confusion WITHOUT a copyable example name (#400)", () => {
  // Pilot R-0039: AI wrote the operator's name when it should have written
  // the contact's. The rule must still ban that failure mode...
  assert.match(CONTACT_NAME_DISCIPLINE, /OPERATOR's own name as the contact's name/);
  assert.match(CONTACT_NAME_DISCIPLINE, /reference the RECIPIENT's name, never the operator's/);
  // Must teach the model to re-read the displayName when uncertain.
  assert.match(CONTACT_NAME_DISCIPLINE, /re-read the recipient\/displayName/i);
  // ...but the worked example must NOT use concrete, copyable names. The
  // original example ("displayName is Seyi, operator is Richard") backfired:
  // on a nameless thread with no real Recipient name, the model copied the
  // example name "Seyi" straight into the summary. The bullet now uses
  // symbolic <operator's name> placeholders, so there is no adoptable real
  // name anywhere in the rule. Pin that the leaked names are gone. ("Richard"
  // also doubles as a de-personalisation guard — no operator persona in prompts.)
  assert.doesNotMatch(CONTACT_NAME_DISCIPLINE, /Seyi/);
  assert.doesNotMatch(CONTACT_NAME_DISCIPLINE, /Richard/);
  // The placeholder convention is explicitly flagged as non-output.
  assert.match(CONTACT_NAME_DISCIPLINE, /NEVER output a bracketed placeholder/);
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
