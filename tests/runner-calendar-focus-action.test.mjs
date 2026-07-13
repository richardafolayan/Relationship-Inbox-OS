import test from "node:test";
import assert from "node:assert/strict";
import { computeCalendarFocusAction } from "../apps/runner/dist/services/calendar-focus.js";

// Pure decision logic for calendar auto-focus (#786): given the current focus
// window, the event live right now, and the operator's settings, what happens?

const SETTINGS = { url: "https://x/cal.ics", enabled: true, keyword: "", audience: "all_personal" };
const NOW = new Date("2026-07-10T10:15:00Z");

const OCC = {
  key: "cal_abc",
  uid: "standup",
  title: "Daily standup",
  startMs: Date.parse("2026-07-10T10:00:00Z"),
  endMs: Date.parse("2026-07-10T10:30:00Z")
};

function windowState(overrides = {}) {
  return {
    active: false,
    startedAt: "",
    endsAt: "",
    reason: "",
    note: "",
    professionalNote: "",
    audience: "favourites",
    windowId: "",
    ackedPersonIds: [],
    source: "manual",
    sourceEventKey: "",
    ...overrides
  };
}

test("opens a calendar window when an event is live and nothing is running", () => {
  const action = computeCalendarFocusAction(windowState(), OCC, SETTINGS, NOW);
  assert.equal(action.type, "start");
  assert.equal(action.window.active, true);
  assert.equal(action.window.source, "calendar");
  assert.equal(action.window.sourceEventKey, OCC.key);
  assert.equal(action.window.windowId, OCC.key);
  assert.equal(action.window.reason, "Daily standup");
  assert.equal(action.window.audience, "all_personal");
  assert.equal(action.window.endsAt, new Date(OCC.endMs).toISOString());
  // startedAt is the event start (bounded by now), so messages since the
  // meeting began count as "during focus".
  assert.equal(action.window.startedAt, new Date(OCC.startMs).toISOString());
});

test("never clobbers a hand-started (manual) window", () => {
  const manual = windowState({ active: true, source: "manual", windowId: "w1" });
  assert.equal(computeCalendarFocusAction(manual, OCC, SETTINGS, NOW).type, "none");
});

test("leaves a calendar window running for the same occurrence", () => {
  const running = windowState({
    active: true,
    source: "calendar",
    sourceEventKey: OCC.key,
    windowId: OCC.key
  });
  assert.equal(computeCalendarFocusAction(running, OCC, SETTINGS, NOW).type, "none");
});

test("switches when a different calendar occurrence becomes live", () => {
  const running = windowState({
    active: true,
    source: "calendar",
    sourceEventKey: "cal_old",
    windowId: "cal_old"
  });
  const action = computeCalendarFocusAction(running, OCC, SETTINGS, NOW);
  assert.equal(action.type, "start");
  assert.equal(action.window.sourceEventKey, OCC.key);
});

test("respects a dismissal: an ended calendar window for THIS occurrence stays off", () => {
  const dismissed = windowState({
    active: false,
    source: "calendar",
    sourceEventKey: OCC.key,
    windowId: OCC.key
  });
  assert.equal(computeCalendarFocusAction(dismissed, OCC, SETTINGS, NOW).type, "none");
});

test("re-opens for a new occurrence even after a previous one was dismissed", () => {
  const dismissedOther = windowState({
    active: false,
    source: "calendar",
    sourceEventKey: "cal_yesterday",
    windowId: "cal_yesterday"
  });
  assert.equal(computeCalendarFocusAction(dismissedOther, OCC, SETTINGS, NOW).type, "start");
});

test("ends its own auto-window when nothing is live", () => {
  const running = windowState({ active: true, source: "calendar", sourceEventKey: OCC.key });
  assert.equal(computeCalendarFocusAction(running, null, SETTINGS, NOW).type, "end");
});

test("does not end a manual window when nothing is live", () => {
  const manual = windowState({ active: true, source: "manual" });
  assert.equal(computeCalendarFocusAction(manual, null, SETTINGS, NOW).type, "none");
});

test("no-op when there is no live event and no active window", () => {
  assert.equal(computeCalendarFocusAction(windowState(), null, SETTINGS, NOW).type, "none");
});
