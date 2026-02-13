import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrowserProfileConfig, resolveConnectTimeoutMs } from "../apps/runner/dist/config.js";
import { launchPersistentContextForPlatform } from "../apps/runner/dist/platforms/browser-launch.js";
import { preparePersonalProfileMirror } from "../apps/runner/dist/platforms/personal-profile-mirror.js";

function uniqueTempDir(prefix) {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function basePersonalConfig(overrides = {}) {
  return {
    mode: "personal",
    fallbackBehavior: "error",
    personalProfileSyncMode: "smart",
    personalProfileMirrorRoot: "/tmp/mirror-root",
    personalChromeUserDataDir: "/Users/richard/Library/Application Support/Google/Chrome",
    personalChromeProfileDirectory: "Person 1",
    personalChromeProfileName: "Richard Afolayan",
    personalChromeProfileResolutionStrategy: "directory_exact",
    ...overrides
  };
}

test("resolveBrowserProfileConfig defaults to isolated mode and Person 1 profile", () => {
  const config = resolveBrowserProfileConfig({
    HOME: "/Users/richard",
    PERSONAL_CHROME_USER_DATA_DIR: "/tmp/chrome-user-data-default"
  });

  assert.equal(config.mode, "isolated");
  assert.equal(config.fallbackBehavior, "allow_isolated");
  assert.equal(config.personalProfileSyncMode, "smart");
  assert.equal(config.personalProfileMirrorRoot, "/Users/richard/IdeaProjects/relationship-inbox-os/data/profiles");
  assert.equal(config.personalChromeUserDataDir, "/tmp/chrome-user-data-default");
  assert.equal(config.personalChromeProfileDirectory, "Person 1");
  assert.equal(config.personalChromeProfileName, "Richard Afolayan");
  assert.equal(config.personalChromeProfileResolutionStrategy, "local_state_missing");
});

test("resolveBrowserProfileConfig accepts explicit personal-profile env values", () => {
  const config = resolveBrowserProfileConfig({
    HOME: "/Users/someone",
    BROWSER_PROFILE_MODE: "personal",
    PERSONAL_PROFILE_FALLBACK: "error",
    PERSONAL_PROFILE_SYNC_MODE: "always",
    PERSONAL_PROFILE_MIRROR_ROOT: "/tmp/personal-mirror-root",
    PERSONAL_CHROME_USER_DATA_DIR: "/tmp/chrome-user-data",
    PERSONAL_CHROME_PROFILE_DIRECTORY: "Profile 7",
    PERSONAL_CHROME_PROFILE_NAME: "Someone Else"
  });

  assert.equal(config.mode, "personal");
  assert.equal(config.fallbackBehavior, "error");
  assert.equal(config.personalProfileSyncMode, "always");
  assert.equal(config.personalProfileMirrorRoot, "/tmp/personal-mirror-root");
  assert.equal(config.personalChromeUserDataDir, "/tmp/chrome-user-data");
  assert.equal(config.personalChromeProfileDirectory, "Profile 7");
  assert.equal(config.personalChromeProfileName, "Someone Else");
  assert.equal(config.personalChromeProfileResolutionStrategy, "local_state_missing");
});

test("resolveBrowserProfileConfig defaults to strict fallback in personal mode", () => {
  const config = resolveBrowserProfileConfig({
    HOME: "/Users/richard",
    BROWSER_PROFILE_MODE: "personal",
    PERSONAL_CHROME_USER_DATA_DIR: "/tmp/chrome-user-data-personal"
  });

  assert.equal(config.mode, "personal");
  assert.equal(config.fallbackBehavior, "error");
});

test("resolveBrowserProfileConfig maps display name to actual Chrome profile directory", () => {
  const base = uniqueTempDir("chrome-profile-map");
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Person 1" },
          "Profile 3": { name: "Work" }
        }
      }
    })
  );

  const config = resolveBrowserProfileConfig({
    HOME: "/Users/richard",
    BROWSER_PROFILE_MODE: "personal",
    PERSONAL_CHROME_USER_DATA_DIR: base,
    PERSONAL_CHROME_PROFILE_DIRECTORY: "Person 1"
  });

  assert.equal(config.personalChromeProfileDirectory, "Default");
  assert.equal(config.personalChromeProfileResolutionStrategy, "name_exact");
});

test("resolveBrowserProfileConfig prefers directory match over display name match", () => {
  const base = uniqueTempDir("chrome-profile-directory-first");
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Person 1" },
          "Person 1": { name: "Your Chrome" }
        }
      }
    })
  );

  const config = resolveBrowserProfileConfig({
    HOME: "/Users/richard",
    BROWSER_PROFILE_MODE: "personal",
    PERSONAL_CHROME_USER_DATA_DIR: base,
    PERSONAL_CHROME_PROFILE_DIRECTORY: "Person 1"
  });

  assert.equal(config.personalChromeProfileDirectory, "Person 1");
  assert.equal(config.personalChromeProfileResolutionStrategy, "directory_exact");
});

