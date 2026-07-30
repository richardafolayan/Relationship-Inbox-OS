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

test("Instagram receives a dedicated persistent profile route", () => {
  const factory = createAdapters({
    settingsStore,
    platformAvailability: availability(true),
    instagramBrowserProfile: {
      mode: "personal",
      fallbackBehavior: "allow_isolated",
      personalChromeUserDataDir: "/trusted/chrome",
      personalChromeProfileDirectory: "Profile 7",
      personalChromeProfileName: "Trusted",
      personalChromeProfileResolutionStrategy: "name_exact",
      personalProfileSyncMode: "smart",
      personalProfileMirrorRoot: "/managed/mirrors"
    }
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
  assert.equal(instagram.sessionManager.deps.browserProfile.mode, "personal");
  assert.equal(instagram.sessionManager.deps.browserProfile.personalChromeProfileDirectory, "Profile 7");
  assert.equal(instagram.sessionManager.deps.browserProfile.personalChromeProfileName, "Trusted");
  assert.equal(instagram.sessionManager.deps.browserProfile.fallbackBehavior, "error");
  assert.equal(instagram.sessionManager.deps.preferInstalledChrome, true);
  assert.deepEqual(factory.adapters.INSTAGRAM.instagramDeps.personalProfile, {
    sourceUserDataDir: "/trusted/chrome",
    profileDirectory: "Profile 7"
  });
});

test("Instagram keeps isolated mode when personal profile mode is not configured", () => {
  const factory = createAdapters({
    settingsStore,
    platformAvailability: availability(true)
  });

  assert.equal(
    factory.resolvePlatformSession("INSTAGRAM").sessionManager.deps.browserProfile.mode,
    "isolated"
  );
});
