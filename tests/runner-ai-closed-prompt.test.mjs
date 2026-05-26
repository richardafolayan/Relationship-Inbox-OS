import test from "node:test";
import assert from "node:assert/strict";
import { CLOSED_STATUS_PROMPT } from "../apps/runner/dist/services/ai.js";

// The full prompt is tested for shape (decision rules + JSON contract)
// here rather than behaviour; behaviour requires a live AI provider and
// is exercised against the operator's running setup, not in CI.

test("CLOSED_STATUS_PROMPT defines the closed and open buckets", () => {
  assert.match(CLOSED_STATUS_PROMPT, /"closed"/);
  assert.match(CLOSED_STATUS_PROMPT, /"open"/);
  // Acknowledgement language must appear in the closed definition so the
  // model has the same anchor the regex heuristic uses.
  assert.match(CLOSED_STATUS_PROMPT, /acknowledgement/i);
  assert.match(CLOSED_STATUS_PROMPT, /farewell/i);
});

test("CLOSED_STATUS_PROMPT keeps the conservative default of OPEN when ambiguous", () => {
  // The decision rules end with an explicit fallback: when in doubt,
  // mark the thread OPEN. This mirrors the dashboard's heuristic which
  // also defaults to leaving threads visible.
  assert.match(CLOSED_STATUS_PROMPT, /When in doubt/i);
  assert.match(CLOSED_STATUS_PROMPT, /OPEN/);
});

test("CLOSED_STATUS_PROMPT pins the JSON output contract", () => {
  // F2 (#287): the verdict now includes a one-line "why" caption the
  // dashboard renders alongside set-aside rows so the call is not a
  // black box. The contract enforces both status and reason.
  assert.match(
    CLOSED_STATUS_PROMPT,
    /Return strict JSON: \{ "status": "closed" \| "open", "reason": "[^"]+" \}/
  );
});

test("CLOSED_STATUS_PROMPT instructs the reason to be evidence-grounded", () => {
  // No invented details, no recommendations, no second-guessing - the
  // reason is for the operator to read at a glance, not a coaching note.
  assert.match(CLOSED_STATUS_PROMPT, /Quote or paraphrase the actual closing beat/i);
  assert.match(CLOSED_STATUS_PROMPT, /no recommendations/i);
});

test("CLOSED_STATUS_PROMPT caps the reason length", () => {
  assert.match(CLOSED_STATUS_PROMPT, /no more than 18 words/i);
});

test("CLOSED_STATUS_PROMPT forbids em dashes in the reason", () => {
  // The dash guard scans rendered UI copy; this reason caption surfaces
  // on the inbox so it must obey the same rule.
  assert.match(CLOSED_STATUS_PROMPT, /No em dashes/);
});

test("CLOSED_STATUS_PROMPT includes worked examples for each bucket", () => {
  // Each example uses a [direction] tag (IN / OUT) so the model sees
  // how attribution flows into the verdict.
  assert.match(CLOSED_STATUS_PROMPT, /CLOSED — IN:/);
  assert.match(CLOSED_STATUS_PROMPT, /OPEN\s+— IN:/);
  assert.match(CLOSED_STATUS_PROMPT, /OPEN\s+— OUT:/);
});

test("CLOSED_STATUS_PROMPT explicitly handles a question mark as OPEN", () => {
  // The dashboard heuristic also short-circuits to OPEN on any "?".
  // Keeping both layers aligned matters because a divergence would hide
  // threads on the dashboard while the AI verdict said the operator
  // still owed a reply.
  assert.match(CLOSED_STATUS_PROMPT, /question mark/i);
});

test("CLOSED_STATUS_PROMPT teaches the model that deleted-message placeholders are non-actionable", () => {
  // The scan-queue layer already strips deletion placeholders from the
  // inbound aggregates, but the classifier prompt also needs guidance
  // for any case where the filter is bypassed (a new placeholder
  // variant the helper has not yet learned). The rule must look at the
  // prior real turn rather than treat the placeholder itself as a
  // fresh ask or as a closing beat.
  assert.match(CLOSED_STATUS_PROMPT, /deleted/i);
  assert.match(CLOSED_STATUS_PROMPT, /unsent|retract/i);
  assert.match(CLOSED_STATUS_PROMPT, /prior real (turn|inbound)/i);
});

test("CLOSED_STATUS_PROMPT shows worked examples for the deleted-placeholder case", () => {
  // Both buckets must illustrate the rule: a deletion placeholder by
  // itself is CLOSED only when the prior real inbound was already
  // settled, and OPEN when the prior real inbound was a live ask.
  assert.match(
    CLOSED_STATUS_PROMPT,
    /CLOSED\s+— IN: "This message has been deleted\."/
  );
  assert.match(
    CLOSED_STATUS_PROMPT,
    /OPEN\s+— IN: "This message has been deleted\."/
  );
});
