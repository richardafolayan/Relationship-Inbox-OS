import test from "node:test";
import assert from "node:assert/strict";
import { exponentialDelayMs } from "../apps/runner/dist/services/enrichment-queue.js";

const HOUR = 60 * 60 * 1000;

// exponentialDelayMs is contracted to take the attempt count BEFORE the
// failed run. The failure path passes `job.attempts` (pre-increment), so:
//   1st failure -> job.attempts=0 -> 1h
//   2nd failure -> job.attempts=1 -> 6h
//   3rd failure -> give up (never schedules; included here for the tier map)
test("exponentialDelayMs maps the pre-increment attempt count to 1h/6h/24h tiers", () => {
  assert.equal(exponentialDelayMs(0), 1 * HOUR, "first failure must use the 1h tier");
  assert.equal(exponentialDelayMs(1), 6 * HOUR, "second failure must use the 6h tier");
  assert.equal(exponentialDelayMs(2), 24 * HOUR, "third+ failure must use the 24h tier");
  assert.equal(exponentialDelayMs(5), 24 * HOUR, "the 24h tier is the ceiling");
});

test("exponentialDelayMs is defensive for negative inputs", () => {
  assert.equal(exponentialDelayMs(-1), 1 * HOUR);
});

// Regression guard for the off-by-one: the documented 1h first-retry tier
// must be reachable for the first failure. The bug passed the POST-increment
// count (job.attempts + 1 === 1) which wrongly returns 6h and made the 1h
// tier dead code.
test("first retry uses 1h, not the 6h post-increment value (off-by-one regression)", () => {
  const firstFailureAttemptsBefore = 0; // job.attempts on the first failed run
  assert.equal(
    exponentialDelayMs(firstFailureAttemptsBefore),
    1 * HOUR,
    "first retry must wait 1h"
  );
  // Negative control: the previous (buggy) post-increment input would skip 1h.
  const buggyPostIncrementInput = firstFailureAttemptsBefore + 1;
  assert.equal(
    exponentialDelayMs(buggyPostIncrementInput),
    6 * HOUR,
    "sanity: the post-increment value is the 6h tier the bug used"
  );
});
