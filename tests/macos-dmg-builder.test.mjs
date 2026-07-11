import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  APP_NAME,
  BUNDLE_ID,
  REQUIRED_NODE_MAJOR,
  bundledNodeCandidate,
  macArchToNodeArch,
  parseArgs,
  planPaths
} from "../scripts/build-macos-dmg.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("macOS DMG builder plans a branded app and DMG path", () => {
  const paths = planPaths({ out: "tmp-out", version: "1.2.3" });
  assert.equal(paths.appPath, resolve(ROOT, "tmp-out", `${APP_NAME}.app`));
  assert.equal(paths.dmgPath, resolve(ROOT, "tmp-out", "Relationship-Inbox-OS-1.2.3.dmg"));
  assert.match(paths.runtimeDir, new RegExp(`node-v${REQUIRED_NODE_MAJOR}-darwin-(arm64|x64)$`));
});

test("packaged app looks for the bundled Node runtime in Resources/runtime", () => {
  const appDir = "/Applications/Relationship Inbox OS.app/Contents/Resources/app";
  assert.equal(
    bundledNodeCandidate(appDir),
    "/Applications/Relationship Inbox OS.app/Contents/Resources/runtime/node/bin/node"
  );
});

test("DMG args expose release-safe switches", () => {
  assert.deepEqual(parseArgs([
    "--out", "dist",
    "--ref", "abc123",
    "--node-dir", "/tmp/node",
    "--skip-install",
    "--skip-build",
    "--skip-dmg",
    "--no-sign",
    "--dry-run"
  ]), {
    notes: [],
    out: "dist",
    ref: "abc123",
    nodeDir: "/tmp/node",
    skipInstall: true,
    skipBuild: true,
    skipDmg: true,
    noSign: true,
    dryRun: true
  });
});

test("builder constants carry the desktop identity", () => {
  assert.equal(APP_NAME, "Relationship Inbox OS");
  assert.equal(BUNDLE_ID, "com.relationshipinboxos.desktop");
  assert.equal(REQUIRED_NODE_MAJOR, 22);
  assert.equal(macArchToNodeArch("arm64"), "arm64");
  assert.equal(macArchToNodeArch("x64"), "x64");
});

test("desktop icon is a local SVG with no remote assets", () => {
  const svg = readFileSync(join(ROOT, "apps/desktop/assets/icon.svg"), "utf8");
  assert.match(svg, /Relationship Inbox OS/);
  assert.doesNotMatch(svg, /href="https?:\/\//);
  assert.match(svg, /#F7F2E8/);
  assert.match(svg, /#202A35/);
  assert.match(svg, /#D9902F/);
});
