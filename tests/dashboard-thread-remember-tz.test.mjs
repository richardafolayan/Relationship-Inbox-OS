// Regression: daysUntil must floor `now` by the operator's LOCAL midnight, not
// UTC. The remember date is stored as UTC midnight of a bare calendar date, but
// the caller (ThingsToRemember.tsx) passes `new Date()` — a wall-clock instant.
// For a non-UTC operator in the evening, the UTC day has already rolled to the
// next date, so flooring `now` by UTC made "today"/"tomorrow" items mislabel
// and silently drop out of the section.
//
// This file pins the timezone to America/New_York (UTC-4 in May) BEFORE
// importing the module, so the local-day reduction is exercised. Run with
// `node --import tsx --test` like the rest of tests/.
process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";

const { daysUntil, rememberDateStatus, describeRememberDate, prepareRememberItems } =
  await import("../apps/dashboard/lib/thread-remember.ts");

// Guard: if the host can't honour TZ (very old ICU), these assertions would be
// meaningless, so assert the environment first.
test("env: timezone is pinned to a non-UTC western zone", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York");
  // 22:00 on 2026-05-22 EDT == 2026-05-23T02:00:00Z; the local calendar day is
  // still the 22nd even though UTC has rolled to the 23rd.
  const evening = new Date("2026-05-23T02:00:00.000Z");
  assert.equal(evening.getDate(), 22);
});

// The operator's wall clock reads 22:00 on 2026-05-22 (EDT). As a UTC instant
// that is 2026-05-23T02:00:00Z — already "tomorrow" in UTC. Every assertion
// below is from the operator's local point of view.
const EVENING_NOW = new Date("2026-05-23T02:00:00.000Z");

test("daysUntil: an evening operator counts days from their LOCAL date", () => {
  // Same local calendar day -> 0 (was -1 under the UTC-floor bug).
  assert.equal(daysUntil(new Date("2026-05-22T00:00:00.000Z"), EVENING_NOW), 0);
  // Next local day -> 1 (was 0 under the bug).
  assert.equal(daysUntil(new Date("2026-05-23T00:00:00.000Z"), EVENING_NOW), 1);
  // Five local days out -> 5 (was 4 under the bug).
  assert.equal(daysUntil(new Date("2026-05-27T00:00:00.000Z"), EVENING_NOW), 5);
  // Genuinely past stays past.
  assert.equal(daysUntil(new Date("2026-05-21T00:00:00.000Z"), EVENING_NOW), -1);
});

test("rememberDateStatus: a same-local-day item reads as today, not past", () => {
  // The headline failure: under the bug this returned "past" and the item
  // vanished from the section for the whole evening.
  assert.equal(rememberDateStatus("2026-05-22", EVENING_NOW), "today");
  assert.equal(rememberDateStatus("2026-05-23", EVENING_NOW), "soon");
  assert.equal(rememberDateStatus("2026-05-21", EVENING_NOW), "past");
});

test("describeRememberDate: same-local-day reads 'today', next day 'tomorrow'", () => {
  assert.equal(describeRememberDate("2026-05-22", EVENING_NOW), "today");
  assert.equal(describeRememberDate("2026-05-23", EVENING_NOW), "tomorrow");
  assert.equal(describeRememberDate("2026-05-27", EVENING_NOW), "in 5 days");
});

test("prepareRememberItems: a today-local item is kept, not dropped as past", () => {
  const prepared = prepareRememberItems(
    [
      { note: "Her exam is today", date: "2026-05-22" },
      { note: "Yesterday's thing", date: "2026-05-21" }
    ],
    EVENING_NOW
  );
  // The bug dropped the 22nd as "past", leaving the section empty / wrong.
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].note, "Her exam is today");
  assert.equal(prepared[0].status, "today");
  assert.equal(prepared[0].label, "today");
});
