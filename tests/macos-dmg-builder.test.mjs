import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  APP_NAME,
  BUNDLE_ID,
  REQUIRED_NODE_MAJOR,
  bundledNodeCandidate,
  macArchToNodeArch,
  macArchToOpenSslArch,
  parseArgs,
  planPaths,
  prunePackagedFootprint,
  requiresRuntimeEntitlements,
  squirrelManifest,
  stableDesignatedRequirement
} from "../scripts/build-macos-dmg.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("macOS DMG builder plans a branded app and DMG path", () => {
  const paths = planPaths({ out: "tmp-out", version: "1.2.3" });
  assert.equal(paths.appPath, resolve(ROOT, "tmp-out", `${APP_NAME}.app`));
  assert.equal(paths.dmgPath, resolve(ROOT, "tmp-out", "Tovi-1.2.3.dmg"));
  assert.match(paths.runtimeDir, new RegExp(`node-v${REQUIRED_NODE_MAJOR}-darwin-(arm64|x64)$`));
});

test("packaged app looks for the bundled Node runtime in Resources/runtime", () => {
  const appDir = "/Applications/Relationship Inbox OS.app/Contents/Resources/app";
  assert.equal(
    bundledNodeCandidate(appDir),
    "/Applications/Relationship Inbox OS.app/Contents/Resources/runtime/node/bin/node"
  );
});

