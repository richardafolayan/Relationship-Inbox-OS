import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { resolveAppName, DEFAULT_APP_NAME, LEGACY_APP_NAME } from "../scripts/lib/branding.mjs";
import { APP_NAME as DMG_APP_NAME, stagedChildEnv } from "../scripts/build-macos-dmg.mjs";
import {
  packagingEnv,
  writeWindowsBrandingArtifacts
} from "../scripts/build-windows-installer.mjs";
import { composeDashboardStamp } from "../scripts/start-app.mjs";
import {
  buildInfoPlist,
  buildLauncherScript,
  APP_NAME as BUNDLE_APP_NAME
} from "../scripts/create-macos-app-bundle.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER_PATH = join(ROOT, "apps", "desktop", "launcher.cjs");
const UNINSTALL_SCRIPT = join(ROOT, "scripts", "uninstall-student-macos.sh");

// The default display name stays "Tovi" so existing installs/builds are
// unchanged when RIOS_APP_NAME is not set.
test("resolveAppName defaults to Tovi and can be overridden by RIOS_APP_NAME", () => {
  assert.equal(DEFAULT_APP_NAME, "Tovi");
  assert.equal(resolveAppName({}), "Tovi");
  assert.equal(resolveAppName({ RIOS_APP_NAME: "Aria" }), "Aria");
  // Whitespace-only is treated as unset.
  assert.equal(resolveAppName({ RIOS_APP_NAME: "   " }), "Tovi");
  assert.equal(resolveAppName({ RIOS_APP_NAME: "  Bloom  " }), "Bloom");
  assert.throws(() => resolveAppName({ RIOS_APP_NAME: "Bad/Name" }), /RIOS_APP_NAME/);
  assert.throws(() => resolveAppName({ RIOS_APP_NAME: "Bad\nName" }), /RIOS_APP_NAME/);
});

test("packaging modules resolve a custom name in a fresh process", () => {
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `
      const dmg = await import(${JSON.stringify(join(ROOT, "scripts/build-macos-dmg.mjs"))});
      const bundle = await import(${JSON.stringify(join(ROOT, "scripts/create-macos-app-bundle.mjs"))});
      process.stdout.write(JSON.stringify({ dmg: dmg.APP_NAME, bundle: bundle.APP_NAME }));
    `],
    { env: { ...process.env, RIOS_APP_NAME: "Lumen" }, encoding: "utf8" }
  );
  assert.deepEqual(JSON.parse(output), { dmg: "Lumen", bundle: "Lumen" });
});

// The legacy name is a fixed historical constant, never rebranded — it names
// the pre-rebrand install when telling users to remove it.
test("LEGACY_APP_NAME stays Relationship Inbox OS", () => {
  assert.equal(LEGACY_APP_NAME, "Relationship Inbox OS");
});

// With no override, every packaging surface resolves to the default.
test("packaging scripts resolve the default display name", () => {
  assert.equal(DMG_APP_NAME, "Tovi");
  assert.equal(BUNDLE_APP_NAME, "Tovi");
});

// The .app plist display fields follow the resolved name, while the bundle id
// stays pinned to the original identifier (TCC grants + data live under it).
test("Info.plist uses the display name but keeps the pinned bundle id", () => {
  const plist = buildInfoPlist({ version: "1.0.0" });
  assert.match(plist, new RegExp(`<key>CFBundleName</key>\\s*<string>${BUNDLE_APP_NAME}</string>`));
  assert.match(plist, new RegExp(`<key>CFBundleDisplayName</key>\\s*<string>${BUNDLE_APP_NAME}</string>`));
  // Bundle id is never derived from the display name.
  assert.match(plist, /<string>com\.relationshipinboxos\.app<\/string>/);
});

// The launcher wrapper's storage/log identity must not follow the display name.
test("launcher script keeps the pre-rebrand logs directory", () => {
  const launcher = buildLauncherScript({ appDir: "/tmp/app", nodeDir: "/tmp/node" });
  assert.match(launcher, /Library\/Logs\/RelationshipInboxOS/);
});

// The desktop launcher exposes an env-driven display name while pinning the
// storage folder + bundle id to the original identifiers.
test("desktop launcher APP_NAME is env-driven; storage identity is pinned", () => {
  delete require.cache[LAUNCHER_PATH];
  const prior = process.env.RIOS_APP_NAME;
  try {
    process.env.RIOS_APP_NAME = "Lumen";
    const launcher = require(LAUNCHER_PATH);
    assert.equal(launcher.APP_NAME, "Lumen");
    // Identity is fixed regardless of the display name.
    assert.equal(launcher.STORAGE_DIR_NAME, "Relationship Inbox OS");
    assert.equal(launcher.LOGS_DIR_NAME, "RelationshipInboxOS");
    assert.equal(launcher.APP_ID, "relationship-inbox-os");
    // The loading screen reflects the configured name.
    assert.match(launcher.loadingHtml(), /Lumen/);
  } finally {
    if (prior === undefined) delete process.env.RIOS_APP_NAME;
    else process.env.RIOS_APP_NAME = prior;
    delete require.cache[LAUNCHER_PATH];
  }
});

// Default path (no override) still yields Tovi in the launcher.
test("desktop launcher defaults to Tovi", () => {
  delete require.cache[LAUNCHER_PATH];
  const prior = process.env.RIOS_APP_NAME;
  try {
    delete process.env.RIOS_APP_NAME;
    const launcher = require(LAUNCHER_PATH);
    assert.equal(launcher.APP_NAME, "Tovi");
  } finally {
    if (prior !== undefined) process.env.RIOS_APP_NAME = prior;
    delete require.cache[LAUNCHER_PATH];
  }
});

