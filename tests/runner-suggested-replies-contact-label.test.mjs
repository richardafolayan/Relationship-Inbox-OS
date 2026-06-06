import test from "node:test";
import assert from "node:assert/strict";
import { renderSuggestedRepliesExchange } from "../apps/runner/dist/services/ai.js";
import { contactTranscriptLabel } from "../apps/runner/dist/services/ai.js";

// Regression for PM7 (re-opens #463/#399 third-party name-leak in the predraft
// path). generateSuggestedReplies injects the #463 TRANSCRIPT LABELS discipline,
// which tells the model the contact's own turns are prefixed with the contact's
// name and are the ONLY authority on who the contact is. The recent-exchange
// transcript must therefore actually bind that name to the contact's turns —
// otherwise the only proper noun in the conversation is a third party mentioned
// in a body (e.g. "Anu"), and the model can address the reply to them.

const lanreThread = [
  { direction: "IN", text: "Hey, just catching up after my chat with Anu yesterday", timestamp: "2026-06-01T09:00:00.000Z" },
  { direction: "OUT", text: "No worries, how did it go?", timestamp: "2026-06-01T09:05:00.000Z" },
  { direction: "IN", text: "Good. Anu thinks we should push the launch", timestamp: "2026-06-01T09:10:00.000Z" }
];

test("renderSuggestedRepliesExchange binds the contact's real name to their turns", () => {
  const label = contactTranscriptLabel("Lanre");
  assert.equal(label, "Lanre", "a plain display name should be used as the transcript label");

  const rendered = renderSuggestedRepliesExchange(lanreThread, label);
  const lines = rendered.split("\n");

  // Contact turns are prefixed with their NAME, not the generic literal.
  // Pre-fix this rendered "contact:" and the assertion fails.
  assert.equal(lines[0].startsWith("Lanre: "), true, `expected contact turn to be prefixed "Lanre: ", got: ${lines[0]}`);
  assert.equal(lines[2].startsWith("Lanre: "), true, `expected contact turn to be prefixed "Lanre: ", got: ${lines[2]}`);
  assert.equal(lines.some((l) => l.startsWith("contact: ")), false, "a named contact must never be labelled with the generic \"contact:\" literal");

  // Operator turns are unchanged.
  assert.equal(lines[1].startsWith("operator: "), true, `expected operator turn to be prefixed "operator: ", got: ${lines[1]}`);

  // The third party mentioned in a body ("Anu") must only ever appear inside a
  // message body, NEVER as a speaker label at the start of a line.
  for (const line of lines) {
    assert.equal(line.startsWith("Anu:"), false, `a body-mentioned third party must not become a speaker label: ${line}`);
  }
});

test("renderSuggestedRepliesExchange keeps the generic label for a nameless handle (output-equivalence)", () => {
  // contactTranscriptLabel collapses placeholder handles to "contact", so the
  // live prompt for these threads is byte-identical to the pre-fix behaviour.
  const phoneLabel = contactTranscriptLabel("+447700900123");
  assert.equal(phoneLabel, "contact");

  const rendered = renderSuggestedRepliesExchange(
    [
      { direction: "IN", text: "hi", timestamp: "2026-06-01T09:00:00.000Z" },
      { direction: "OUT", text: "hey", timestamp: "2026-06-01T09:01:00.000Z" }
    ],
    phoneLabel
  );
  assert.equal(rendered, "contact: hi\noperator: hey");
});

test("renderSuggestedRepliesExchange default label matches the pre-fix literal", () => {
  // The exported helper defaults to "contact" so the extraction itself does not
  // change behaviour when no label is supplied.
  const rendered = renderSuggestedRepliesExchange([
    { direction: "IN", text: "ping", timestamp: "2026-06-01T09:00:00.000Z" }
  ]);
  assert.equal(rendered, "contact: ping");
});
