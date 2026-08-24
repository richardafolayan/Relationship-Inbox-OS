import test from "node:test";
import assert from "node:assert/strict";
import {
  createSendService,
  parsePersistedSendSource
} from "../apps/runner/dist/services/send.js";

test("persisted provenance accepts only known send sources", () => {
  assert.equal(parsePersistedSendSource("manual"), "manual");
  assert.equal(parsePersistedSendSource("focus_auto_ack"), "focus_auto_ack");
  assert.equal(parsePersistedSendSource("unknown"), null);
  assert.equal(parsePersistedSendSource(null), null);
});

test("enqueue persists auto-ack provenance for the worker safety boundary", async () => {
  let created;
  const service = createSendService({
    adapters: {},
    eventBus: { emit: () => undefined },
    settingsStore: {},
    auditLog: async () => "audit-id",
    withPlatformLock: async (_platform, work) => work(),
    prisma: {
      thread: {
        findUnique: async () => ({ id: "thread-1", platform: "LINKEDIN" })
      },
      sendRequest: {
        findUnique: async () => null,
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
    clientSendId: "client-1",
    source: "focus_auto_ack"
  });

  assert.equal(created.source, "focus_auto_ack");
});
