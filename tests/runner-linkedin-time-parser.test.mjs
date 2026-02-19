import test from "node:test";
import assert from "node:assert/strict";
import { parseLinkedInListTimestamp } from "../apps/runner/dist/linkedin/linkedinTime.js";

test("LinkedIn list timestamp parser handles clock times", () => {
  const now = new Date(2026, 1, 19, 10, 0, 0, 0);

  const morning = parseLinkedInListTimestamp("6:54 AM", now);
  assert.ok(morning);
  assert.equal(morning.getFullYear(), 2026);
  assert.equal(morning.getMonth(), 1);
  assert.equal(morning.getDate(), 19);
  assert.equal(morning.getHours(), 6);
  assert.equal(morning.getMinutes(), 54);

  const lateNight = parseLinkedInListTimestamp("11:09 PM", now);
  assert.ok(lateNight);
  assert.equal(lateNight.getFullYear(), 2026);
  assert.equal(lateNight.getMonth(), 1);
  assert.equal(lateNight.getDate(), 18);
  assert.equal(lateNight.getHours(), 23);
  assert.equal(lateNight.getMinutes(), 9);
});

test("LinkedIn list timestamp parser handles month-day values", () => {
  const now = new Date(2026, 1, 19, 10, 0, 0, 0);

  const feb18 = parseLinkedInListTimestamp("Feb 18", now);
  assert.ok(feb18);
  assert.equal(feb18.getFullYear(), 2026);
  assert.equal(feb18.getMonth(), 1);
  assert.equal(feb18.getDate(), 18);

  const jan13 = parseLinkedInListTimestamp("Jan 13", now);
  assert.ok(jan13);
  assert.equal(jan13.getFullYear(), 2026);
  assert.equal(jan13.getMonth(), 0);
  assert.equal(jan13.getDate(), 13);
});

test("LinkedIn list timestamp parser handles explicit year and yesterday", () => {
  const now = new Date(2026, 1, 19, 10, 0, 0, 0);

  const explicitYear = parseLinkedInListTimestamp("Dec 28, 2025", now);
  assert.ok(explicitYear);
  assert.equal(explicitYear.getFullYear(), 2025);
  assert.equal(explicitYear.getMonth(), 11);
  assert.equal(explicitYear.getDate(), 28);

  const yesterday = parseLinkedInListTimestamp("Yesterday", now);
  assert.ok(yesterday);
  assert.equal(yesterday.getFullYear(), 2026);
  assert.equal(yesterday.getMonth(), 1);
  assert.equal(yesterday.getDate(), 18);
});

test("LinkedIn list timestamp parser returns null for empty/unknown values", () => {
  const now = new Date(2026, 1, 19, 10, 0, 0, 0);
  assert.equal(parseLinkedInListTimestamp("", now), null);
  assert.equal(parseLinkedInListTimestamp("-", now), null);
  assert.equal(parseLinkedInListTimestamp("unknown", now), null);
});
