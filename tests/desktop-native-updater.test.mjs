import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  clearNativeUpdateRequest,
  nativeUpdaterConfiguration,
  readNativeUpdateRequest,
  signingCertificatePath
} = require("../apps/desktop/updater.cjs");

test("native updater only enables for a packaged signed macOS release", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-native-update-"));
  try {
    writeFileSync(join(root, "release.json"), JSON.stringify({
      updateMode: "squirrel-mac",
      updateFeedUrl: "https://example.com/latest-macos.json",
      signingCertificate: "../tovi-update-signing.cer"
    }));
    const enabled = nativeUpdaterConfiguration({ appDir: root, isPackaged: true, platform: "darwin" });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.feedUrl, "https://example.com/latest-macos.json");
    assert.equal(signingCertificatePath(root, enabled.release), join(root, "../tovi-update-signing.cer"));
    assert.equal(nativeUpdaterConfiguration({ appDir: root, isPackaged: false, platform: "darwin" }).enabled, false);
    assert.equal(nativeUpdaterConfiguration({ appDir: root, isPackaged: true, platform: "win32" }).enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native update requests remain retryable until explicitly cleared", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-native-request-"));
  try {
    const path = join(root, "request.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, JSON.stringify({ fromVersion: "1", toVersion: "2" }));
    assert.deepEqual(readNativeUpdateRequest(path), { fromVersion: "1", toVersion: "2" });
    assert.deepEqual(readNativeUpdateRequest(path), { fromVersion: "1", toVersion: "2" });
    clearNativeUpdateRequest(path);
    assert.equal(readNativeUpdateRequest(path), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
