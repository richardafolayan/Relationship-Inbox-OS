import test from "node:test";
import assert from "node:assert/strict";

const {
  nextMorningSendSlot,
  shouldOfferLateNightSchedule,
  isLateNightSchedulePlatform
} = await import("../apps/dashboard/lib/late-night-send.ts");

// Build a local Date at a given wall-clock hour/minute on a fixed day so the
// assertions do not depend on the machine clock. 5 Jun 2026 is a Friday.
function at(hour, minute = 0) {
  return new Date(2026, 5, 5, hour, minute, 0, 0);
}

test("nextMorningSendSlot: 22:00 schedules tomorrow 08:00", () => {
  const now = at(22, 0);
  const slot = nextMorningSendSlot(now);
  assert.equal(slot.getHours(), 8);
  assert.equal(slot.getMinutes(), 0);
  assert.equal(slot.getDate(), now.getDate() + 1);
});

test("nextMorningSendSlot: 23:30 schedules tomorrow 08:00", () => {
  const now = at(23, 30);
  const slot = nextMorningSendSlot(now);
  assert.equal(slot.getHours(), 8);
  assert.equal(slot.getDate(), now.getDate() + 1);
});

test("nextMorningSendSlot: 02:00 schedules today 08:00", () => {
  const now = at(2, 0);
  const slot = nextMorningSendSlot(now);
  assert.equal(slot.getHours(), 8);
  assert.equal(slot.getDate(), now.getDate());
});

test("nextMorningSendSlot: 05:59 schedules today 08:00", () => {
  const now = at(5, 59);
  const slot = nextMorningSendSlot(now);
  assert.equal(slot.getHours(), 8);
  assert.equal(slot.getDate(), now.getDate());
});

test("nextMorningSendSlot: exactly 08:00 rolls to tomorrow", () => {
  const now = at(8, 0);
  const slot = nextMorningSendSlot(now);
  assert.equal(slot.getHours(), 8);
  assert.equal(slot.getDate(), now.getDate() + 1);
});

test("isLateNightSchedulePlatform: LinkedIn only", () => {
  assert.equal(isLateNightSchedulePlatform("LINKEDIN"), true);
  assert.equal(isLateNightSchedulePlatform("IMESSAGE"), false);
  assert.equal(isLateNightSchedulePlatform("INSTAGRAM"), false);
  assert.equal(isLateNightSchedulePlatform("TIKTOK"), false);
});

test("shouldOfferLateNightSchedule: LinkedIn + draft + late = true", () => {
  assert.equal(
    shouldOfferLateNightSchedule({ platform: "LINKEDIN", hasDraft: true, now: at(23, 0) }),
    true
  );
  assert.equal(
    shouldOfferLateNightSchedule({ platform: "LINKEDIN", hasDraft: true, now: at(2, 0) }),
    true
  );
});

test("shouldOfferLateNightSchedule: window edges (22:00 inclusive, 06:00 exclusive)", () => {
  // 22:00 is the inclusive start of the quiet window -> late.
  assert.equal(
    shouldOfferLateNightSchedule({ platform: "LINKEDIN", hasDraft: true, now: at(22, 0) }),
    true
  );
  // 05:59 still inside the window -> late.
  assert.equal(
    shouldOfferLateNightSchedule({ platform: "LINKEDIN", hasDraft: true, now: at(5, 59) }),
    true
  );
  // 06:00 is the exclusive end -> no longer late.
  assert.equal(
    shouldOfferLateNightSchedule({ platform: "LINKEDIN", hasDraft: true, now: at(6, 0) }),
    false
  );
  // Mid-afternoon -> not late.
  assert.equal(
    shouldOfferLateNightSchedule({ platform: "LINKEDIN", hasDraft: true, now: at(14, 0) }),
    false
  );
});

test("shouldOfferLateNightSchedule: empty draft = false even when late", () => {
  assert.equal(
    shouldOfferLateNightSchedule({ platform: "LINKEDIN", hasDraft: false, now: at(23, 0) }),
    false
  );
});

test("shouldOfferLateNightSchedule: non-LinkedIn = false even when late with a draft", () => {
  for (const platform of ["IMESSAGE", "INSTAGRAM", "TIKTOK"]) {
    assert.equal(
      shouldOfferLateNightSchedule({ platform, hasDraft: true, now: at(23, 0) }),
      false
    );
  }
});
