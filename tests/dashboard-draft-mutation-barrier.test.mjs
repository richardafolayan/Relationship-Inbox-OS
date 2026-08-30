import assert from "node:assert/strict";
import test from "node:test";

import {
  createDraftMutationBarrier,
  DraftMutationUncertainError
} from "../apps/dashboard/lib/draft-mutation-barrier.ts";
import { draftRevisionForComposerSend } from "../apps/dashboard/lib/saved-draft-revision.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const oldRevision = {
  text: "Old saved text",
  updatedAt: "2026-08-30T09:00:00.000Z"
};

const savedRevision = {
  text: "Save this before sending",
  updatedAt: "2026-08-30T09:05:00.000Z"
};

test("send and schedule wait for the latest authoritative saved draft revision", async () => {
  const barrier = createDraftMutationBarrier();
  const response = deferred();
  const events = [];

  const save = barrier.enqueueSave("thread-a", async () => {
    events.push("save-started");
    return response.promise;
  });
  const sendRevision = barrier.waitForRevision("thread-a", oldRevision).then((revision) => {
    events.push("send-captured");
    return revision;
  });
  const scheduleRevision = barrier.waitForRevision("thread-a", oldRevision).then((revision) => {
    events.push("schedule-captured");
    return revision;
  });

  await Promise.resolve();
  assert.deepEqual(events, ["save-started"]);
  response.resolve(savedRevision);

  assert.deepEqual(await save, savedRevision);
  assert.deepEqual(await sendRevision, savedRevision);
  assert.deepEqual(await scheduleRevision, savedRevision);
  assert.deepEqual(events, ["save-started", "send-captured", "schedule-captured"]);
});

test("a draft mutation started after action capture waits until the action releases", async () => {
  const barrier = createDraftMutationBarrier();
  const action = await barrier.acquireAction("thread-a", oldRevision);
  let saveStarted = false;
  const save = barrier.enqueueSave("thread-a", async () => {
    saveStarted = true;
    return savedRevision;
  });

  await Promise.resolve();
  assert.equal(saveStarted, false);
  assert.deepEqual(action.revision, oldRevision);

  action.release();
  assert.deepEqual(await save, savedRevision);
  assert.equal(saveStarted, true);
});

test("a send waiting on an edited save consumes the revision that just completed", async () => {
  const barrier = createDraftMutationBarrier();
  const response = deferred();
  const save = barrier.enqueueSave("thread-a", () => response.promise);
  const originatingRevision = {
    text: "Original saved text",
    updatedAt: "2026-08-30T09:00:00.000Z"
  };
  const sendRevision = barrier
    .waitForRevision("thread-a", originatingRevision)
    .then((current) =>
      draftRevisionForComposerSend(current, originatingRevision, savedRevision.text)
    );

  response.resolve(savedRevision);
  await save;
  assert.deepEqual(await sendRevision, savedRevision);
});

test("delete runs after an in-flight save and leaves no draft revision", async () => {
  const barrier = createDraftMutationBarrier();
  const response = deferred();
  const events = [];

  void barrier.enqueueSave("thread-a", async () => {
    events.push("save-started");
    return response.promise;
  });
  const deletion = barrier.enqueueDelete(
    "thread-a",
    oldRevision,
    async (expectedRevision) => {
      events.push("delete-started");
      assert.deepEqual(expectedRevision, savedRevision);
      return { deleted: true };
    }
  );

  await Promise.resolve();
  assert.deepEqual(events, ["save-started"]);
  response.resolve(savedRevision);

  assert.deepEqual(await deletion, {
    deletedRevision: savedRevision,
    result: { deleted: true }
  });
  assert.equal(await barrier.waitForRevision("thread-a", oldRevision), null);
  assert.deepEqual(events, ["save-started", "delete-started"]);
});

test("an uncertain save blocks send until an explicit delete resolves the draft state", async () => {
  const barrier = createDraftMutationBarrier();
  await assert.rejects(
    barrier.enqueueSave("thread-a", async () => {
      throw new Error("response lost");
    }),
    /response lost/
  );

  await assert.rejects(
    barrier.waitForRevision("thread-a", oldRevision),
    DraftMutationUncertainError
  );

  const deletion = await barrier.enqueueDelete(
    "thread-a",
    oldRevision,
    async () => ({ deleted: true })
  );
  assert.deepEqual(deletion, { deletedRevision: oldRevision, result: { deleted: true } });
  assert.equal(await barrier.waitForRevision("thread-a", oldRevision), null);
});

