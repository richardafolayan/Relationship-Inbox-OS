import test from "node:test";
import assert from "node:assert/strict";
import { createAdapters } from "../apps/runner/dist/services/platform-factory.js";

const settingsStore = {
  getSelectorOverrides: async () => ({}),
  getSettings: async () => ({ headless: true })
};

function availability(instagram) {
  return {
    LINKEDIN: false,
    INSTAGRAM: instagram,
    IMESSAGE: false,
    WHATSAPP: false,
    GOOGLE_MESSAGES: false
  };
}

test("factory registers Instagram only when the environment enables it", () => {
  const enabled = createAdapters({
    settingsStore,
    platformAvailability: availability(true)
  });
  const disabled = createAdapters({
    settingsStore,
    platformAvailability: availability(false)
  });

  assert.equal(enabled.adapters.INSTAGRAM?.platform, "INSTAGRAM");
  assert.equal(disabled.adapters.INSTAGRAM, undefined);
});

test("Instagram receives an isolated persistent profile route", () => {
  const factory = createAdapters({
    settingsStore,
    platformAvailability: availability(true)
  });
  const instagram = factory.resolvePlatformSession("INSTAGRAM");
  const reconnect = factory.resolvePlatformSession("INSTAGRAM");
  const linkedin = factory.resolvePlatformSession("LINKEDIN");

  assert.equal(instagram.personKey, "instagram");
  assert.match(instagram.profileDir, /profiles[\\/]instagram$/);
  assert.equal(reconnect.sessionManager, instagram.sessionManager);
  assert.equal(reconnect.personKey, instagram.personKey);
  assert.equal(reconnect.profileDir, instagram.profileDir);
  assert.notEqual(instagram.sessionManager, linkedin.sessionManager);
  assert.notEqual(instagram.profileDir, linkedin.profileDir);
  assert.equal(instagram.sessionManager.deps.browserProfile.mode, "isolated");
  assert.equal(instagram.sessionManager.deps.browserProfile.fallbackBehavior, "error");
  assert.equal(instagram.sessionManager.deps.preferInstalledChrome, true);
});