test("desktop launcher reads a baked packaged app name", () => {
  const root = mkdtempSync(join(tmpdir(), "rios-branding-"));
  try {
    writeFileSync(join(root, "release.json"), JSON.stringify({ appName: "Lumen" }));
    assert.equal(require(LAUNCHER_PATH).configuredAppName(root), "Lumen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #887: staged macOS builds come from git archive (no .env). The resolved name
// must be injected into the child env so the dashboard inlines the same brand.
test("macOS staged child env carries the resolved RIOS_APP_NAME", () => {
  const env = stagedChildEnv("/tmp/node-runtime", "Lumen", { PATH: "/usr/bin", OTHER: "keep" });
  assert.equal(env.RIOS_APP_NAME, "Lumen");
  assert.equal(env.OTHER, "keep");
  assert.match(env.PATH, /^\/tmp\/node-runtime\/bin:/);
});

// #887: Windows packages must ship metadata the launcher/runner can read even
// when the name was only set via the host .env during the build.
test("Windows branding artifacts bake a non-default name from resolveAppName path", () => {
  const root = mkdtempSync(join(tmpdir(), "rios-win-branding-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const result = writeWindowsBrandingArtifacts(root, "Lumen");
    const release = JSON.parse(readFileSync(join(result.brandingDir, "release.json"), "utf8"));
    assert.equal(release.appName, "Lumen");
    assert.equal(release.version, "9.9.9");
    assert.equal(release.channel, "windows");
    assert.equal(
      readFileSync(join(result.brandingDir, "branding.env"), "utf8"),
      "RIOS_APP_NAME=Lumen\n"
    );
    assert.equal(packagingEnv("Lumen", { PATH: "/x" }).RIOS_APP_NAME, "Lumen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #887: renaming via RIOS_APP_NAME must bust the dashboard prepare stamp.
test("dashboard stamp includes the effective app name", () => {
  const withDefault = composeDashboardStamp({
    appVersion: "1.0.0",
    gitHead: "abc",
    nextVersion: "15.0.0",
    appName: "Tovi"
  });
  const withCustom = composeDashboardStamp({
    appVersion: "1.0.0",
    gitHead: "abc",
    nextVersion: "15.0.0",
    appName: "Lumen"
  });
  assert.equal(withDefault, "1.0.0|abc|15.0.0|Tovi");
  assert.equal(withCustom, "1.0.0|abc|15.0.0|Lumen");
  assert.notEqual(withDefault, withCustom);
});

// #887: uninstaller must discover a custom bundle when the name only lives in
// the installed .env (not exported in the calling shell).
test("uninstaller reads installed .env app name before building the bundle list", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rios-uninstall-"));
  const installDir = join(fixture, "install");
  const appBundleDir = join(fixture, "Applications");
  const customBundle = join(appBundleDir, "Lumen.app");
  try {
    mkdirSync(installDir, { recursive: true });
    mkdirSync(customBundle, { recursive: true });
    writeFileSync(join(installDir, ".env"), "RIOS_APP_NAME=Lumen\n");
    writeFileSync(
      join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", private: true })
    );
    // Skip PlistBuddy identity check by not reaching the delete path: --dry-run.
    const env = {
      ...process.env,
      HOME: fixture,
      RIOS_INSTALL_DIR: installDir,
      RIOS_APP_BUNDLE_DIR: appBundleDir,
      RIOS_APP_SUPPORT_DIR: join(fixture, "Application Support", "Relationship Inbox OS"),
      RIOS_LOG_DIR: join(fixture, "Logs"),
      RIOS_NODE_DIR: join(fixture, ".rios-node")
    };
    delete env.RIOS_APP_NAME;
    const output = execFileSync("bash", [UNINSTALL_SCRIPT, "--dry-run"], { env, encoding: "utf8" });
    assert.match(output, /Lumen uninstaller/);
    assert.match(output, /Mac app:\s+.*Lumen\.app/);
    assert.doesNotMatch(output, /Nothing to remove/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("uninstaller falls back to release.json appName when .env has no name", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rios-uninstall-release-"));
  const installDir = join(fixture, "install");
  const appBundleDir = join(fixture, "Applications");
  try {
    mkdirSync(installDir, { recursive: true });
    mkdirSync(join(appBundleDir, "Bloom.app"), { recursive: true });
    writeFileSync(join(installDir, "release.json"), JSON.stringify({ appName: "Bloom" }));
    writeFileSync(
      join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", private: true })
    );
    const env = {
      ...process.env,
      HOME: fixture,
      RIOS_INSTALL_DIR: installDir,
      RIOS_APP_BUNDLE_DIR: appBundleDir,
      RIOS_APP_SUPPORT_DIR: join(fixture, "Application Support", "Relationship Inbox OS"),
      RIOS_LOG_DIR: join(fixture, "Logs"),
      RIOS_NODE_DIR: join(fixture, ".rios-node")
    };
    delete env.RIOS_APP_NAME;
    const output = execFileSync("bash", [UNINSTALL_SCRIPT, "--dry-run"], { env, encoding: "utf8" });
    assert.match(output, /Bloom uninstaller/);
    assert.match(output, /Mac app:\s+.*Bloom\.app/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
