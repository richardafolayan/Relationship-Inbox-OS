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
  const enqueued = [];
  const queue = createSendQueue({
    prisma,
    eventBus: { emit: () => {} },
    sendService: {
      async enqueueSend(input) {
        enqueued.push(input);
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
    clientSendId: "client-1",
    attachments: [{
      absolutePath: "/tmp/photo.jpg",
      displayName: "photo.jpg",
      mimeType: "image/jpeg",
      kind: "photo",
      contentDigest: "sha256:photo"
    }]
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseEmptyRead();
  await enqueue;

  for (let attempt = 0; attempt < 20 && processed.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(processed, ["row-1"]);
  assert.equal(enqueued[0].attachments[0].contentDigest, "sha256:photo");
  assert.equal(rows[0].status, "SENT");
});

test("resume repairs interrupted rows and sent projections before draining", async () => {
  const order = [];
  const rows = [{ id: "auto-1", clientSendId: "auto-client", status: "PENDING" }];
  const queue = createSendQueue({
    prisma: {
      sendRequest: {
        async findFirst() {
          order.push("read-queue");
          return rows.find((row) => row.status === "PENDING") ?? null;
        },
        async count() {
          return rows.filter((row) => row.status === "PENDING").length;
        },
        async update() {
          return {};
        }
      }
    },
    eventBus: { emit: () => {} },
    sendService: {
      async reconcileInterruptedSends() {
        order.push("repair-interrupted");
        return 0;
      },
      async reconcileSentProjections() {
        order.push("repair-projections");
        return 1;
      },
      async processSendRequest(id) {
        order.push(`process:${id}`);
        rows[0].status = "SENT";
      },
      async enqueueSend() {
        throw new Error("not used");
      }
    }
  });

  queue.resume();
  for (let attempt = 0; attempt < 20 && rows[0].status === "PENDING"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(order.slice(0, 4), [
    "repair-interrupted",
    "repair-projections",
    "read-queue",
    "process:auto-1"
  ]);
});

test("resume fails closed when authoritative projection repair fails", async () => {
  let queueReads = 0;
  let processed = 0;
  const queue = createSendQueue({
    prisma: {
      sendRequest: {
        async findFirst() {
          queueReads += 1;
          return { id: "auto-1", clientSendId: "auto-client", status: "PENDING" };
        },
        async count() {
          return 1;
        },
        async update() {
          return {};
        }
      }
    },
    eventBus: { emit: () => {} },
    sendService: {
      async reconcileInterruptedSends() {
        return 0;
      },
      async reconcileSentProjections() {
        throw new Error("projection database unavailable");
      },
      async processSendRequest() {
        processed += 1;
      },
      async enqueueSend() {
        throw new Error("not used");
      }
    }
  });

  queue.resume();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(queueReads, 0);
  assert.equal(processed, 0);

  queue.kick();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queueReads, 0);
  assert.equal(processed, 0);
});