test("resolveConnectTimeoutMs uses 90s for personal mode and 25s for isolated mode by default", () => {
  assert.equal(resolveConnectTimeoutMs("personal", {}), 90000);
  assert.equal(resolveConnectTimeoutMs("isolated", {}), 25000);
});

test("resolveConnectTimeoutMs uses environment overrides when provided", () => {
  const env = {
    CONNECT_OPERATION_TIMEOUT_MS: "11111",
    CONNECT_OPERATION_TIMEOUT_MS_PERSONAL: "22222"
  };

  assert.equal(resolveConnectTimeoutMs("isolated", env), 11111);
  assert.equal(resolveConnectTimeoutMs("personal", env), 22222);
});

test("launchPersistentContextForPlatform keeps isolated launch behaviour unchanged", async () => {
  const calls = [];
  const context = { kind: "isolated-context" };

  const launched = await launchPersistentContextForPlatform({
    platform: "LINKEDIN",
    launchPersistentContext: async (userDataDir, options) => {
      calls.push({ userDataDir, options });
      return context;
    },
    isolatedProfileDir: "/tmp/isolated/linkedin",
    headless: false,
    browserProfile: {
      mode: "isolated",
      fallbackBehavior: "allow_isolated",
      personalProfileSyncMode: "smart",
      personalProfileMirrorRoot: "/tmp/mirror-root",
      personalChromeUserDataDir: "/tmp/personal",
      personalChromeProfileDirectory: "Person 1",
      personalChromeProfileName: "Richard Afolayan",
      personalChromeProfileResolutionStrategy: "directory_exact"
    },
    args: ["--disable-blink-features=AutomationControlled"]
  });

  assert.equal(launched, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.userDataDir, "/tmp/isolated/linkedin");
  assert.equal(calls[0]?.options.channel, undefined);
  assert.deepEqual(calls[0]?.options.args, ["--disable-blink-features=AutomationControlled"]);
});

test("launchPersistentContextForPlatform uses mirrored target directory for personal launch", async () => {
  const calls = [];
  const context = { kind: "personal-context" };
  const prepared = [];

  const launched = await launchPersistentContextForPlatform({
    platform: "LINKEDIN",
    launchPersistentContext: async (userDataDir, options) => {
      calls.push({ userDataDir, options });
      return context;
    },
    isolatedProfileDir: "/tmp/isolated/linkedin",
    headless: false,
    browserProfile: basePersonalConfig(),
    preparePersonalProfileMirror: async (input) => {
      prepared.push(input);
      return {
        syncPerformed: true,
        syncReason: "target_missing",
        sourceUserDataDir: input.sourceUserDataDir,
        targetUserDataDir: "/tmp/isolated/linkedin",
        profileDirectory: input.profileDirectory,
        sourceProfileDir: "/tmp/source/Person 1",
        targetProfileDir: "/tmp/isolated/linkedin/Person 1",
        sourceMarkerMtimeMs: 100,
        lastMirroredSourceMarkerMtimeMs: undefined,
        durationMs: 10
      };
    }
  });

  assert.equal(launched, context);
  assert.equal(prepared.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.userDataDir, "/tmp/isolated/linkedin");
  assert.equal(calls[0]?.options.channel, "chrome");
  assert.ok(calls[0]?.options.args.includes("--profile-directory=Person 1"));
});

test("launchPersistentContextForPlatform falls back to isolated profile when personal launch fails", async () => {
  const calls = [];
  const context = { kind: "fallback-context" };
  let fallbackDetails;

  const launched = await launchPersistentContextForPlatform({
    platform: "INSTAGRAM",
    launchPersistentContext: async (userDataDir, options) => {
      calls.push({ userDataDir, options });
      if (calls.length === 1) {
        throw new Error("Profile lock in use");
      }
      return context;
    },
    isolatedProfileDir: "/tmp/isolated/instagram",
    headless: true,
    browserProfile: basePersonalConfig({
      fallbackBehavior: "allow_isolated"
    }),
    preparePersonalProfileMirror: async (input) => {
      return {
        syncPerformed: false,
        syncReason: "source_not_newer",
        sourceUserDataDir: input.sourceUserDataDir,
        targetUserDataDir: input.targetUserDataDir,
        profileDirectory: input.profileDirectory,
        sourceProfileDir: "/tmp/source/Person 1",
        targetProfileDir: "/tmp/isolated/instagram/Person 1",
        sourceMarkerMtimeMs: 100,
        lastMirroredSourceMarkerMtimeMs: 100,
        durationMs: 1
      };
    },
    onPersonalProfileFallback: (details) => {
      fallbackDetails = details;
    }
  });

  assert.equal(launched, context);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.userDataDir, "/tmp/isolated/instagram");
  assert.equal(calls[0]?.options.channel, "chrome");
  assert.ok(calls[0]?.options.args.includes("--profile-directory=Person 1"));
  assert.equal(calls[1]?.userDataDir, "/tmp/isolated/instagram");
  assert.equal(calls[1]?.options.channel, undefined);
  assert.equal(fallbackDetails?.platform, "INSTAGRAM");
  assert.equal(fallbackDetails?.personalChromeLaunchUserDataDir, "/tmp/isolated/instagram");
  assert.equal(fallbackDetails?.personalChromeProfileDirectory, "Person 1");
  assert.equal(fallbackDetails?.personalChromeProfileName, "Richard Afolayan");
  assert.equal(fallbackDetails?.personalChromeProfileResolutionStrategy, "directory_exact");
  assert.equal(fallbackDetails?.fallbackProfileDir, "/tmp/isolated/instagram");
  assert.match(fallbackDetails?.reason ?? "", /Profile lock in use/);
});

