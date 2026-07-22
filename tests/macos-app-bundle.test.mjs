import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_NAME,
  buildInfoPlist,
  buildLauncherScript,
  createMacosAppBundle
} from "../scripts/create-macos-app-bundle.mjs";

test("createMacosAppBundle writes a launchable .app structure", () => {
  const work = mkdtempSync(join(tmpdir(), "rios-app-bundle-"));
  try {
    const appDir = join(work, "RelationshipInboxOS");
    const outDir = join(work, "Applications");
    const nodeDir = join(work, ".rios-node");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "1.2.3" }, null, 2)
    );

    const result = createMacosAppBundle({ appDir, out: outDir, nodeDir });
    const bundle = join(outDir, `${APP_NAME}.app`);
    const executable = join(bundle, "Contents", "MacOS", APP_NAME);

    assert.equal(result.bundlePath, bundle);
    assert.ok(existsSync(join(bundle, "Contents", "Info.plist")), "Info.plist exists");
    assert.ok(existsSync(executable), "launcher executable exists");
    assert.match(readFileSync(join(bundle, "Contents", "Resources", "app-path.txt"), "utf8"), /RelationshipInboxOS\n$/);
    assert.match(readFileSync(join(bundle, "Contents", "Info.plist"), "utf8"), /<string>1\.2\.3<\/string>/);
    assert.match(readFileSync(executable, "utf8"), new RegExp(escapeRegExp(appDir)));
    assert.match(readFileSync(executable, "utf8"), new RegExp(escapeRegExp(nodeDir)));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("Info.plist carries a stable bundle identity and truthful focus-note Messages copy", () => {
  const plist = buildInfoPlist({ version: "2.0.0" });
  assert.match(plist, /<string>com\.relationshipinboxos\.app<\/string>/);
  assert.match(plist, /<key>NSAppleEventsUsageDescription<\/key>/);
  assert.match(plist, /when you press Send or enable a focus note for one focus window\./);
});

test("launcher opens an already-running dashboard instead of spawning another app", () => {
  const launcher = buildLauncherScript({ appDir: "/tmp/RelationshipInboxOS", nodeDir: "/tmp/node" });
  assert.match(launcher, /curl -fsS --max-time 2 "\$DASHBOARD_URL"/);
  assert.match(launcher, /open "\$DASHBOARD_URL"/);
  assert.match(launcher, /scripts\/start-student\.mjs/);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