test("another thread is not blocked by this thread's draft mutation", async () => {
  const barrier = createDraftMutationBarrier();
  const response = deferred();
  void barrier.enqueueSave("thread-a", () => response.promise);

  assert.deepEqual(await barrier.waitForRevision("thread-b", oldRevision), oldRevision);
  response.resolve(savedRevision);
});

test("a response started before save completion cannot roll the revision back", async () => {
  const barrier = createDraftMutationBarrier();
  const requestGeneration = barrier.generation("thread-a");

  await barrier.enqueueSave("thread-a", async () => savedRevision);

  assert.deepEqual(
    barrier.reconcileFetchedRevision("thread-a", requestGeneration, oldRevision),
    savedRevision
  );
});

test("a confirmed send consumption fences stale cached draft payloads", async () => {
  const barrier = createDraftMutationBarrier();
  await barrier.enqueueSave("thread-a", async () => savedRevision);
  const requestGeneration = barrier.generation("thread-a");

  assert.equal(barrier.consumeRevision("thread-a", savedRevision), true);
  assert.equal(
    barrier.reconcileFetchedRevision("thread-a", requestGeneration, savedRevision),
    null
  );
});

test("a newer cross-tab draft wins even when it arrives after a confirmed consumption", async () => {
  const barrier = createDraftMutationBarrier();
  await barrier.enqueueSave("thread-a", async () => savedRevision);
  const requestGeneration = barrier.generation("thread-a");
  const newerRevision = {
    text: "Written in another tab",
    updatedAt: "2026-08-30T09:06:00.000Z"
  };

  assert.equal(barrier.consumeRevision("thread-a", savedRevision), true);
  assert.deepEqual(
    barrier.reconcileFetchedRevision("thread-a", requestGeneration, newerRevision),
    newerRevision
  );
});

test("a newer cross-tab draft wins even when it arrives during a confirmed delete", async () => {
  const barrier = createDraftMutationBarrier();
  await barrier.enqueueSave("thread-a", async () => savedRevision);
  const requestGeneration = barrier.generation("thread-a");
  const newerRevision = {
    text: "Written in another tab",
    updatedAt: "2026-08-30T09:06:00.000Z"
  };

  await barrier.enqueueDelete("thread-a", savedRevision, async () => ({ deleted: true }));
  assert.deepEqual(
    barrier.reconcileFetchedRevision("thread-a", requestGeneration, newerRevision),
    newerRevision
  );
});

test("a failed compare-and-delete keeps the barrier open for the authoritative newer draft", async () => {
  const barrier = createDraftMutationBarrier();
  await barrier.enqueueSave("thread-a", async () => savedRevision);
  const requestGeneration = barrier.generation("thread-a");
  const newerRevision = {
    text: "Written in another tab",
    updatedAt: "2026-08-30T09:06:00.000Z"
  };

  const deletion = await barrier.enqueueDelete(
    "thread-a",
    oldRevision,
    async (expectedRevision) => {
      assert.deepEqual(expectedRevision, savedRevision);
      return { deleted: false };
    }
  );

  assert.equal(deletion.result.deleted, false);
  assert.deepEqual(
    barrier.reconcileFetchedRevision("thread-a", requestGeneration, newerRevision),
    newerRevision
  );
});

test("an equal-timestamp different server draft is treated as an authoritative conflict", async () => {
  const barrier = createDraftMutationBarrier();
  await barrier.enqueueSave("thread-a", async () => savedRevision);
  const requestGeneration = barrier.generation("thread-a");
  const equalTimestampRevision = {
    text: "Different text saved in another tab",
    updatedAt: savedRevision.updatedAt
  };

  assert.deepEqual(
    barrier.reconcileFetchedRevision(
      "thread-a",
      requestGeneration,
      equalTimestampRevision
    ),
    equalTimestampRevision
  );
});
