import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import
// below — see test:all in the root package.json.
const {
  parseRememberDate,
  daysUntil,
  rememberDateStatus,
  describeRememberDate,
  prepareRememberItems,
  REMEMBER_SOON_DAYS
} = await import("../apps/dashboard/lib/thread-remember.ts");

// These pure helpers back the thread "things to remember" section. They are
// the testable core extracted out of ThingsToRemember.tsx, since the
// dashboard has no component-test framework. A fixed "now" keeps the
// date-relative assertions deterministic.
const NOW = new Date("2026-05-22T12:00:00.000Z");

test("parseRememberDate: a strict ISO date parses to UTC midnight", () => {
  const parsed = parseRememberDate("2026-05-22");
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString(), "2026-05-22T00:00:00.000Z");
});

test("parseRememberDate: surrounding whitespace is tolerated", () => {
  const parsed = parseRememberDate("  2026-05-22  ");
  assert.equal(parsed?.toISOString().slice(0, 10), "2026-05-22");
});

test("parseRememberDate: non-ISO, partial, null and non-string inputs yield null", () => {
  assert.equal(parseRememberDate("2026-5-3"), null);
  assert.equal(parseRememberDate("May 30"), null);
  assert.equal(parseRememberDate("2026-05"), null);
  assert.equal(parseRememberDate(""), null);
  assert.equal(parseRememberDate(null), null);
  assert.equal(parseRememberDate(undefined), null);
  assert.equal(parseRememberDate(20260522), null);
});

test("parseRememberDate: an impossible calendar date is rejected, not rolled over", () => {
  // new Date("2026-02-30") would silently roll to Mar 2 — must be null.
  assert.equal(parseRememberDate("2026-02-30"), null);
  assert.equal(parseRememberDate("2026-13-01"), null);
});

test("daysUntil: counts calendar days crossed, ignoring the time of day", () => {
  assert.equal(daysUntil(new Date("2026-05-25T00:00:00.000Z"), NOW), 3);
  assert.equal(daysUntil(new Date("2026-05-22T00:00:00.000Z"), NOW), 0);
  assert.equal(daysUntil(new Date("2026-05-22T23:59:00.000Z"), NOW), 0);
  assert.equal(daysUntil(new Date("2026-05-21T00:00:00.000Z"), NOW), -1);
});

test("rememberDateStatus: past / today / soon / later / none", () => {
  assert.equal(rememberDateStatus("2026-05-10", NOW), "past");
  assert.equal(rememberDateStatus("2026-05-22", NOW), "today");
  assert.equal(rememberDateStatus("2026-05-23", NOW), "soon");
  assert.equal(rememberDateStatus("2026-06-05", NOW), "soon"); // exactly REMEMBER_SOON_DAYS out
  assert.equal(rememberDateStatus("2026-06-06", NOW), "later"); // one day past the window
  assert.equal(rememberDateStatus(null, NOW), "none");
  assert.equal(rememberDateStatus("not a date", NOW), "none");
});

test("rememberDateStatus: the soon window is REMEMBER_SOON_DAYS wide", () => {
  const edge = new Date(NOW.getTime() + REMEMBER_SOON_DAYS * 24 * 60 * 60 * 1000);
  assert.equal(rememberDateStatus(edge.toISOString().slice(0, 10), NOW), "soon");
});

test("describeRememberDate: near dates read naturally", () => {
  assert.equal(describeRememberDate("2026-05-22", NOW), "today");
  assert.equal(describeRememberDate("2026-05-23", NOW), "tomorrow");
  assert.equal(describeRememberDate("2026-05-27", NOW), "in 5 days");
  assert.equal(describeRememberDate("2026-05-21", NOW), "yesterday");
  assert.equal(describeRememberDate("2026-05-12", NOW), "10 days ago");
});

test("describeRememberDate: distant dates fall back to an absolute label", () => {
  assert.equal(describeRememberDate("2026-06-06", NOW), "6 Jun");
  assert.equal(describeRememberDate("2026-12-25", NOW), "25 Dec");
});

test("describeRememberDate: an undated / unparseable item has no label", () => {
  assert.equal(describeRememberDate(null, NOW), "");
  assert.equal(describeRememberDate("whenever", NOW), "");
});

test("prepareRememberItems: drops past events and keeps today + future", () => {
  const prepared = prepareRememberItems(
    [
      { note: "Old exam", date: "2026-01-10" },
      { note: "Exam today", date: "2026-05-22" },
      { note: "Trip soon", date: "2026-05-30" }
    ],
    NOW
  );
  assert.deepEqual(
    prepared.map((item) => item.note),
    ["Exam today", "Trip soon"]
  );
});

test("prepareRememberItems: sorts dated soonest-first, undated last", () => {
  const prepared = prepareRememberItems(
    [
      { note: "Later thing", date: "2026-06-30" },
      { note: "Undated A", date: null },
      { note: "Soon thing", date: "2026-05-25" },
      { note: "Undated B", date: null },
      { note: "Today thing", date: "2026-05-22" }
    ],
    NOW
  );
  assert.deepEqual(
    prepared.map((item) => item.note),
    ["Today thing", "Soon thing", "Later thing", "Undated A", "Undated B"]
  );
});

test("prepareRememberItems: skips items without a usable note, and bad input", () => {
  const prepared = prepareRememberItems(
    [
      { note: "   ", date: "2026-05-25" },
      { note: "Real one", date: "2026-05-25" },
      null,
      { date: "2026-05-26" }
    ],
    NOW
  );
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].note, "Real one");
  assert.deepEqual(prepareRememberItems(null, NOW), []);
  assert.deepEqual(prepareRememberItems(undefined, NOW), []);
});

test("prepareRememberItems: normalises the stored date and computes status + label", () => {
  const [item] = prepareRememberItems([{ note: "Exam", date: "  2026-05-25  " }], NOW);
  assert.equal(item.date, "2026-05-25");
  assert.equal(item.status, "soon");
  assert.equal(item.label, "in 3 days");
});

test("prepareRememberItems: an undated item is kept with status none and no label", () => {
  const [item] = prepareRememberItems([{ note: "Has exams at some point", date: null }], NOW);
  assert.equal(item.date, null);
  assert.equal(item.status, "none");
  assert.equal(item.label, "");
});
