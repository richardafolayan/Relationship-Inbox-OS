import assert from "node:assert/strict";
import test from "node:test";
import { createSendQueue } from "../apps/runner/dist/services/send-queue.js";

test("enqueue during the final empty read cannot lose the queue wakeup", async () => {
  const rows = [];
  let releaseEmptyRead;
  let markEmptyReadStarted;
  const emptyReadStarted = new Promise((resolve) => {
    markEmptyReadStarted = resolve;
  });
  const emptyReadReleased = new Promise((resolve) => {
    releaseEmptyRead = resolve;
  });
  let firstRead = true;
  const prisma = {
    sendRequest: {
      async findFirst() {
        if (firstRead) {
          firstRead = false;
          markEmptyReadStarted();
          await emptyReadReleased;
          return null;
        }
        return rows.find((row) => row.status === "PENDING") ?? null;
      },
      async findMany() {
        return rows
          .filter((row) => row.status === "PENDING")
          .map(({ id, clientSendId }) => ({ id, clientSendId }));
      },
      async count() {
        return rows.filter((row) => row.status === "PENDING").length;
      },
      async update() {
        return {};
      }
    }
  };
  const processed = [];
  const queue = createSendQueue({
    prisma,
    eventBus: { emit: () => {} },
    sendService: {
      async enqueueSend(input) {
        rows.push({ id: "row-1", clientSendId: input.clientSendId, status: "PENDING" });
        return { clientSendId: input.clientSendId, status: "PENDING", replayed: false };
      },
      async processSendRequest(id) {
        processed.push(id);
        rows.find((row) => row.id === id).status = "SENT";
      },
      async reconcileInterruptedSends() {
        return 0;
      },
      async reconcileSentProjections() {
        return 0;
      }
    }
  });

  queue.kick();
  await emptyReadStarted;
  const enqueue = queue.enqueueAndKick({
    threadId: "thread-1",
    text: "hello",
    clientSendId: "client-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseEmptyRead();
  await enqueue;

  for (let attempt = 0; attempt < 20 && processed.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(processed, ["row-1"]);
  assert.equal(rows[0].status, "SENT");
});
