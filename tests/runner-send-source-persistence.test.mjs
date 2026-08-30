import test from "node:test";
import assert from "node:assert/strict";
import {
  createSendService,
  parsePersistedSendSource
} from "../apps/runner/dist/services/send.js";
import {
  focusAutoAckClientSendId,
  focusManualAckClientSendId
} from "../apps/runner/dist/services/focus-auto-ack.js";

const focusWindowId = "focus-window-1";
const personId = "person-1";
const focusSettingsStore = {
  async getOperatorProfile() {
    return {
      focusWindow: {
        windowId: focusWindowId,
        active: true,
        endsAt: "2099-01-01T00:00:00.000Z",
        ackedPersonIds: []
      }
    };
  }
};

test("persisted provenance accepts only known send sources", () => {
  assert.equal(parsePersistedSendSource("manual"), "manual");
  assert.equal(parsePersistedSendSource("focus_ack"), "focus_ack");
  assert.equal(parsePersistedSendSource("focus_auto_ack"), "focus_auto_ack");
  assert.equal(parsePersistedSendSource("legacy_unknown"), null);
  assert.equal(parsePersistedSendSource("unknown"), null);
  assert.equal(parsePersistedSendSource(null), null);
});

test("enqueue persists auto-ack provenance for the worker safety boundary", async () => {
  let created;
  const service = createSendService({
    adapters: {},
    eventBus: { emit: () => undefined },
    settingsStore: focusSettingsStore,
    auditLog: async () => "audit-id",
    withExternalActionLock: async (_platform, work) => work(),
    withPlatformLock: async (_platform, work) => work(),
    prisma: {
      thread: {
        findUnique: async () => ({
          id: "thread-1",
          personId,
          platform: "LINKEDIN",
          userIntentVersion: 0
        })
      },
      sendRequest: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: async ({ data }) => {
          created = data;
          return data;
        }
      }
    }
  });

  await service.enqueueSend({
    threadId: "thread-1",
    text: "Saved focus note",
    clientSendId: focusAutoAckClientSendId(focusWindowId, personId),
    source: "focus_auto_ack",
    focusWindowId
  });

  assert.equal(created.source, "focus_auto_ack");
  assert.equal(created.focusIntentVersion, 0);
});

test("enqueue persists user-triggered focus provenance instead of disguising it as manual", async () => {
  let created;
  const service = createSendService({
    adapters: {},
    eventBus: { emit: () => undefined },
    settingsStore: focusSettingsStore,
    auditLog: async () => "audit-id",
    withExternalActionLock: async (_platform, work) => work(),
    withPlatformLock: async (_platform, work) => work(),
    prisma: {
      thread: {
        findUnique: async () => ({
          id: "thread-1",
          personId,
          platform: "LINKEDIN",
          userIntentVersion: 0
        })
      },
      sendRequest: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: async ({ data }) => {
          created = data;
          return data;
        }
      }
    }
  });

  await service.enqueueSend({
    threadId: "thread-1",
    text: "Saved focus note",
    clientSendId: focusManualAckClientSendId(focusWindowId, personId),
    source: "focus_ack",
    focusWindowId,
    focusIntentVersion: 0
  });

  assert.equal(created.source, "focus_ack");
  assert.equal(created.focusIntentVersion, 0);
});

test("Instagram rejects user-triggered focus provenance at enqueue", async () => {
  const service = createSendService({
    adapters: {},
    eventBus: { emit: () => undefined },
    settingsStore: {},
    auditLog: async () => "audit-id",
    withExternalActionLock: async (_platform, work) => work(),
    withPlatformLock: async (_platform, work) => work(),
    prisma: {
      thread: {
        findUnique: async () => ({ id: "thread-1", platform: "INSTAGRAM" })
      },
      sendRequest: {
        findUnique: async () => null,
        create: async () => {
          throw new Error("Instagram focus acknowledgement must not be persisted");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.enqueueSend({
        threadId: "thread-1",
        text: "Saved focus note",
        clientSendId: "client-1",
        source: "focus_ack"
      }),
    /user-triggered sends only/i
  );
});
