import test from "node:test";
import assert from "node:assert/strict";

import { createSetupPreferencesCoordinator } from "../apps/runner/dist/services/setup-preferences-coordinator.js";
import {
  createSetupPreferencesStore,
  SetupPreferencesConflictError
} from "../apps/runner/dist/services/setup-preferences.js";

function createHarness({ failSetupTransaction = false, failCompletionTransaction = false } = {}) {
  const events = [];
  let storedPreferences = null;
  let settings = {
    enabledPlatforms: ["LINKEDIN"],
    aiEnabled: false,
    aiProvider: "openai",
    automaticUpdates: true
  };
  let operatorProfile = {
    displayName: "Richard",
    setupCompletedAt: ""
  };

  const preferenceStore = createSetupPreferencesStore({
    read: async () => storedPreferences,
    write: async (next) => {
      events.push("preferences-only");
      storedPreferences = structuredClone(next);
    }
  });

  const coordinator = createSetupPreferencesCoordinator({
    availablePlatforms: ["LINKEDIN", "INSTAGRAM", "WHATSAPP"],
    mutateSettings: async (work) => work({
      current: structuredClone(settings),
      commit: async (partial, persist) => {
        const next = { ...settings, ...partial };
        await persist(next);
        settings = structuredClone(next);
        events.push("settings-cache");
        return structuredClone(next);
      }
    }),
    mutateOperatorProfile: async (work) => work({
      current: structuredClone(operatorProfile),
      commit: async (partial, persist) => {
        const next = { ...operatorProfile, ...partial };
        await persist(next);
        operatorProfile = structuredClone(next);
        events.push("profile-cache");
        return structuredClone(next);
      }
    }),
    mutatePreferences: preferenceStore.mutate,
    persistSetupState: async (nextSettings, nextPreferences) => {
      events.push("setup-transaction");
      if (failSetupTransaction) throw new Error("setup transaction failed");
      settings = structuredClone(nextSettings);
      storedPreferences = structuredClone(nextPreferences);
    },
    persistCompletedState: async (nextProfile, nextPreferences) => {
      events.push("completion-transaction");
      if (failCompletionTransaction) throw new Error("completion transaction failed");
      operatorProfile = structuredClone(nextProfile);
      storedPreferences = structuredClone(nextPreferences);
    }
  });

  return {
    coordinator,
    events,
    getStored: () => structuredClone(storedPreferences),
    getSettings: () => structuredClone(settings),
    getOperatorProfile: () => structuredClone(operatorProfile)
  };
}

test("setup coordinator commits settings and preferences through one transaction", async () => {
  const harness = createHarness();
  const preferences = await harness.coordinator.update({
    expectedRevision: 0,
    startedAt: "start",
    selectedPlatforms: ["WHATSAPP"],
    aiEnabled: true
  });

  assert.deepEqual(harness.events, ["setup-transaction", "settings-cache"]);
  assert.equal(preferences.revision, 1);
  assert.deepEqual(harness.getSettings().enabledPlatforms, ["WHATSAPP"]);
  assert.equal(harness.getSettings().aiEnabled, true);
  assert.deepEqual(harness.getStored(), preferences);
});

test("a failed setup transaction leaves settings and preferences at their exact predecessors", async () => {
  const harness = createHarness({ failSetupTransaction: true });

  await assert.rejects(
    harness.coordinator.update({
      expectedRevision: 0,
      startedAt: "start",
      selectedPlatforms: ["WHATSAPP"],
      aiEnabled: true
    }),
    /setup transaction failed/
  );

  assert.deepEqual(harness.events, ["setup-transaction"]);
  assert.equal(harness.getStored(), null);
  assert.deepEqual(harness.getSettings().enabledPlatforms, ["LINKEDIN"]);
  assert.equal(harness.getSettings().aiEnabled, false);
});

test("a stale setup request is rejected before the transaction", async () => {
  const harness = createHarness();
  await harness.coordinator.update({ expectedRevision: 0, startedAt: "start" });
  harness.events.length = 0;

  await assert.rejects(
    harness.coordinator.update({ expectedRevision: 0, aiEnabled: true }),
    (error) => {
      assert.ok(error instanceof SetupPreferencesConflictError);
      assert.equal(error.current.revision, 1);
      return true;
    }
  );
  assert.deepEqual(harness.events, []);
  assert.equal(harness.getStored().aiEnabled, false);
});

test("first setup mutation inherits existing pilot settings only before setup has started", async () => {
  const harness = createHarness();
  const first = await harness.coordinator.update({ expectedRevision: 0, startedAt: "start" });
  const second = await harness.coordinator.update({
    expectedRevision: first.revision,
    completedAt: "done"
  });

  assert.deepEqual(first.selectedPlatforms, ["LINKEDIN"]);
  assert.equal(first.aiEnabled, false);
  assert.deepEqual(second.selectedPlatforms, ["LINKEDIN"]);
  assert.equal(second.aiEnabled, false);
});

test("AI provider activation is one coherent setup revision", async () => {
  const harness = createHarness();
  const preferences = await harness.coordinator.enableAiProvider("gemini");

  assert.equal(preferences.aiEnabled, true);
  assert.equal(preferences.revision, 1);
  assert.equal(harness.getSettings().aiEnabled, true);
  assert.equal(harness.getSettings().aiProvider, "gemini");
  assert.deepEqual(harness.events, ["setup-transaction", "settings-cache"]);
});

test("completion atomically stamps operator profile and setup preferences", async () => {
  const harness = createHarness();
  const started = await harness.coordinator.update({ expectedRevision: 0, startedAt: "start" });
  harness.events.length = 0;

  const result = await harness.coordinator.complete({
    completedAt: "done",
    expectedRevision: started.revision
  });

  assert.deepEqual(harness.events, ["completion-transaction", "profile-cache"]);
  assert.equal(result.preferences.completedAt, "done");
  assert.equal(result.preferences.revision, 2);
  assert.equal(result.operatorProfile.setupCompletedAt, "done");
  assert.equal(harness.getStored().completedAt, "done");
  assert.equal(harness.getOperatorProfile().setupCompletedAt, "done");
});

test("a failed completion transaction leaves every completion signal unchanged", async () => {
  const harness = createHarness({ failCompletionTransaction: true });
  const started = await harness.coordinator.update({ expectedRevision: 0, startedAt: "start" });
  harness.events.length = 0;

  await assert.rejects(
    harness.coordinator.complete({ completedAt: "done", expectedRevision: started.revision }),
    /completion transaction failed/
  );

  assert.deepEqual(harness.events, ["completion-transaction"]);
  assert.equal(harness.getStored().completedAt, "");
  assert.equal(harness.getStored().revision, 1);
  assert.equal(harness.getOperatorProfile().setupCompletedAt, "");
});

test("a stale completion cannot stamp the operator profile", async () => {
  const harness = createHarness();
  await harness.coordinator.update({ expectedRevision: 0, startedAt: "start" });
  harness.events.length = 0;

  await assert.rejects(
    harness.coordinator.complete({ completedAt: "done", expectedRevision: 0 }),
    (error) => error instanceof SetupPreferencesConflictError
  );

  assert.deepEqual(harness.events, []);
  assert.equal(harness.getOperatorProfile().setupCompletedAt, "");
  assert.equal(harness.getStored().completedAt, "");
});
