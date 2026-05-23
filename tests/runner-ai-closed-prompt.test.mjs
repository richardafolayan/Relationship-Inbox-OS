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
  assert.match(
    CLOSED_STATUS_PROMPT,
    /Return strict JSON: \{ "status": "closed" \| "open" \}/
  );
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
