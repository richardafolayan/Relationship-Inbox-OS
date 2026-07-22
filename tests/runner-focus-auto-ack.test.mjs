import assert from "node:assert/strict";
import test from "node:test";
import {
  createFocusAutoAckService,
  focusAutoAckCoverage,
  focusAutoAckText
} from "../apps/runner/src/services/focus-auto-ack.ts";

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

function harness({ profileValue = profile(), threadValue = thread() } = {}) {
  let current = structuredClone(profileValue);
  const queued = [];
  const writes = [];
  const service = createFocusAutoAckService({
    now: () => now,
    settingsStore: {
      async getOperatorProfile() {
        return structuredClone(current);
      },
      async updateOperatorProfile(partial) {
        current = { ...current, ...structuredClone(partial) };
        writes.push(structuredClone(partial));
        return structuredClone(current);
      }
    },
    async loadThread() {
      return threadValue;
    },
    sendQueue: {
      async enqueueAndKick(input) {
        queued.push(input);
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

test("automatic sending stays off unless the active window explicitly opts in", async () => {
  const h = harness({ profileValue: profile({ autoSendAcknowledgements: false }) });
  assert.deepEqual(await h.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "disabled"
  });
  assert.equal(h.queued.length, 0);
});

test("group chats, outreach, and unknown unstarred handles are never covered", () => {
  const base = profile({ audience: "all_personal" });
  assert.equal(focusAutoAckCoverage(thread({ isGroup: true }), base), false);
  assert.equal(focusAutoAckCoverage(thread({ category: "outreach" }), base), false);
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
