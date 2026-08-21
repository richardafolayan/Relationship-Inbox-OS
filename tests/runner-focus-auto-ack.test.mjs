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

function harness({ profileValue = profile(), threadValue = thread(), sendRequestValue = null } = {}) {
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
    async loadSendRequest() {
      return sendRequestValue;
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

test("focus note is acknowledged only after its deterministic send is delivered", async () => {
  const h = harness();
  const result = await h.service.handleThread("thread-1");
  assert.equal(result.type, "queued");
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].text, "Hey Lanre, I'm in class till 1:30pm. I'll reply properly after.");
  assert.deepEqual(h.current().focusWindow.ackedPersonIds, []);

  const delivered = await h.service.handleDelivered({
    threadId: "thread-1",
    clientSendId: result.clientSendId
  });
  assert.deepEqual(delivered, { type: "acknowledged", personId: "person-1" });
  assert.deepEqual(h.current().focusWindow.ackedPersonIds, ["person-1"]);

  const repeated = await h.service.handleThread("thread-1");
  assert.deepEqual(repeated, { type: "skipped", reason: "already_acknowledged" });
  assert.equal(h.queued.length, 1);
});

test("enqueue success and unrelated delivery events never acknowledge a focus candidate", async () => {
  const h = harness();
  const first = await h.service.handleThread("thread-1");
  const second = await h.service.handleThread("thread-1");
  assert.equal(first.type, "queued");
  assert.equal(second.type, "queued");
  assert.equal(first.clientSendId, second.clientSendId, "tabs reuse one person/window idempotency key");
  assert.deepEqual(h.current().focusWindow.ackedPersonIds, []);

  assert.deepEqual(
    await h.service.handleDelivered({
      threadId: "thread-1",
      clientSendId: "00000000-0000-4000-8000-000000000000"
    }),
    { type: "skipped", reason: "not_focus_note" }
  );
  assert.deepEqual(h.current().focusWindow.ackedPersonIds, []);
});

test("persisted focus attempts dedupe after restart and restore acknowledgement only from SENT", async () => {
  const pending = harness({
    sendRequestValue: { threadId: "thread-1", status: "PENDING" }
  });
  assert.deepEqual(await pending.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "already_queued"
  });
  assert.equal(pending.queued.length, 0);
  assert.deepEqual(pending.current().focusWindow.ackedPersonIds, []);

  const sent = harness({
    sendRequestValue: { threadId: "thread-1", status: "SENT" }
  });
  assert.deepEqual(await sent.service.handleThread("thread-1"), {
    type: "skipped",
    reason: "already_delivered"
  });
  assert.equal(sent.queued.length, 0);
  assert.deepEqual(sent.current().focusWindow.ackedPersonIds, ["person-1"]);
});

test("simultaneous confirmed notes for different people merge acknowledgement state", async () => {
  let current = structuredClone(profile());
  const queued = [];
  const threads = {
    "thread-1": thread(),
    "thread-2": thread({
      threadId: "thread-2",
      person: {
        id: "person-2",
        displayName: "Maya Patel",
        birthday: null,
        favouritedAt: new Date("2026-07-01T00:00:00.000Z")
      }
    })
  };
  const service = createFocusAutoAckService({
    now: () => now,
    settingsStore: {
      async getOperatorProfile() {
        return structuredClone(current);
      },
      async updateOperatorProfile(partial) {
        await Promise.resolve();
        current = { ...current, ...structuredClone(partial) };
        return structuredClone(current);
      }
    },
    loadThread: async (threadId) => threads[threadId] ?? null,
    loadSendRequest: async () => null,
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
  await Promise.all([service.handleThread("thread-1"), service.handleThread("thread-2")]);
  await Promise.all(
    queued.map((send) =>
      service.handleDelivered({ threadId: send.threadId, clientSendId: send.clientSendId })
    )
  );
  assert.deepEqual(current.focusWindow.ackedPersonIds.sort(), ["person-1", "person-2"]);
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
