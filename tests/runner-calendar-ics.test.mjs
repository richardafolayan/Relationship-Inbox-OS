import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeCalendar,
  findActiveOccurrence,
  findNextOccurrence
} from "../apps/runner/dist/services/calendar-ics.js";

// ICS parsing for calendar auto-focus (#786). All fixture times are in UTC (Z)
// so toJSDate is deterministic regardless of the test host's timezone.

function ics(...vevents) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...vevents,
    "END:VCALENDAR"
  ].join("\r\n");
}

function vevent({ uid, start, end, summary, extra = [] }) {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260101T000000Z",
    `DTSTART:${start}`,
    `DTEND:${end}`,
    summary != null ? `SUMMARY:${summary}` : null,
    ...extra,
    "END:VEVENT"
  ]
    .filter(Boolean)
    .join("\r\n");
}

test("a one-off event covering now is active", () => {
  const feed = ics(
    vevent({ uid: "a", start: "20260710T090000Z", end: "20260710T100000Z", summary: "Deep work" })
  );
  const occ = findActiveOccurrence(feed, { now: new Date("2026-07-10T09:30:00Z") });
  assert.ok(occ, "expected an active occurrence");
  assert.equal(occ.title, "Deep work");
  assert.equal(occ.startMs, Date.parse("2026-07-10T09:00:00Z"));
  assert.equal(occ.endMs, Date.parse("2026-07-10T10:00:00Z"));
  assert.match(occ.key, /^cal_/);
});

test("an event entirely in the future is not active but is next", () => {
  const feed = ics(
    vevent({ uid: "a", start: "20260710T140000Z", end: "20260710T150000Z", summary: "Later" })
  );
  const summary = summarizeCalendar(feed, { now: new Date("2026-07-10T09:30:00Z") });
  assert.equal(summary.active, null);
  assert.ok(summary.next);
  assert.equal(summary.next.title, "Later");
});

test("all-day events are ignored", () => {
  const feed = ics(
    "BEGIN:VEVENT",
    "UID:allday",
    "DTSTAMP:20260101T000000Z",
    "DTSTART;VALUE=DATE:20260710",
    "DTEND;VALUE=DATE:20260711",
    "SUMMARY:All day offsite",
    "END:VEVENT"
  );
  assert.equal(findActiveOccurrence(feed, { now: new Date("2026-07-10T09:30:00Z") }), null);
});

test("free / transparent events are ignored", () => {
  const feed = ics(
    vevent({
      uid: "free",
      start: "20260710T090000Z",
      end: "20260710T100000Z",
      summary: "Tentative",
      extra: ["TRANSP:TRANSPARENT"]
    })
  );
  assert.equal(findActiveOccurrence(feed, { now: new Date("2026-07-10T09:30:00Z") }), null);
});

test("cancelled events are ignored", () => {
  const feed = ics(
    vevent({
      uid: "x",
      start: "20260710T090000Z",
      end: "20260710T100000Z",
      summary: "Cancelled call",
      extra: ["STATUS:CANCELLED"]
    })
  );
  assert.equal(findActiveOccurrence(feed, { now: new Date("2026-07-10T09:30:00Z") }), null);
});

test("keyword filter matches case-insensitively on the summary", () => {
  const feed = ics(
    vevent({ uid: "a", start: "20260710T090000Z", end: "20260710T100000Z", summary: "Deep Work block" })
  );
  const now = new Date("2026-07-10T09:30:00Z");
  assert.ok(findActiveOccurrence(feed, { now, keyword: "deep" }), "keyword should match");
  assert.equal(findActiveOccurrence(feed, { now, keyword: "gym" }), null, "non-match filtered out");
});

test("recurring daily event resolves the current occurrence with a per-occurrence key", () => {
  const feed = ics(
    vevent({
      uid: "standup",
      start: "20260101T100000Z",
      end: "20260101T103000Z",
      summary: "Daily standup",
      extra: ["RRULE:FREQ=DAILY"]
    })
  );
  const during = findActiveOccurrence(feed, { now: new Date("2026-07-10T10:10:00Z") });
  assert.ok(during, "an occurrence should be live");
  assert.equal(during.startMs, Date.parse("2026-07-10T10:00:00Z"));

  const nextDay = findActiveOccurrence(feed, { now: new Date("2026-07-11T10:10:00Z") });
  assert.ok(nextDay);
  // Different occurrences must have different keys so dismissing one day's
  // auto-window doesn't suppress the next day's.
  assert.notEqual(during.key, nextDay.key);

  // Outside every occurrence: nothing live.
  assert.equal(findActiveOccurrence(feed, { now: new Date("2026-07-10T12:00:00Z") }), null);
});

test("when events overlap, the most-recently-started one wins", () => {
  const feed = ics(
    vevent({ uid: "long", start: "20260710T090000Z", end: "20260710T110000Z", summary: "Long block" }),
    vevent({ uid: "short", start: "20260710T093000Z", end: "20260710T100000Z", summary: "Nested call" })
  );
  const occ = findActiveOccurrence(feed, { now: new Date("2026-07-10T09:45:00Z") });
  assert.ok(occ);
  assert.equal(occ.title, "Nested call");
});

test("next returns the soonest upcoming busy event", () => {
  const feed = ics(
    vevent({ uid: "b", start: "20260710T150000Z", end: "20260710T160000Z", summary: "Afternoon" }),
    vevent({ uid: "a", start: "20260710T120000Z", end: "20260710T130000Z", summary: "Noon" })
  );
  const next = findNextOccurrence(feed, { now: new Date("2026-07-10T09:30:00Z") });
  assert.ok(next);
  assert.equal(next.title, "Noon");
});

test("malformed feed text throws (callers decide how to surface it)", () => {
  assert.throws(() => summarizeCalendar("not a calendar", { now: new Date() }));
});
