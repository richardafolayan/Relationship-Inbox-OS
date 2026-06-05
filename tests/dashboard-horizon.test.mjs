import test from "node:test";
import assert from "node:assert/strict";

// horizon.ts is framework-free, so the tsx loader resolves this .ts import
// directly, the same way dashboard-pilot-feedback.test.mjs imports pilot.ts.
const { isWithinHorizon, INBOX_HORIZON_DAYS } = await import("../apps/dashboard/lib/horizon.ts");

const NOW = Date.parse("2026-05-22T12:00:00.000Z");
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

test("INBOX_HORIZON_DAYS is the agreed 30-day default", () => {
  assert.equal(INBOX_HORIZON_DAYS, 30);
});

test("recent activity is within the horizon", () => {
  assert.equal(isWithinHorizon(daysAgo(0), NOW), true);
  assert.equal(isWithinHorizon(daysAgo(7), NOW), true);
  assert.equal(isWithinHorizon(daysAgo(29), NOW), true);
});

test("the boundary is inclusive at exactly the cutoff", () => {
  assert.equal(isWithinHorizon(daysAgo(30), NOW), true);
});

test("activity older than the horizon falls outside it", () => {
  assert.equal(isWithinHorizon(daysAgo(31), NOW), false);
  assert.equal(isWithinHorizon(daysAgo(367), NOW), false);
});

test("a missing or unparseable timestamp counts as within the horizon", () => {
  assert.equal(isWithinHorizon(null, NOW), true);
  assert.equal(isWithinHorizon(undefined, NOW), true);
  assert.equal(isWithinHorizon("", NOW), true);
  assert.equal(isWithinHorizon("not a date", NOW), true);
});

test("a custom horizon length is honoured", () => {
  assert.equal(isWithinHorizon(daysAgo(45), NOW, 60), true);
  assert.equal(isWithinHorizon(daysAgo(45), NOW, 30), false);
});
