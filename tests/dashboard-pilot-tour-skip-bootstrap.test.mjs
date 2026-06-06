import test from "node:test";
import assert from "node:assert/strict";

// pilot-tour.ts is framework-free, so the tsx loader resolves this .ts
// import directly — see test:all in the root package.json.
const { planPilotSkip, shouldTearDownDeferredSkip } = await import(
  "../apps/dashboard/lib/pilot-tour.ts"
);

// Regression for M22: skipping the pilot tour while the sandbox is still
// bootstrapping must NOT silently abandon the half-seeded sandbox. The
// in-flight startPilotSandbox() resolves afterwards and commits
// flow="pilot"/sandboxActive=true, so closing the card alone leaves the real
// inbox hidden with no recovery (recoveryNeeded is gated on flow===null).
// The skip must defer teardown until the bootstrap resolves, then tear down.

test("skip while bootstrapping defers teardown rather than ending immediately", () => {
  const plan = planPilotSkip(true);
  assert.equal(plan.kind, "defer-teardown");
});

test("skip when not bootstrapping ends the tour immediately", () => {
  const plan = planPilotSkip(false);
  assert.equal(plan.kind, "end-tour");
});

test("a deferred skip tears the sandbox down once the bootstrap resolves", () => {
  // The skip handler set the pending flag while bootstrapping.
  const skipRequestedDuringBootstrap = planPilotSkip(true).kind === "defer-teardown";
  assert.equal(skipRequestedDuringBootstrap, true);
  // The bootstrap-resolve path must then tear down (restore the real inbox).
  assert.equal(shouldTearDownDeferredSkip(skipRequestedDuringBootstrap), true);
});

test("a clean bootstrap with no skip does not tear the sandbox down", () => {
  // No skip was requested, so the resolve path keeps the tour running.
  assert.equal(shouldTearDownDeferredSkip(false), false);
});

test("the two skip kinds are exhaustive and distinct", () => {
  const kinds = new Set([planPilotSkip(true).kind, planPilotSkip(false).kind]);
  assert.deepEqual([...kinds].sort(), ["defer-teardown", "end-tour"]);
});
