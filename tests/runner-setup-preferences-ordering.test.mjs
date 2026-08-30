import test from "node:test";
import assert from "node:assert/strict";

import {
  createSetupPreferencesStore,
  SetupPreferencesConflictError
} from "../apps/runner/dist/services/setup-preferences.js";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("concurrent setup preference updates preserve both partial intents", async () => {
  const firstWrite = deferred();
  const firstWriteStarted = deferred();
  let stored = null;
  let writes = 0;
  const store = createSetupPreferencesStore({
    read: async () => stored,
    write: async (next) => {
      writes += 1;
      if (writes === 1) {
        firstWriteStarted.resolve();
        await firstWrite.promise;
      }
      stored = structuredClone(next);
    }
  });

  const started = store.update({ startedAt: "start" });
  await firstWriteStarted.promise;
  const enabled = store.update({ aiEnabled: true });
  firstWrite.resolve();

  await Promise.all([started, enabled]);
  assert.equal(stored.startedAt, "start");
  assert.equal(stored.aiEnabled, true);
  assert.equal(stored.revision, 2);
});

test("a failed setup preference write does not advance state or poison the next update", async () => {
  let stored = null;
  let attempts = 0;
  const store = createSetupPreferencesStore({
    read: async () => stored,
    write: async (next) => {
      attempts += 1;
      if (attempts === 1) throw new Error("write failed");
      stored = structuredClone(next);
    }
  });

  await assert.rejects(store.update({ startedAt: "start" }), /write failed/);
  const next = await store.update({ aiEnabled: true });

  assert.equal(next.startedAt, "");
  assert.equal(next.aiEnabled, true);
  assert.equal(next.revision, 1);
});

test("a stale expected revision is rejected before mutation work or persistence", async () => {
  let writes = 0;
  let mutationRuns = 0;
  const stored = {
    selectedPlatforms: ["LINKEDIN"],
    aiEnabled: false,
    transcriptionMode: "off",
    startedAt: "start",
    completedAt: "",
    revision: 5
  };
  const store = createSetupPreferencesStore({
    read: async () => stored,
    write: async () => {
      writes += 1;
    }
  });

  await assert.rejects(
    store.mutate({ expectedRevision: 4 }, async () => {
      mutationRuns += 1;
      return { aiEnabled: true };
    }),
    (error) => {
      assert.ok(error instanceof SetupPreferencesConflictError);
      assert.equal(error.current.revision, 5);
      return true;
    }
  );
  assert.equal(mutationRuns, 0);
  assert.equal(writes, 0);
});

test("setup mutation side effects finish before the new revision is persisted", async () => {
  const events = [];
  let stored = null;
  const store = createSetupPreferencesStore({
    read: async () => stored,
    write: async (next) => {
      events.push("preferences");
      stored = structuredClone(next);
    }
  });

  const result = await store.mutate({}, async () => {
    events.push("environment");
    events.push("settings");
    return { selectedPlatforms: ["WHATSAPP"] };
  });

  assert.deepEqual(events, ["environment", "settings", "preferences"]);
  assert.deepEqual(result.selectedPlatforms, ["WHATSAPP"]);
  assert.equal(result.revision, 1);
});
