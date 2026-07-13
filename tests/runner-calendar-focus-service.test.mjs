import test from "node:test";
import assert from "node:assert/strict";
import { createCalendarFocusService } from "../apps/runner/dist/services/calendar-focus.js";

// The calendar auto-focus service tick (#786) against an in-memory settings
// store and an injected feed, so no network or db is touched.

function baseWindow(overrides = {}) {
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

function fakeStore(profileOverrides = {}) {
  let profile = {
    displayName: "",
    about: "",
    interests: "",
    commonPhrases: "",
    avoidedPhrases: "",
    preferredStyle: "",
    aiHelpLevel: "writing_support",
    setupCompletedAt: "",
    focusWindow: baseWindow(),
    ackTemplates: { close: "", professional: "" },
    focusSettings: { reasonLabel: true, oneNotePerPerson: true, audience: "favourites" },
    calendarSync: { url: "https://x/cal.ics", enabled: true, keyword: "", audience: "favourites" },
    ...profileOverrides
  };
  return {
    writes: 0,
    async getOperatorProfile() {
      return profile;
    },
    async updateOperatorProfile(partial) {
      this.writes++;
      profile = { ...profile, ...partial };
      return profile;
    },
    current: () => profile
  };
}

function icsFor(startZ, endZ, summary = "Deep work") {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    "UID:evt-1",
    "DTSTAMP:20260101T000000Z",
    `DTSTART:${startZ}`,
    `DTEND:${endZ}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
}

test("opens a window during an event, then closes it once the event ends", async () => {
  const store = fakeStore();
  const feed = icsFor("20260710T090000Z", "20260710T100000Z");
  let now = new Date("2026-07-10T09:30:00Z");
  const service = createCalendarFocusService({
    settingsStore: store,
    now: () => now,
    fetchIcs: async () => feed
  });

  const opened = await service.tick();
  assert.equal(opened.type, "start");
  assert.equal(store.current().focusWindow.active, true);
  assert.equal(store.current().focusWindow.source, "calendar");
  assert.equal(store.current().focusWindow.reason, "Deep work");

  // Same occurrence, still live -> no extra write.
  const writesAfterOpen = store.writes;
  const again = await service.tick();
  assert.equal(again.type, "none");
  assert.equal(store.writes, writesAfterOpen);

  // Move past the event end; the feed is cached, so the tick derives "no live
  // event" and closes the auto-window.
  now = new Date("2026-07-10T10:05:00Z");
  const closed = await service.tick();
  assert.equal(closed.type, "end");
  assert.equal(store.current().focusWindow.active, false);
  // Dismissal key is preserved so it can't immediately re-open.
  assert.equal(store.current().focusWindow.source, "calendar");
});

test("a transient feed error never tears down a running auto-window", async () => {
  const store = fakeStore({
    focusWindow: baseWindow({
      active: true,
      source: "calendar",
      sourceEventKey: "cal_live",
      windowId: "cal_live",
      endsAt: "2026-07-10T10:00:00Z"
    })
  });
  const service = createCalendarFocusService({
    settingsStore: store,
    now: () => new Date("2026-07-10T09:30:00Z"),
    fetchIcs: async () => {
      throw new Error("network down");
    }
  });
  const action = await service.tick();
  assert.equal(action.type, "none");
  assert.equal(store.current().focusWindow.active, true, "window left intact on fetch error");
  assert.equal(store.writes, 0);
});

test("disabling the subscription closes an active calendar window", async () => {
  const store = fakeStore({
    calendarSync: { url: "https://x/cal.ics", enabled: false, keyword: "", audience: "favourites" },
    focusWindow: baseWindow({ active: true, source: "calendar", sourceEventKey: "cal_live" })
  });
  let fetched = false;
  const service = createCalendarFocusService({
    settingsStore: store,
    now: () => new Date("2026-07-10T09:30:00Z"),
    fetchIcs: async () => {
      fetched = true;
      return "";
    }
  });
  const action = await service.tick();
  assert.equal(action.type, "end");
  assert.equal(fetched, false, "must not fetch when disabled");
  assert.equal(store.current().focusWindow.active, false);
});

test("a hand-started manual window is left alone even while an event is live", async () => {
  const store = fakeStore({
    focusWindow: baseWindow({ active: true, source: "manual", windowId: "w-manual" })
  });
  const feed = icsFor("20260710T090000Z", "20260710T100000Z");
  const service = createCalendarFocusService({
    settingsStore: store,
    now: () => new Date("2026-07-10T09:30:00Z"),
    fetchIcs: async () => feed
  });
  const action = await service.tick();
  assert.equal(action.type, "none");
  assert.equal(store.current().focusWindow.windowId, "w-manual");
  assert.equal(store.writes, 0);
});

test("refresh() clears the cache and re-checks immediately", async () => {
  const store = fakeStore();
  let feed = icsFor("20260710T090000Z", "20260710T100000Z");
  let fetches = 0;
  const service = createCalendarFocusService({
    settingsStore: store,
    now: () => new Date("2026-07-10T09:30:00Z"),
    fetchIcs: async () => {
      fetches++;
      return feed;
    }
  });
  await service.tick();
  assert.equal(fetches, 1);
  // A second tick reuses the cached feed.
  await service.tick();
  assert.equal(fetches, 1);
  // refresh forces a fresh fetch.
  await service.refresh();
  assert.equal(fetches, 2);
});