test("launchPersistentContextForPlatform throws instead of falling back when strict personal mode is enabled", async () => {
  const calls = [];

  await assert.rejects(
    () =>
      launchPersistentContextForPlatform({
        platform: "LINKEDIN",
        launchPersistentContext: async (userDataDir, options) => {
          calls.push({ userDataDir, options });
          throw new Error("Profile lock in use");
        },
        isolatedProfileDir: "/tmp/isolated/linkedin",
        headless: false,
        browserProfile: basePersonalConfig(),
        preparePersonalProfileMirror: async (input) => ({
          syncPerformed: false,
          syncReason: "source_not_newer",
          sourceUserDataDir: input.sourceUserDataDir,
          targetUserDataDir: input.targetUserDataDir,
          profileDirectory: input.profileDirectory,
          sourceProfileDir: "/tmp/source/Person 1",
          targetProfileDir: "/tmp/isolated/linkedin/Person 1",
          sourceMarkerMtimeMs: 100,
          lastMirroredSourceMarkerMtimeMs: 100,
          durationMs: 1
        })
      }),
    /Unable to use personal Chrome profile/
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.userDataDir, "/tmp/isolated/linkedin");
});

test("preparePersonalProfileMirror smart mode skips when source has not changed", async () => {
  const sourceUserDataDir = uniqueTempDir("mirror-source");
  const targetUserDataDir = uniqueTempDir("mirror-target");
  mkdirSync(join(sourceUserDataDir, "Person 1"), { recursive: true });
  writeFileSync(join(sourceUserDataDir, "Local State"), '{"state":"one"}');
  writeFileSync(join(sourceUserDataDir, "Person 1", "Cookies"), "cookie-data");

  const first = await preparePersonalProfileMirror({
    sourceUserDataDir,
    targetUserDataDir,
    profileDirectory: "Person 1",
    syncMode: "smart"
  });
  const second = await preparePersonalProfileMirror({
    sourceUserDataDir,
    targetUserDataDir,
    profileDirectory: "Person 1",
    syncMode: "smart"
  });

  assert.equal(first.syncPerformed, true);
  assert.equal(first.syncReason, "target_missing");
  assert.equal(second.syncPerformed, false);
  assert.equal(second.syncReason, "source_not_newer");
});

test("preparePersonalProfileMirror smart mode syncs when source marker is newer", async () => {
  const sourceUserDataDir = uniqueTempDir("mirror-source-newer");
  const targetUserDataDir = uniqueTempDir("mirror-target-newer");
  mkdirSync(join(sourceUserDataDir, "Person 1"), { recursive: true });
  writeFileSync(join(sourceUserDataDir, "Local State"), '{"state":"one"}');
  writeFileSync(join(sourceUserDataDir, "Person 1", "Cookies"), "cookie-data");

  await preparePersonalProfileMirror({
    sourceUserDataDir,
    targetUserDataDir,
    profileDirectory: "Person 1",
    syncMode: "smart"
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(join(sourceUserDataDir, "Local State"), '{"state":"two"}');

  const second = await preparePersonalProfileMirror({
    sourceUserDataDir,
    targetUserDataDir,
    profileDirectory: "Person 1",
    syncMode: "smart"
  });

  assert.equal(second.syncPerformed, true);
  assert.equal(second.syncReason, "source_newer");
});

test("preparePersonalProfileMirror excludes lock and cache artifacts", async () => {
  const sourceUserDataDir = uniqueTempDir("mirror-source-exclusions");
  const targetUserDataDir = uniqueTempDir("mirror-target-exclusions");
  mkdirSync(join(sourceUserDataDir, "Person 1", "Code Cache"), { recursive: true });
  writeFileSync(join(sourceUserDataDir, "Local State"), '{"state":"one"}');
  writeFileSync(join(sourceUserDataDir, "Person 1", "Cookies"), "cookie-data");
  writeFileSync(join(sourceUserDataDir, "Person 1", "SingletonLock"), "lock");
  writeFileSync(join(sourceUserDataDir, "Person 1", "Code Cache", "data"), "cache");

  await preparePersonalProfileMirror({
    sourceUserDataDir,
    targetUserDataDir,
    profileDirectory: "Person 1",
    syncMode: "always"
  });

  assert.equal(existsSync(join(targetUserDataDir, "Person 1", "Cookies")), true);
  assert.equal(existsSync(join(targetUserDataDir, "Person 1", "SingletonLock")), false);
  assert.equal(existsSync(join(targetUserDataDir, "Person 1", "Code Cache")), false);
});
