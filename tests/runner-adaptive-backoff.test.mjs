import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptiveBackoffMultiplier,
  applyAdaptiveBackoffOutcome
} from "../apps/runner/dist/services/scan-queue.js";

// Issue #403 / pilot R-0040. Adaptive backoff for the scheduler's
// per-platform scan cadence. After N consecutive scans that found no
// changes, the effective interval scales by 1x → 2x → 3x → 4x.

test("adaptiveBackoffMultiplier: 1x for the first 3 no-change scans (0,1,2)", () => {
  assert.equal(adaptiveBackoffMultiplier(0), 1);
  assert.equal(adaptiveBackoffMultiplier(1), 1);
  assert.equal(adaptiveBackoffMultiplier(2), 1);
});

test("adaptiveBackoffMultiplier: 2x at 3-4 no-change scans", () => {
  assert.equal(adaptiveBackoffMultiplier(3), 2);
  assert.equal(adaptiveBackoffMultiplier(4), 2);
});

test("adaptiveBackoffMultiplier: 3x at 5-6 no-change scans", () => {
  assert.equal(adaptiveBackoffMultiplier(5), 3);
  assert.equal(adaptiveBackoffMultiplier(6), 3);
});

test("adaptiveBackoffMultiplier: capped at 4x", () => {
  assert.equal(adaptiveBackoffMultiplier(7), 4);
  assert.equal(adaptiveBackoffMultiplier(20), 4);
  assert.equal(adaptiveBackoffMultiplier(9999), 4);
});

test("applyAdaptiveBackoffOutcome: increments counter on no-change scheduled scan", () => {
  const next = applyAdaptiveBackoffOutcome(
    { lastScheduledScanAt: 0, consecutiveNoChange: 0 },
    0,
    { fromScheduler: true, now: 1_000 }
  );
  assert.equal(next.consecutiveNoChange, 1);
  assert.equal(next.lastScheduledScanAt, 1_000);
});

test("applyAdaptiveBackoffOutcome: resets counter when changes are found", () => {
  const next = applyAdaptiveBackoffOutcome(
    { lastScheduledScanAt: 100, consecutiveNoChange: 5 },
    1,
    { fromScheduler: true, now: 2_000 }
  );
  assert.equal(next.consecutiveNoChange, 0);
  assert.equal(next.lastScheduledScanAt, 2_000);
});

test("applyAdaptiveBackoffOutcome: manual (non-scheduler) scan increments counter on no change but does NOT bump lastScheduledScanAt", () => {
  const next = applyAdaptiveBackoffOutcome(
    { lastScheduledScanAt: 100, consecutiveNoChange: 3 },
    0,
    { fromScheduler: false, now: 2_000 }
  );
  assert.equal(next.consecutiveNoChange, 4);
  // lastScheduledScanAt stays at the original — the scheduler clock
  // shouldn't tick from a manual scan, so the next scheduled scan
  // still fires when the adaptive interval has passed since the
  // last *scheduled* scan, not the manual one.
  assert.equal(next.lastScheduledScanAt, 100);
});

test("applyAdaptiveBackoffOutcome: handles undefined prior state", () => {
  const next = applyAdaptiveBackoffOutcome(undefined, 0, { fromScheduler: true, now: 50 });
  assert.equal(next.consecutiveNoChange, 1);
  assert.equal(next.lastScheduledScanAt, 50);
});

test("applyAdaptiveBackoffOutcome: a manual scan that finds changes resets the counter", () => {
  // Operator manually scans because they just sent a message; the
  // scan finds the new bubble → consecutiveNoChange resets so the
  // next scheduled scan goes back to base cadence.
  const next = applyAdaptiveBackoffOutcome(
    { lastScheduledScanAt: 500, consecutiveNoChange: 7 },
    1,
    { fromScheduler: false, now: 1_000 }
  );
  assert.equal(next.consecutiveNoChange, 0);
  assert.equal(next.lastScheduledScanAt, 500);
});
