import test from "node:test";
import assert from "node:assert/strict";

// toast-gesture.ts is framework-free, so the tsx loader resolves this .ts
// import directly (same pattern as dashboard-late-night-send.test.mjs).
const { resolveToastGesture, SWIPE_DISMISS_PX } = await import(
  "../apps/dashboard/lib/toast-gesture.ts"
);

// Regression for the swallowed-click bug: an interactive (href) toast released
// after 7-80px of pointer travel used to fall into a dead zone between the
// 6px click-slop gate and the 80px swipe threshold, so it neither navigated
// nor dismissed. Every release below the dismiss threshold on an interactive
// toast must now activate.

test("interactive release in the old 7-80px dead zone activates", () => {
  for (const travel of [7, 12, 40, 79, 80]) {
    assert.equal(
      resolveToastGesture(travel, true),
      "activate",
      `interactive ${travel}px should activate, not be swallowed`
    );
    // direction must not matter
    assert.equal(resolveToastGesture(-travel, true), "activate");
  }
});

test("interactive near-stationary release still activates", () => {
  assert.equal(resolveToastGesture(0, true), "activate");
  assert.equal(resolveToastGesture(3, true), "activate");
  assert.equal(resolveToastGesture(-6, true), "activate");
});

test("travel beyond the dismiss threshold dismisses (either toast kind)", () => {
  assert.equal(resolveToastGesture(SWIPE_DISMISS_PX + 1, true), "dismiss");
  assert.equal(resolveToastGesture(SWIPE_DISMISS_PX + 1, false), "dismiss");
  assert.equal(resolveToastGesture(-(SWIPE_DISMISS_PX + 1), true), "dismiss");
  assert.equal(resolveToastGesture(200, false), "dismiss");
});

test("non-interactive release below the threshold springs back, never activates", () => {
  for (const travel of [0, 6, 40, 79, 80]) {
    assert.equal(resolveToastGesture(travel, false), "springback");
  }
});

test("exactly the dismiss threshold is NOT a dismiss (strict >)", () => {
  // 80px is the boundary: it must still count as a click/springback, matching
  // the original `Math.abs(travelled) > SWIPE_DISMISS_PX` guard.
  assert.equal(resolveToastGesture(SWIPE_DISMISS_PX, true), "activate");
  assert.equal(resolveToastGesture(SWIPE_DISMISS_PX, false), "springback");
});
