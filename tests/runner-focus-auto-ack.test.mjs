import assert from "node:assert/strict";
import test from "node:test";
import {
  bindFocusAutoAckEvents,
  createFocusAutoAckService,
  focusAutoAckCoverage,
  focusAutoAckText
} from "../apps/runner/src/services/focus-auto-ack.ts";
import { createEventBus } from "../apps/runner/src/services/event-bus.ts";
import { mergeFocusWindowUpdate } from "../apps/runner/src/services/settings.ts";

const now = new Date("2026-07-22T12:00:00.000Z");

function profile(overrides = {}) {
  return {
    displayName: "Richard",
    about: "",
    interests: "",
    commonPhrases: "",
    avoidedPhrases: "",
    preferredStyle: "casual",
    aiHelpLevel: "writing_support",
    setupCompletedAt: "",
    focusWindow: {
      active: true,
      startedAt: "2026-07-22T11:30:00.000Z",
      endsAt: "2026-07-22T13:30:00",
      reason: "lecture",
      note: "Hey [Name], I'm in class till [until]. I'll reply properly after.",
      professionalNote: "",
      audience: "favourites",
      windowId: "focus-1",
      ackedPersonIds: [],
      autoSendAcknowledgements: true,
      source: "manual",
      sourceEventKey: "",
      ...overrides
    },
    ackTemplates: {
      close: "Hi [Name], back at [until].",
      professional: "Hello [Name], I will respond after [until]."
    },
    focusSettings: { reasonLabel: true, oneNotePerPerson: true, audience: "favourites" },
    calendarSync: {
      url: "",
      additionalUrls: [],
      enabled: false,
      keyword: "",
      audience: "favourites",
      phraseWithAi: false
    }
  };
}

function thread(overrides = {}) {
  return {
    threadId: "thread-1",
    platform: "IMESSAGE",
    isGroup: false,
    category: "genuine",
    person: {
      id: "person-1",
      displayName: "Lanre Adeyemi",
      birthday: null,
      favouritedAt: new Date("2026-07-01T00:00:00.000Z")
    },
    latestInboundAt: new Date("2026-07-22T11:55:00.000Z"),
    latestOutboundAt: new Date("2026-07-22T11:20:00.000Z"),
    ...overrides
  };
}

function harness({ profileValue = profile(), threadValue = thread(), loadThread, afterEnqueue } = {}) {
  let current = structuredClone(profileValue);
  const queued = [];
  const writes = [];
  const service = createFocusAutoAckService({
    now: () => now,
    settingsStore: {
      async getOperatorProfile() {
        return structuredClone(current);
      },
      async acknowledgeFocusWindowPerson(windowId, personId) {
        if (current.focusWindow.windowId !== windowId) {
          return false;
        }
        current = {
          ...current,
          focusWindow: {
            ...current.focusWindow,
            ackedPersonIds: Array.from(new Set([...current.focusWindow.ackedPersonIds, personId]))
          }
        };
        writes.push({ focusWindow: structuredClone(current.focusWindow) });
        return true;
      }
    },
    async loadThread(threadId) {
      return loadThread ? loadThread(threadId) : threadValue;
    },
    sendQueue: {
      async enqueueAndKick(input) {
        queued.push(input);
        await afterEnqueue?.({
          read: () => structuredClone(current),
          write: (next) => { current = structuredClone(next); }
        });
        return {
          clientSendId: input.clientSendId,
          status: "PENDING",
          replayed: false,
          queuePosition: 0,
          activeCount: 1
        };
      }
    }
  });
  return { service, queued, writes, current: () => current };
}

test("explicit focus opt-in queues the operator's note once and records the person", async () => {
  const h = harness();
  const result = await h.service.handleThread("thread-1");
  assert.equal(result.type, "queued");
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].text, "Hey Lanre, I'm in class till 1:30pm. I'll reply properly after.");
  assert.deepEqual(h.current().focusWindow.ackedPersonIds, ["person-1"]);

  const repeated = await h.service.handleThread("thread-1");
  assert.deepEqual(repeated, { type: "skipped", reason: "already_acknowledged" });
  assert.equal(h.queued.length, 1);
});

test("recording the queued person cannot reactivate a focus window ended concurrently", async () => {
  const h = harness({
    afterEnqueue: async ({ read, write }) => {
      const ended = read();
      write({ ...ended, focusWindow: { ...ended.focusWindow, active: false } });
    }
  });

  assert.equal((await h.service.handleThread("thread-1")).type, "queued");
  assert.equal(h.current().focusWindow.active, false);
  assert.deepEqual(h.current().focusWindow.ackedPersonIds, ["person-1"]);
});

test("ending the same focus window preserves acknowledgements recorded concurrently", () => {
  const current = profile({ ackedPersonIds: ["person-1"] }).focusWindow;
  const endedFromStaleClient = {
    ...profile().focusWindow,
    active: false,
    ackedPersonIds: []
  };

  assert.deepEqual(
    mergeFocusWindowUpdate(current, endedFromStaleClient),
    { ...endedFromStaleClient, ackedPersonIds: ["person-1"] }
  );
});

