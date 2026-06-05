import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMessageForPrompt,
  contactTranscriptLabel,
  CONTACT_NAME_DISCIPLINE,
  BRIEF_FIDELITY_REMINDER
} from "../apps/runner/dist/services/ai.js";

// Issues #463 / #464 (pilot R-0062 / R-0063). On a long iMessage thread
// with "Lanre", the summary called the contact "Anu" (a third party who
// recurs in the messages) and fabricated "single-word messages saying
// Chess". Root cause: the transcript labelled every inbound turn as the
// generic `contact:`, so a name in the content out-competed the
// authoritative displayName. The structural fix binds the contact's real
// name to their own transcript turns, plus two reinforcing prompt rules.

test("contactTranscriptLabel returns a real single-person name verbatim", () => {
  assert.equal(contactTranscriptLabel("Lanre"), "Lanre");
  assert.equal(contactTranscriptLabel("Ayo Johnson"), "Ayo Johnson");
  assert.equal(contactTranscriptLabel("  Lanre  "), "Lanre"); // trims
});

test("contactTranscriptLabel falls back to 'contact' for placeholder / non-name handles", () => {
  assert.equal(contactTranscriptLabel(""), "contact");
  assert.equal(contactTranscriptLabel("   "), "contact");
  assert.equal(contactTranscriptLabel(null), "contact");
  assert.equal(contactTranscriptLabel(undefined), "contact");
  // Email-shaped handle.
  assert.equal(contactTranscriptLabel("lanre@example.com"), "contact");
  // Phone-number-shaped handle.
  assert.equal(contactTranscriptLabel("+447939340342"), "contact");
  assert.equal(contactTranscriptLabel("(415) 555-0134"), "contact");
});

test("contactTranscriptLabel falls back to 'contact' for group / participant lists", () => {
  // A comma-joined participant list can't be attributed to one name.
  assert.equal(contactTranscriptLabel("Israel Anuwe, Tim, Ayo Johnson"), "contact");
});

test("formatMessageForPrompt binds the contact's name to their inbound turns", () => {
  const line = formatMessageForPrompt(
    {
      direction: "IN",
      text: "yeah Anu mentioned the chess club",
      timestamp: "2026-05-30T13:00:00.000Z",
      audioTranscription: null
    },
    "Lanre"
  );
  // The contact's own line is now prefixed with HER name, even though the
  // body mentions a third party ("Anu") — the label wins.
  assert.equal(line, "Lanre (2026-05-30T13:00:00.000Z): yeah Anu mentioned the chess club");
});

test("formatMessageForPrompt keeps operator turns labelled 'operator' regardless of contact label", () => {
  const line = formatMessageForPrompt(
    {
      direction: "OUT",
      text: "haha nice",
      timestamp: "2026-05-30T13:01:00.000Z",
      audioTranscription: null
    },
    "Lanre"
  );
  assert.equal(line, "operator (2026-05-30T13:01:00.000Z): haha nice");
});

test("formatMessageForPrompt is backwards-compatible: no label keeps the generic 'contact:' prefix", () => {
  const line = formatMessageForPrompt({
    direction: "IN",
    text: "Lunch on Friday?",
    timestamp: "2026-05-26T14:03:00.000Z",
    audioTranscription: null
  });
  assert.equal(line, "contact (2026-05-26T14:03:00.000Z): Lunch on Friday?");
});

test("CONTACT_NAME_DISCIPLINE teaches the transcript-label authority and the third-party rule (#463)", () => {
  assert.match(CONTACT_NAME_DISCIPLINE, /TRANSCRIPT LABELS/);
  // The contact's own lines are prefixed with their name.
  assert.match(CONTACT_NAME_DISCIPLINE, /prefixed with their name/i);
  // A name inside a body is a third party, not the contact — and the
  // grounded Lanre/Anu worked example must be present as the regression
  // fixture (a third-party name IS allowed in content; it just isn't the
  // contact's name).
  assert.match(CONTACT_NAME_DISCIPLINE, /third party/i);
  assert.match(CONTACT_NAME_DISCIPLINE, /Lanre/);
  assert.match(CONTACT_NAME_DISCIPLINE, /Anu/);
  assert.match(CONTACT_NAME_DISCIPLINE, /still Lanre/);
});

test("BRIEF_FIDELITY_REMINDER forbids fabricated message cadence/format/timing (#464)", () => {
  assert.match(BRIEF_FIDELITY_REMINDER, /NO INVENTED CADENCE/);
  // The exact failure phrasings the pilot saw must be named.
  assert.match(BRIEF_FIDELITY_REMINDER, /single-word/i);
  assert.match(BRIEF_FIDELITY_REMINDER, /for the last few minutes/i);
  // A recurring word is not evidence of one-word/repetitive messages.
  assert.match(BRIEF_FIDELITY_REMINDER, /recurs|recurring/i);
  // It must explicitly cover the summary field, not just the brief.
  assert.match(BRIEF_FIDELITY_REMINDER, /summary/i);
});
