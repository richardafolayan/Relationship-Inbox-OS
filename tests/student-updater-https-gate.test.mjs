import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedRemoteUpdateUrl } from "../scripts/lib/release-manifest.mjs";

// Regression for #553: the self-updater auto-installs (post-swap npm scripts
// run) and the manifest sha256 is corruption-only, not tamper-proof. The
// download URL must be https (remote http would let a MITM swap the zip +
// sha256), except loopback http for local test servers / same-machine mirrors.
test("https remote URLs are allowed", () => {
  assert.equal(isAllowedRemoteUpdateUrl("https://www.dropbox.com/x/latest.json?dl=1"), true);
  assert.equal(isAllowedRemoteUpdateUrl("https://example.com/app.zip"), true);
});
test("remote http URLs are rejected (MITM surface)", () => {
  assert.equal(isAllowedRemoteUpdateUrl("http://www.dropbox.com/x/app.zip?dl=1"), false);
  assert.equal(isAllowedRemoteUpdateUrl("http://evil.example.com/app.zip"), false);
});
test("loopback http is allowed (local test server / mirror)", () => {
  assert.equal(isAllowedRemoteUpdateUrl("http://localhost:8080/latest.json"), true);
  assert.equal(isAllowedRemoteUpdateUrl("http://127.0.0.1:8080/app.zip"), true);
});
test("non-http(s) schemes and junk are rejected", () => {
  assert.equal(isAllowedRemoteUpdateUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedRemoteUpdateUrl("ftp://x/y"), false);
  assert.equal(isAllowedRemoteUpdateUrl("not a url"), false);
  assert.equal(isAllowedRemoteUpdateUrl(undefined), false);
});