test("automatic sending stays off unless the active window explicitly opts in", async () => {
  const h = harness({ profileValue: profile({ autoSendAcknowledgements: false }) });
  assert.deepEqual(await h.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "disabled"
  });
  assert.equal(h.queued.length, 0);
});

test("automatic sending fails closed when either focus-window boundary is invalid", async () => {
  for (const invalidWindow of [
    { startedAt: "", endsAt: "2026-07-22T13:30:00.000Z" },
    { startedAt: "not-a-date", endsAt: "2026-07-22T13:30:00.000Z" },
    { startedAt: "2026-07-22T11:30:00.000Z", endsAt: "" },
    { startedAt: "2026-07-22T11:30:00.000Z", endsAt: "not-a-date" }
  ]) {
    const h = harness({ profileValue: profile(invalidWindow) });
    assert.deepEqual(await h.service.handleThread("thread-1"), {
      type: "skipped",
      reason: "disabled"
    });
    assert.equal(h.queued.length, 0);
  }
});

test("group chats, outreach, and unknown unstarred handles are never covered", () => {
  const base = profile({ audience: "all_personal" });
  assert.equal(focusAutoAckCoverage(thread({ isGroup: true }), base), false);
  assert.equal(focusAutoAckCoverage(thread({ category: "outreach" }), base), false);
  assert.equal(focusAutoAckCoverage(thread({ category: null }), base), false);
  assert.equal(
    focusAutoAckCoverage(
      thread({
        person: {
          id: "unknown",
          displayName: "+44 7700 900000",
          birthday: null,
          favouritedAt: null
        }
      }),
      base
    ),
    false
  );
});

test("auto-ack revalidates authoritative classification immediately before queueing", async () => {
  let reads = 0;
  const h = harness({
    loadThread: async () => {
      reads += 1;
      return reads === 1 ? thread({ category: "genuine" }) : thread({ category: "outreach" });
    }
  });

  assert.deepEqual(await h.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "not_covered"
  });
  assert.equal(reads, 2);
  assert.equal(h.queued.length, 0);
});

test("post-projection events retry genuine auto-ack without duplicating concurrent events", async () => {
  let currentThread = thread({ category: null });
  const h = harness({ loadThread: async () => currentThread });
  const eventBus = createEventBus();
  const unsubscribe = bindFocusAutoAckEvents(eventBus, h.service);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  eventBus.emit({
    type: "MESSAGES_PERSISTED",
    jobId: "persisted-null",
    threadId: "thread-1",
    platform: "IMESSAGE",
    syncTiming: {
      sourceChangedAt: now.toISOString(),
      persistedAt: now.toISOString(),
      trigger: "test"
    }
  });
  await settle();
  assert.equal(h.queued.length, 0);

  currentThread = thread({ category: "outreach" });
  eventBus.emit({ type: "THREAD_UPDATED", jobId: "classified-outreach", threadId: "thread-1" });
  await settle();
  assert.equal(h.queued.length, 0);

  currentThread = thread({ category: "genuine" });
  eventBus.emit({
    type: "MESSAGES_PERSISTED",
    jobId: "persisted-genuine",
    threadId: "thread-1",
    platform: "IMESSAGE",
    syncTiming: {
      sourceChangedAt: now.toISOString(),
      persistedAt: now.toISOString(),
      trigger: "test"
    }
  });
  eventBus.emit({ type: "THREAD_UPDATED", jobId: "classified-genuine", threadId: "thread-1" });
  await settle();
  await settle();

  assert.equal(h.queued.length, 1);
  unsubscribe();
});

test("all-personal covers a saved iMessage contact but not the same unstarred LinkedIn contact", () => {
  const base = profile({ audience: "all_personal" });
  const saved = thread({
    person: {
      id: "saved",
      displayName: "Amina Yusuf",
      birthday: null,
      favouritedAt: null
    }
  });
  assert.equal(focusAutoAckCoverage(saved, base), true);
  assert.equal(focusAutoAckCoverage({ ...saved, platform: "LINKEDIN" }, base), false);
});

test("Instagram is never covered by automatic focus acknowledgements", async () => {
  const instagram = harness({
    threadValue: thread({ platform: "INSTAGRAM" })
  });

  assert.deepEqual(await instagram.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "not_covered"
  });
  assert.equal(instagram.queued.length, 0);
});

test("messages before the window and threads already replied to are skipped", async () => {
  const before = harness({
    threadValue: thread({ latestInboundAt: new Date("2026-07-22T11:00:00.000Z") })
  });
  assert.deepEqual(await before.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "before_window"
  });

  const replied = harness({
    threadValue: thread({ latestOutboundAt: new Date("2026-07-22T11:59:00.000Z") })
  });
  assert.deepEqual(await replied.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "already_replied"
  });
});

test("professional contacts use the professional note without AI generation", () => {
  const text = focusAutoAckText(
    thread({ platform: "LINKEDIN" }),
    profile({ professionalNote: "Hi [Name], back after [until]." })
  );
  assert.equal(text, "Hi Lanre, back after 1:30pm.");
});
