import assert from "node:assert/strict";
import test from "node:test";

import { defaultSettings } from "../packages/core/src/defaults.ts";
import {
  APP_SETTINGS_KEY,
  createSettingsStore,
  mergePersistedAppSettings
} from "../apps/runner/src/services/settings.ts";

test("a virgin install has no selected message source or AI processing", () => {
  assert.deepEqual(defaultSettings.enabledPlatforms, []);
  assert.equal(defaultSettings.aiEnabled, false);
});

test("a predecessor settings row keeps the compatibility defaults during upgrade", () => {
  const upgraded = mergePersistedAppSettings({
    scanIntervalSeconds: 90,
    automaticUpdates: true,
    amberHours: 8,
    redHours: 20,
    headless: false,
    maxMessagesPerThread: 25,
    demoMode: false,
    recentThreadSweepCount: 30,
    aiProvider: "openai"
  });

  assert.deepEqual(upgraded.settings.enabledPlatforms, ["LINKEDIN", "IMESSAGE"]);
  assert.equal(upgraded.settings.aiEnabled, true);
  assert.equal(upgraded.shouldPersistUpgrade, true);
});

test("explicit legacy opt-outs are never overwritten by compatibility migration", () => {
  const upgraded = mergePersistedAppSettings({
    ...defaultSettings,
    enabledPlatforms: [],
    aiEnabled: false
  });
  assert.deepEqual(upgraded.settings.enabledPlatforms, []);
  assert.equal(upgraded.settings.aiEnabled, false);
  assert.equal(upgraded.shouldPersistUpgrade, false);
});

test("corrupt explicit safety fields are repaired to safe values", () => {
  const upgraded = mergePersistedAppSettings({
    ...defaultSettings,
    enabledPlatforms: "LINKEDIN",
    aiEnabled: "yes"
  });
  assert.deepEqual(upgraded.settings.enabledPlatforms, []);
  assert.equal(upgraded.settings.aiEnabled, false);
  assert.equal(upgraded.shouldPersistUpgrade, true);
});

for (const invalid of [
  {},
  { garbage: true },
  { scanIntervalSeconds: "bad" }
]) {
  test(`schema-invalid settings ${JSON.stringify(invalid)} fail closed`, () => {
    const upgraded = mergePersistedAppSettings(invalid);
    assert.deepEqual(upgraded.settings.enabledPlatforms, []);
    assert.equal(upgraded.settings.aiEnabled, false);
    assert.equal(upgraded.shouldPersistUpgrade, true);
  });
}

test("loading a real predecessor row persists its upgraded compatibility fields", async () => {
  const rows = new Map([[APP_SETTINGS_KEY, {
    key: APP_SETTINGS_KEY,
    valueJson: JSON.stringify({
      scanIntervalSeconds: 90,
      automaticUpdates: true,
      amberHours: 8,
      redHours: 20,
      headless: false,
      maxMessagesPerThread: 25,
      demoMode: false,
      recentThreadSweepCount: 30,
      aiProvider: "openai"
    })
  }]]);
  const store = createSettingsStore({
    setting: {
      findUnique: async ({ where }) => rows.get(where.key) ?? null,
      upsert: async ({ where, update, create }) => {
        const current = rows.get(where.key);
        const next = current ? { ...current, ...update } : create;
        rows.set(where.key, next);
        return next;
      }
    }
  });

  const loaded = await store.getSettings();
  const upgradedRow = JSON.parse(rows.get(APP_SETTINGS_KEY).valueJson);
  assert.deepEqual(loaded.enabledPlatforms, ["LINKEDIN", "IMESSAGE"]);
  assert.equal(loaded.aiEnabled, true);
  assert.deepEqual(upgradedRow.enabledPlatforms, ["LINKEDIN", "IMESSAGE"]);
  assert.equal(upgradedRow.aiEnabled, true);
});

for (const [label, valueJson] of [
  ["malformed JSON", "{broken"],
  ["JSON null", "null"],
  ["a JSON array", "[]"]
]) {
  test(`loading ${label} fails closed and persists the safe repair`, async () => {
    const rows = new Map([[APP_SETTINGS_KEY, { key: APP_SETTINGS_KEY, valueJson }]]);
    const store = createSettingsStore({
      setting: {
        findUnique: async ({ where }) => rows.get(where.key) ?? null,
        upsert: async ({ where, update, create }) => {
          const current = rows.get(where.key);
          const next = current ? { ...current, ...update } : create;
          rows.set(where.key, next);
          return next;
        }
      }
    });

    const loaded = await store.getSettings();
    const repaired = JSON.parse(rows.get(APP_SETTINGS_KEY).valueJson);
    assert.deepEqual(loaded.enabledPlatforms, []);
    assert.equal(loaded.aiEnabled, false);
    assert.deepEqual(repaired.enabledPlatforms, []);
    assert.equal(repaired.aiEnabled, false);
  });
}
