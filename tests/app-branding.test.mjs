import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { resolveAppName, DEFAULT_APP_NAME, LEGACY_APP_NAME } from "../scripts/lib/branding.mjs";
import { APP_NAME as DMG_APP_NAME } from "../scripts/build-macos-dmg.mjs";
import {
  buildInfoPlist,
  buildLauncherScript,
  APP_NAME as BUNDLE_APP_NAME
} from "../scripts/create-macos-app-bundle.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER_PATH = join(ROOT, "apps", "desktop", "launcher.cjs");

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
