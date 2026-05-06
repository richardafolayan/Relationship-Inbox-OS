import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLinkedInListTimestamp,
  parseLinkedInMessageTimestamp
} from "../apps/runner/dist/linkedin/linkedinTime.js";

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

test("LinkedIn list timestamp parser handles weekday names", () => {
  // Wednesday 6 May 2026
  const now = new Date(2026, 4, 6, 10, 0, 0, 0);

  // "Wednesday" — same day
  const wed = parseLinkedInListTimestamp("Wednesday", now);
  assert.ok(wed);
  assert.equal(wed.getFullYear(), 2026);
  assert.equal(wed.getMonth(), 4);
  assert.equal(wed.getDate(), 6);

  // "Saturday" — most recent past Saturday (3 May 2026)
  const sat = parseLinkedInListTimestamp("Saturday", now);
  assert.ok(sat);
  assert.equal(sat.getDate(), 2);
  assert.equal(sat.getMonth(), 4);

  // Short form
  const tue = parseLinkedInListTimestamp("Tue", now);
  assert.ok(tue);
  assert.equal(tue.getDate(), 5);
});

test("LinkedIn list timestamp parser handles 24-hour clock", () => {
  const now = new Date(2026, 1, 19, 23, 0, 0, 0);

  const t = parseLinkedInListTimestamp("19:16", now);
  assert.ok(t);
  assert.equal(t.getDate(), 19);
  assert.equal(t.getHours(), 19);
  assert.equal(t.getMinutes(), 16);
});

test("parseLinkedInMessageTimestamp combines a date heading with a time-of-day", () => {
  const now = new Date(2026, 4, 6, 10, 0, 0, 0);

  // Real Uwa Okungbowa scenario: time = "7:16 PM", heading = "Feb 19".
  // Bug being fixed: previous behaviour resolved this to "today + 7:16 PM".
  const uwa = parseLinkedInMessageTimestamp("7:16 PM", "Feb 19", now);
  assert.ok(uwa);
  assert.equal(uwa.getFullYear(), 2026);
  assert.equal(uwa.getMonth(), 1);
  assert.equal(uwa.getDate(), 19);
  assert.equal(uwa.getHours(), 19);
  assert.equal(uwa.getMinutes(), 16);

  // Real uriel omozusi scenario: heading = "Jan 27", time = "10:24 AM".
  const uriel = parseLinkedInMessageTimestamp("10:24 AM", "Jan 27", now);
  assert.ok(uriel);
  assert.equal(uriel.getFullYear(), 2026);
  assert.equal(uriel.getMonth(), 0);
  assert.equal(uriel.getDate(), 27);
  assert.equal(uriel.getHours(), 10);
  assert.equal(uriel.getMinutes(), 24);

  // Heading "Saturday" + a 12-hour time — anchored to the most recent past
  // Saturday (2 May 2026).
  const sat = parseLinkedInMessageTimestamp("11:20 AM", "Saturday", now);
  assert.ok(sat);
  assert.equal(sat.getMonth(), 4);
  assert.equal(sat.getDate(), 2);
  assert.equal(sat.getHours(), 11);
  assert.equal(sat.getMinutes(), 20);

  // No heading falls back to today (legacy behaviour) — still useful for
  // messages sent today where LinkedIn omits a separate date row.
  const today = parseLinkedInMessageTimestamp("9:30 AM", "", now);
  assert.ok(today);
  assert.equal(today.getDate(), 6);
  assert.equal(today.getHours(), 9);
  assert.equal(today.getMinutes(), 30);

  // 24-hour time alongside a date heading.
  const evening = parseLinkedInMessageTimestamp("19:16", "Feb 19", now);
  assert.ok(evening);
  assert.equal(evening.getDate(), 19);
  assert.equal(evening.getHours(), 19);

  // Both inputs empty/unparseable returns null.
  assert.equal(parseLinkedInMessageTimestamp("", "", now), null);

  // Unparseable time-of-day with a valid heading falls back to date-only
  // (noon) — better than dropping the message entirely. The audit log will
  // still show the original raw inputs via the snapshot's `raw` field.
  const dateOnly = parseLinkedInMessageTimestamp("not a time", "Feb 19", now);
  assert.ok(dateOnly);
  assert.equal(dateOnly.getDate(), 19);
  assert.equal(dateOnly.getMonth(), 1);
});
