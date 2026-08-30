import test from "node:test";
import assert from "node:assert/strict";

import { createSetupPreferencesCoordinator } from "../apps/runner/dist/services/setup-preferences-coordinator.js";
import {
  createSetupPreferencesStore,
  SetupPreferencesConflictError
} from "../apps/runner/dist/services/setup-preferences.js";

function createHarness({ failSettings = false } = {}) {
  const events = [];
  let stored = null;
  let settings = {
    enabledPlatforms: ["LINKEDIN"],
    aiEnabled: false,
    automaticUpdates: true
  };
  let runtimeWhatsapp = null;
  const store = createSetupPreferencesStore({
    read: async () => stored,
    write: async (next) => {
      events.push("preferences");
      stored = structuredClone(next);
    }
  });
  const coordinator = createSetupPreferencesCoordinator({
    availablePlatforms: ["LINKEDIN", "INSTAGRAM", "WHATSAPP"],
    getSettings: async () => structuredClone(settings),
    updateSettings: async (partial) => {
      events.push("settings");
      if (failSettings) throw new Error("settings failed");
      settings = { ...settings, ...partial };
    },
    mutatePreferences: store.mutate,
    persistWhatsAppEnabled: (enabled) => {
      events.push(`environment:${enabled}`);
    },
    applyWhatsAppEnabled: (enabled) => {
      events.push(`runtime:${enabled}`);
      runtimeWhatsapp = enabled;
    }
  });
  return {
    coordinator,
    events,
    getStored: () => stored,
    getSettings: () => settings,
    getRuntimeWhatsapp: () => runtimeWhatsapp
  };
}

test("setup coordinator commits environment and settings before preferences become authoritative", async () => {
  const harness = createHarness();
  const preferences = await harness.coordinator.update({
    expectedRevision: 0,
    startedAt: "start",
    selectedPlatforms: ["WHATSAPP"],
    aiEnabled: true
  });

  assert.deepEqual(harness.events, [
    "environment:true",
    "settings",
    "preferences",
    "runtime:true"
  ]);
  assert.equal(preferences.revision, 1);
  assert.deepEqual(harness.getSettings().enabledPlatforms, ["WHATSAPP"]);
  assert.equal(harness.getSettings().aiEnabled, true);
  assert.equal(harness.getRuntimeWhatsapp(), true);
});

test("a failed mirrored settings write cannot advance setup preferences", async () => {
  const harness = createHarness({ failSettings: true });

  await assert.rejects(
    harness.coordinator.update({
      expectedRevision: 0,
      startedAt: "start",
      selectedPlatforms: ["WHATSAPP"]
    }),
    /settings failed/
  );

  assert.deepEqual(harness.events, ["environment:true", "settings"]);
  assert.equal(harness.getStored(), null);
  assert.equal(harness.getRuntimeWhatsapp(), null);
});

test("a stale setup request is rejected before environment or settings side effects", async () => {
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
