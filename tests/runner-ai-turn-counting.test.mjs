import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Issue #380 / pilot R-0028. The summary prompt's mode switch used to
// be locked on a binary `needsReply` flag: if the operator's last
// message was newer than the contact's, the prompt jumped to RECONNECT
// framing — even when the operator's reply only covered one of several
// distinct contact points. Result: brief reads "restart the convo"
// when there's still real reply debt.
//
// The fix moves mode decision out of the deterministic flag and into
// the model, gated on substance: RECONNECT only when every distinct
// beat has a substantive reply AND the thread is genuinely dormant.
//
// These tests pin the structural shape of the new prompt so the
// binary-flag pattern can't silently regress.

const AI_JS = fileURLToPath(new URL("../apps/runner/dist/services/ai.js", import.meta.url));

test("updateThreadSummary modeBlock is no longer a binary needsReply ternary", () => {
  // The pre-fix shape: `input.needsReply ? "MODE: ACTIVE REPLY..." : "MODE: RECONNECT..."`.
  // After the fix, modeBlock is a single combined string with both
  // modes' guidance — the binary ternary on input.needsReply is gone.
  const source = readFileSync(AI_JS, "utf8");
  // The old pattern would emit two distinct prompt blocks separated by
  // a ternary. The new block presents both modes side-by-side and asks
  // the model to choose. We check for the new "MODE DECISION (made by
  // you, the model" sentinel which only the new prompt has.
  assert.match(source, /MODE DECISION \(made by you, the model/);
});

test("updateThreadSummary modeBlock carries the partial-cover rule for the #380 regression", () => {
  // PARTIAL-COVER RULE is the heart of the fix — name it so a future
  // edit that drops it trips this assertion.
  const source = readFileSync(AI_JS, "utf8");
  assert.match(source, /PARTIAL-COVER RULE/);
  // The rule must explicitly name the regression case: the operator's
  // reply covering some of the contact's points doesn't mark the rest
  // handled.
  assert.match(
    source,
    /Contact sent four topics, operator covered one/i
  );
  // The rule must reject vague acknowledgements as multi-point cover.
  assert.match(source, /vague "thanks" or "fairs"/);
});

test("updateThreadSummary modeBlock presents timestamp as context, not verdict", () => {
  // The timestamp signal must be explicitly called out as "context
  // only, NOT a verdict" so the model can't fall back to "operator
  // replied → reconnect" the way the old binary did.
  const source = readFileSync(AI_JS, "utf8");
  assert.match(source, /TIMESTAMP SIGNAL \(context only, NOT a verdict\)/);
  assert.match(source, /this is a context signal only/);
  assert.match(source, /does NOT prove the operator addressed everything/);
});

test("updateThreadSummary modeBlock gates RECONNECT behind explicit criteria", () => {
  // RECONNECT must require ALL of (everything covered, thread dormant,
  // operator hasn't moved conversation forward). The three-criteria
  // gate is the load-bearing constraint.
  const source = readFileSync(AI_JS, "utf8");
  assert.match(source, /RECONNECT \(use ONLY when ALL of these hold\)/);
  // Three numbered criteria
  assert.match(source, /1\. Every distinct beat from the contact's recent inbound has a substantive reply/);
  assert.match(source, /2\. The last meaningful exchange is old enough to read as genuinely dormant/);
  assert.match(source, /3\. The operator hasn't already moved the conversation forward/);
});

test("updateThreadSummary modeBlock keeps both ACTIVE and RECONNECT guidance available", () => {
  // Both modes' guidance must still be reachable in a single prompt
  // (since the model picks). If the next maintainer accidentally drops
  // one set, the model loses the ability to switch frames.
  const source = readFileSync(AI_JS, "utf8");
  assert.match(source, /what_they_want guidance \(ACTIVE REPLY\)/);
  assert.match(source, /open_loops guidance \(ACTIVE REPLY\)/);
  assert.match(source, /what_they_want guidance \(RECONNECT/);
  assert.match(source, /open_loops guidance \(RECONNECT\)/);
});

test("updateThreadSummary modeBlock names ACTIVE REPLY as the default", () => {
  // The bias must be toward ACTIVE REPLY — RECONNECT is the special
  // case, not the default. This is the inverse of the old logic where
  // RECONNECT triggered automatically on operator-newer timestamps.
  const source = readFileSync(AI_JS, "utf8");
  assert.match(
    source,
    /ACTIVE REPLY \(the default for any thread where the contact has unaddressed substance\)/
  );
});
