import test from "node:test";
import assert from "node:assert/strict";
import { createJobAbortGate } from "../apps/runner/dist/services/scan-queue.js";

// Regression for PM13: runJob captured its abort baseline
// (`const jobAbortVersion = abortVersion`) AFTER two startup awaits
// (ensurePlatformRows(), getSettings()). requestAbort() does
// `abortVersion += 1`, so a Cancel fired while the job was parked in those
// awaits bumped the version before the baseline was read -> shouldAbort()
// was permanently false and the scan ran to completion. createJobAbortGate
// captures the baseline eagerly at construction; runJob now builds it before
// the awaits, so a racing abort is detected.

test("createJobAbortGate: an abort fired after construction is detected", () => {
  let abortVersion = 0;
  const gate = createJobAbortGate(() => abortVersion);

  assert.equal(gate.shouldAbort(), false, "no abort yet -> false");

  abortVersion += 1; // requestAbort()
  assert.equal(gate.shouldAbort(), true, "version bumped after capture -> abort");
});

test("createJobAbortGate: a version already non-zero at construction is the baseline", () => {
  let abortVersion = 7; // a prior job already advanced the counter
  const gate = createJobAbortGate(() => abortVersion);

  // The pre-existing value is the baseline, NOT an abort for this job.
  assert.equal(gate.shouldAbort(), false, "baseline captured -> no false abort");

  abortVersion += 1; // a NEW requestAbort for this job
  assert.equal(gate.shouldAbort(), true, "subsequent bump -> abort");
});

test("createJobAbortGate: abort that races the startup-await window is honoured", async () => {
  // Models runJob's real ordering: build the gate FIRST, then run the startup
  // awaits, during which the operator hits Cancel. With the eager capture the
  // post-await shouldAbort() must be true. A regression that moved the capture
  // back below the awaits would observe baseline === abortVersion -> false.
  let abortVersion = 0;
  const requestAbort = () => {
    abortVersion += 1;
  };

  const runJobLike = async () => {
    const gate = createJobAbortGate(() => abortVersion); // first statement
    // Simulated startup awaits (ensurePlatformRows / getSettings):
    await Promise.resolve();
    await Promise.resolve();
    return gate.shouldAbort();
  };

  const pending = runJobLike();
  requestAbort(); // Cancel pressed while the job is in its startup awaits
  const aborted = await pending;

  assert.equal(aborted, true, "Cancel during startup awaits must be observed");
});

test("createJobAbortGate: each call reads the live version (not a snapshot)", () => {
  let abortVersion = 0;
  const gate = createJobAbortGate(() => abortVersion);

  assert.equal(gate.shouldAbort(), false);
  abortVersion = 3; // jump several versions (e.g. multiple resets)
  assert.equal(gate.shouldAbort(), true);
});
