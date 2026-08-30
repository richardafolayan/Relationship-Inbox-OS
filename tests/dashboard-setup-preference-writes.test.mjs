import test from "node:test";
import assert from "node:assert/strict";

import {
  createSetupPreferenceWriteQueue,
  persistCompletedSetup
} from "../apps/dashboard/lib/setup-preference-writes.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("setup preference writes run in intent order and use the latest authoritative revision", async () => {
  const first = deferred();
  const calls = [];
  const queue = createSetupPreferenceWriteQueue(4, async (payload) => {
    calls.push(payload);
    if (calls.length === 1) return first.promise;
    return {
      selectedPlatforms: ["LINKEDIN"],
      aiEnabled: true,
      transcriptionMode: "off",
      startedAt: "start",
      completedAt: "",
      revision: 6
    };
  });

  const started = queue.save({ startedAt: "start" });
  const enabled = queue.save({ aiEnabled: true });
  await Promise.resolve();

  assert.deepEqual(calls, [{ startedAt: "start", expectedRevision: 4 }]);
  first.resolve({
    selectedPlatforms: ["LINKEDIN"],
    aiEnabled: false,
    transcriptionMode: "off",
    startedAt: "start",
    completedAt: "",
    revision: 5
  });

  const firstResult = await started;
  const secondResult = await enabled;
  assert.equal(firstResult.applied, true);
  assert.equal(secondResult.applied, true);
  assert.deepEqual(calls, [
    { startedAt: "start", expectedRevision: 4 },
    { aiEnabled: true, expectedRevision: 5 }
  ]);
  assert.equal(queue.latestRevision(), 6);
});

test("a failed setup preference write does not poison the queue or advance its revision", async () => {
  const calls = [];
  const queue = createSetupPreferenceWriteQueue(2, async (payload) => {
    calls.push(payload);
    if (calls.length === 1) throw new Error("disk full");
    return {
      selectedPlatforms: [],
      aiEnabled: true,
      transcriptionMode: "off",
      startedAt: "",
      completedAt: "",
      revision: 3
    };
  });

  await assert.rejects(queue.save({ startedAt: "start" }), /disk full/);
  const recovered = await queue.save({ aiEnabled: true });

  assert.equal(recovered.applied, true);
  assert.deepEqual(calls, [
    { startedAt: "start", expectedRevision: 2 },
    { aiEnabled: true, expectedRevision: 2 }
  ]);
  assert.equal(queue.latestRevision(), 3);
});

test("an older setup snapshot cannot replace newer authoritative preferences", () => {
  const queue = createSetupPreferenceWriteQueue(0, async () => {
    throw new Error("unused");
  });

  assert.equal(queue.acceptSnapshot({ revision: 8 }), true);
  assert.equal(queue.acceptSnapshot({ revision: 7 }), false);
  assert.equal(queue.acceptSnapshot({ revision: 8 }), true);
  assert.equal(queue.latestRevision(), 8);
});

test("setup completion is marked locally only after both authoritative writes succeed", async () => {
  const events = [];
  await persistCompletedSetup({
    completedAt: "done",
    persistOperatorProfile: async () => events.push("profile"),
    persistPreferences: async () => events.push("preferences"),
    markComplete: () => events.push("local")
  });
  assert.deepEqual(events, ["profile", "preferences", "local"]);
});

test("a failed completion preference write leaves local setup incomplete", async () => {
  const events = [];
  await assert.rejects(
    persistCompletedSetup({
      completedAt: "done",
      persistOperatorProfile: async () => events.push("profile"),
      persistPreferences: async () => {
        events.push("preferences");
        throw new Error("offline");
      },
      markComplete: () => events.push("local")
    }),
    /offline/
  );
  assert.deepEqual(events, ["profile", "preferences"]);
});