test("packaged Node receives the runtime entitlements required by V8", () => {
  const appPath = "/tmp/Tovi.app";
  assert.equal(
    requiresRuntimeEntitlements(
      "/tmp/Tovi.app/Contents/Resources/runtime/node/bin/node",
      appPath
    ),
    true
  );
  assert.equal(
    requiresRuntimeEntitlements(
      "/tmp/Tovi.app/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      appPath
    ),
    false
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
  assert.equal(APP_NAME, "Tovi");
  assert.equal(BUNDLE_ID, "com.relationshipinboxos.desktop");
  assert.equal(REQUIRED_NODE_MAJOR, 22);
  assert.equal(macArchToNodeArch("arm64"), "arm64");
  assert.equal(macArchToNodeArch("x64"), "x64");
  assert.equal(macArchToOpenSslArch("arm64"), "darwin64-arm64-cc");
  assert.equal(macArchToOpenSslArch("x64"), "darwin64-x86_64-cc");
});

test("free signed updates use one stable certificate requirement", () => {
  const hash = "ab".repeat(20);
  assert.equal(
    stableDesignatedRequirement(hash),
    `designated => certificate leaf = H"${hash.toUpperCase()}" and identifier "${BUNDLE_ID}"`
  );
  assert.throws(() => stableDesignatedRequirement("bad"), /40 hex/);
});

test("macOS update manifest serves both the existing checker and Squirrel", () => {
  const manifest = squirrelManifest({
    version: "0.1.15-dev.99",
    build: "2026-07-16T09:00:00.000Z",
    commit: "abc123",
    channel: "dev",
    updateUrl: "https://example.com/Tovi.zip",
    sha256: "a".repeat(64),
    notes: ["A safe update."]
  });
  assert.equal(manifest.zipUrl, manifest.url);
  assert.equal(manifest.name, manifest.version);
  assert.equal(manifest.minimumInstallerVersion, "0.0.1");
  assert.equal(manifest.notes, "A safe update.");
  assert.equal(manifest.pub_date, manifest.build);
});

test("packaging prune keeps runtime files for the target macOS architecture", () => {
  const root = mkdtempSync(join(tmpdir(), "rios-package-prune-"));
  const appPath = join(root, "Relationship Inbox OS.app");
  const appResourceDir = join(appPath, "Contents", "Resources", "app");
  const packagedNodeDir = join(appPath, "Contents", "Resources", "runtime", "node");
  const touch = (relative, value = "x") => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return path;
  };

  try {
    for (const relative of [
      "Relationship Inbox OS.app/Contents/Resources/app/apps/dashboard/.next/cache/webpack.pack",
      "Relationship Inbox OS.app/Contents/Resources/app/node_modules/electron/dist/Electron.app/runtime",
      "Relationship Inbox OS.app/Contents/Resources/app/node_modules/@electron/get/package.json",
      "Relationship Inbox OS.app/Contents/Resources/app/node_modules/onnxruntime-web/dist/ort.js",
      "Relationship Inbox OS.app/Contents/Resources/app/tests/example.test.mjs",
      "Relationship Inbox OS.app/Contents/Resources/app/design-review-screenshots/old.png",
      "Relationship Inbox OS.app/Contents/Resources/default_app.asar",
      "Relationship Inbox OS.app/Contents/Resources/electron.icns",
      "Relationship Inbox OS.app/Contents/Resources/app/node_modules/onnxruntime-node/bin/napi-v3/linux/arm64/runtime.so",
      "Relationship Inbox OS.app/Contents/Resources/app/node_modules/onnxruntime-node/bin/napi-v3/darwin/x64/runtime.dylib",
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/include/node/openssl/archs/linux-aarch64/header.h",
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/include/node/openssl/archs/darwin64-x86_64-cc/header.h",
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/CHANGELOG.md",
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/README.md",
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/share/man/man1/node.1",
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/bin/corepack",
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/lib/node_modules/corepack/dist/corepack.js"
    ]) touch(relative);

    const armOnnx = touch(
      "Relationship Inbox OS.app/Contents/Resources/app/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/runtime.dylib",
      "arm-runtime"
    );
    const armOpenSsl = touch(
      "Relationship Inbox OS.app/Contents/Resources/runtime/node/include/node/openssl/archs/darwin64-arm64-cc/header.h",
      "arm-header"
    );
    const npm = touch("Relationship Inbox OS.app/Contents/Resources/runtime/node/bin/npm", "npm");
    const license = touch("Relationship Inbox OS.app/Contents/Resources/runtime/node/LICENSE", "license");
    const patchright = touch(
      "Relationship Inbox OS.app/Contents/Resources/app/node_modules/patchright/package.json",
      "{}"
    );

    // npm links .bin/electron INTO the electron package (a real symlink, not a
    // file). The prune removes the package dir first, leaving this link
    // dangling; existsSync follows links so it cannot see it, and a dangling
    // link in the bundle fails `codesign --verify --deep --strict`.
    const electronShim = join(appResourceDir, "node_modules/.bin/electron");
    mkdirSync(join(appResourceDir, "node_modules/.bin"), { recursive: true });
    symlinkSync("../electron/cli.js", electronShim);

    const result = prunePackagedFootprint({
      appPath,
      appResourceDir,
      packagedNodeDir,
      arch: "arm64"
    });

    assert.ok(result.removedBytes > 0);
    assert.equal(existsSync(armOnnx), true);
    assert.equal(existsSync(armOpenSsl), true);
    assert.equal(existsSync(npm), true);
    assert.equal(existsSync(license), true);
    assert.equal(existsSync(patchright), true);
    assert.equal(existsSync(join(appResourceDir, "node_modules/electron")), false);
    assert.throws(
      () => lstatSync(electronShim),
      /ENOENT/,
      "dangling .bin/electron symlink must be pruned, not left to break codesign"
    );
    assert.equal(existsSync(join(appResourceDir, "apps/dashboard/.next/cache")), false);
    assert.equal(existsSync(join(appResourceDir, "node_modules/onnxruntime-node/bin/napi-v3/linux")), false);
    assert.equal(
      existsSync(join(packagedNodeDir, "include/node/openssl/archs/darwin64-x86_64-cc")),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop icon is a local SVG with no remote assets", () => {
  const svg = readFileSync(join(ROOT, "apps/desktop/assets/icon.svg"), "utf8");
  assert.match(svg, /aria-label="App icon"/);
  assert.doesNotMatch(svg, /href="https?:\/\//);
  assert.match(svg, /#F7F2E8/);
  assert.match(svg, /#202A35/);
  assert.match(svg, /#D9902F/);
});
