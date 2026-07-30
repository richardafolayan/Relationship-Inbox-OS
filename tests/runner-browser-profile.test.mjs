import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Pull `dataDir` from the same module so the "default mirror root"
// assertion below uses the runtime-derived path (config.ts walks up from
// import.meta.url to the project root). Hardcoding "/Users/richard/
// IdeaProjects/relationship-inbox-os/data/profiles" silently breaks any
// time the suite runs from a git worktree, a CI checkout under a
// different parent, or a contributor's machine.
import {
  resolveBrowserProfileConfig,
  resolveConnectTimeoutMs,
  resolveDefaultChromeUserDataDir,
  dataDir
} from "../apps/runner/dist/config.js";
import { launchPersistentContextForPlatform } from "../apps/runner/dist/platforms/browser-launch.js";
import { preparePersonalProfileMirror } from "../apps/runner/dist/platforms/personal-profile-mirror.js";

function uniqueTempDir(prefix) {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("resolveDefaultChromeUserDataDir uses the host Chrome profile location", () => {
  assert.equal(
    resolveDefaultChromeUserDataDir({ HOME: "/Users/student" }, "darwin"),
    "/Users/student/Library/Application Support/Google/Chrome"
  );
  assert.equal(
    resolveDefaultChromeUserDataDir(
      { LOCALAPPDATA: "C:\\Users\\student\\AppData\\Local" },
      "win32"
    ),
    "C:\\Users\\student\\AppData\\Local\\Google\\Chrome\\User Data"
  );
  assert.equal(
    resolveDefaultChromeUserDataDir({ HOME: "/home/student" }, "linux"),
    "/home/student/.config/google-chrome"
  );
});

function basePersonalConfig(overrides = {}) {
  return {
    mode: "personal",
    fallbackBehavior: "error",
    personalProfileSyncMode: "smart",
    personalProfileMirrorRoot: "/tmp/mirror-root",
    personalChromeUserDataDir: "/Users/richard/Library/Application Support/Google/Chrome",
    personalChromeProfileDirectory: "Person 1",
    personalChromeProfileName: "Test Profile",
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
  // Computed the same way config.ts does (resolve(dataDir, "profiles"))
  // so the assertion holds inside worktrees / CI / other dev machines,
  // not just the maintainer's exact path.
  assert.equal(config.personalProfileMirrorRoot, resolve(dataDir, "profiles"));
  assert.equal(config.personalChromeUserDataDir, "/tmp/chrome-user-data-default");
  assert.equal(config.personalChromeProfileDirectory, "Person 1");
  // Defaults to empty — the app no longer ships a specific person's name.
  assert.equal(config.personalChromeProfileName, "");
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
      personalChromeProfileName: "Test Profile",
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

test("launchPersistentContextForPlatform uses installed Chrome with an isolated Windows profile", async () => {
  const calls = [];
  await launchPersistentContextForPlatform({
    platform: "LINKEDIN",
    launchPersistentContext: async (userDataDir, options) => {
      calls.push({ userDataDir, options });
      return { kind: "windows-isolated-context" };
    },
    isolatedProfileDir: "C:\\Users\\student\\AppData\\Roaming\\Tovi\\linkedin",
    headless: false,
    hostPlatform: "win32",
    browserProfile: {
      mode: "isolated",
      fallbackBehavior: "allow_isolated",
      personalProfileSyncMode: "smart",
      personalProfileMirrorRoot: "C:\\mirror",
      personalChromeUserDataDir: "C:\\Chrome",
      personalChromeProfileDirectory: "Default",
      personalChromeProfileName: "Default",
      personalChromeProfileResolutionStrategy: "directory_exact"
    }
  });

  assert.equal(calls[0]?.options.channel, "chrome");
});

test("launchPersistentContextForPlatform uses installed Chrome for an isolated Instagram profile", async () => {
  const calls = [];
  await launchPersistentContextForPlatform({
    platform: "INSTAGRAM",
    launchPersistentContext: async (userDataDir, options) => {
      calls.push({ userDataDir, options });
      return { kind: "instagram-isolated-context" };
    },
    isolatedProfileDir: "/tmp/isolated/instagram",
    headless: false,
    hostPlatform: "darwin",
    preferInstalledChrome: true,
    browserProfile: {
      mode: "isolated",
      fallbackBehavior: "allow_isolated",
      personalProfileSyncMode: "smart",
      personalProfileMirrorRoot: "/tmp/mirror",
      personalChromeUserDataDir: "/tmp/personal",
      personalChromeProfileDirectory: "Default",
      personalChromeProfileName: "Default",
      personalChromeProfileResolutionStrategy: "directory_exact"
    }
  });

  assert.equal(calls[0]?.options.channel, "chrome");
  assert.equal(calls[0]?.userDataDir, "/tmp/isolated/instagram");
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
  assert.ok(calls[0]?.options.ignoreDefaultArgs.includes("--password-store=basic"));
  assert.ok(calls[0]?.options.ignoreDefaultArgs.includes("--use-mock-keychain"));
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
  assert.equal(fallbackDetails?.personalChromeProfileName, "Test Profile");
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
    // The strict-mode error names the profile and explains why the runner
    // refused to fall back. Match on the leading "Couldn't launch your X
    // Chrome profile" phrase so this assertion does not break the next
    // time the trailing reason text is reworded.
    /Couldn't launch your .* Chrome profile/
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
