import test from "node:test";
import assert from "node:assert/strict";

// pilot-tour.ts is framework-free, so the tsx loader resolves this .ts
// import directly — see test:all in the root package.json.
const { shouldStartPilotTour } = await import("../apps/dashboard/lib/pilot-tour.ts");

// Regression for Q4: a second `pilot-tour-start` fired mid-tour (e.g. the
// Settings replay button, or a re-dispatched welcome card) must NOT restart
// the tour. Re-entering startTour would reset the operator to step 0 and
// re-seed the sandbox via startPilotSandbox(). The guard only starts when no
// tour is already active.

test("a re-entrant start while a tour is active is ignored", () => {
  // state.active === true: the operator is partway through the tour.
  assert.equal(shouldStartPilotTour(true), false);
});

test("a first start while idle proceeds", () => {
  // state.active === false: no tour running, so the start should fire.
  assert.equal(shouldStartPilotTour(false), true);
});

test("mid-tour replay does not reset to step 0", () => {
  // Repro shape: operator is on step 4 (active), then presses the Settings
  // replay button which dispatches a second pilot-tour-start. The guard must
  // short-circuit startTour before it can setState({ stepIndex: 0, ... }).
  const tourIsActive = true;
  assert.equal(
    shouldStartPilotTour(tourIsActive),
    false,
    "second start mid-tour must be a no-op so the operator stays on their step"
  );
});

test("the start decision is a pure boolean inverse of active", () => {
  for (const active of [true, false]) {
    assert.equal(shouldStartPilotTour(active), !active);
  }
});
