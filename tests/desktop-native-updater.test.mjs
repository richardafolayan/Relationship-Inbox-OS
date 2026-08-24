import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  acknowledgeNativeUpdateRequest,
  beginNativeReplacement,
  claimNativeUpdateRequest,
  createNativeUpdateLifecycle,
  nativeUpdaterConfiguration,
  signingCertificatePath
} = require("../apps/desktop/updater.cjs");

async function within(promise, message, timeoutMs = 500) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("native replacement keeps its durable claim when quitAndInstall throws", () => {
  let acknowledged = false;
  assert.throws(
    () => beginNativeReplacement(
      { quitAndInstall() { throw new Error("replacement refused"); } },
      { claimPath: "claim", livePath: "live" },
      () => {
        acknowledged = true;
        return true;
      }
    ),
    /replacement refused/
  );
  assert.equal(acknowledged, false);
});

test("native replacement acknowledges only after quitAndInstall starts", () => {
  const calls = [];
  assert.equal(
    beginNativeReplacement(
      { quitAndInstall() { calls.push("replace"); } },
      { claimPath: "claim", livePath: "live" },
      () => {
        calls.push("acknowledge");
        return true;
      }
    ),
    true
  );
  assert.deepEqual(calls, ["replace", "acknowledge"]);
});

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

test("native update requests remain retryable until the desktop acknowledges its claim", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-native-request-"));
  try {
    const path = join(root, "request.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, JSON.stringify({ fromVersion: "1", toVersion: "2" }));
    const claim = claimNativeUpdateRequest(path);
    assert.deepEqual(claim.request, { fromVersion: "1", toVersion: "2" });
    assert.equal(existsSync(path), false);
    assert.deepEqual(claimNativeUpdateRequest(path).request, claim.request, "a crash claim must remain retryable");
    assert.equal(acknowledgeNativeUpdateRequest(claim), true);
    assert.equal(claimNativeUpdateRequest(path), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed native request is quarantined instead of blocking retries", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-native-invalid-request-"));
  try {
    const path = join(root, "request.json");
    writeFileSync(path, "{not-json");
    assert.equal(claimNativeUpdateRequest(path), null);
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(root).some((entry) => entry.startsWith("request.json.invalid-")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledging request A cannot remove a newly published request B", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-native-claim-race-"));
  const path = join(root, "request.json");
  try {
    writeFileSync(path, JSON.stringify({ toVersion: "A" }));
    const claimA = claimNativeUpdateRequest(path);
    writeFileSync(path, JSON.stringify({ toVersion: "B" }));
    assert.equal(acknowledgeNativeUpdateRequest(claimA), true);
    const claimB = claimNativeUpdateRequest(path);
    assert.equal(claimB.request.toVersion, "B");
    acknowledgeNativeUpdateRequest(claimB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantining malformed request A cannot move a newly published request B", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-native-invalid-race-"));
  const path = join(root, "request.json");
  try {
    writeFileSync(path, "{not-json");
    const claimA = claimNativeUpdateRequest(path, {
      afterClaim() {
        writeFileSync(path, JSON.stringify({ toVersion: "B" }));
      }
    });
    assert.equal(claimA, null);
    assert.equal(existsSync(path), true);
    const claimB = claimNativeUpdateRequest(path);
    assert.equal(claimB.request.toVersion, "B");
    acknowledgeNativeUpdateRequest(claimB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("download shutdown failure pauses native update polling until process restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-native-shutdown-failure-"));
  const path = join(root, "request.json");
  const request = { fromVersion: "1", toVersion: "2" };
  const autoUpdater = new EventEmitter();
  let checks = 0;
  let resolveChecked;
  let resolveFailed;
  let resolveStopping;
  let rejectShutdown;
  const checked = new Promise((resolve) => { resolveChecked = resolve; });
  const failed = new Promise((resolve) => { resolveFailed = resolve; });
  const stopping = new Promise((resolve) => { resolveStopping = resolve; });
  autoUpdater.checkForUpdates = () => {
    checks += 1;
    resolveChecked();
  };
  autoUpdater.quitAndInstall = () => assert.fail("replacement must not start before verified shutdown");
  writeFileSync(path, JSON.stringify(request));

  const lifecycle = createNativeUpdateLifecycle({
    autoUpdater,
    requestPath: path,
    intervalMs: 5,
    host: {
      beginShutdown() {},
      stopRuntime() {
        resolveStopping();
        return new Promise((_, reject) => { rejectShutdown = reject; });
      },
      markReplacementReady() {},
      recoverReplacementFailure() { assert.fail("replacement did not start"); },
      recoverShutdownFailure(error) {
        assert.match(error.message, /runtime still active/);
        resolveFailed();
      },
      log() {}
    }
  });

  try {
    lifecycle.start();
    await within(checked, "update check did not start");
    autoUpdater.emit("update-downloaded");
    await within(stopping, "verified shutdown did not start");
    autoUpdater.emit("error", new Error("late updater error"));
    rejectShutdown(new Error("runtime still active"));
    await within(failed, "shutdown failure was not handled");

    autoUpdater.emit("update-not-available");

    lifecycle.stop();
    lifecycle.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(checks, 1);

    const retained = claimNativeUpdateRequest(path);
    assert.deepEqual(retained.request, request);
    acknowledgeNativeUpdateRequest(retained);
  } finally {
    lifecycle.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop wires native replacement through the executable lifecycle module", () => {
  const main = readFileSync(new URL("../apps/desktop/main.cjs", import.meta.url), "utf8");
  assert.match(main, /nativeUpdateLifecycle = createNativeUpdateLifecycle\(\{/);
  assert.match(main, /stopRuntime\(\) \{[\s\S]*stopLocalApp\(\{ verifyRuntimeTree: true \}\)/);
  assert.match(main, /recoverReplacementFailure\(error\)[\s\S]*startLocalApp\(\)/);
  assert.match(main, /recoverShutdownFailure\(error\)/);
  assert.doesNotMatch(main, /autoUpdater\.on\("update-downloaded"/);
  assert.doesNotMatch(main, /nativeUpdateTimer/);
  assert.match(main, /stop-existing-install\.mjs/);
  assert.match(main, /"--backend-only"/);
  assert.match(main, /"--preserve-pid",\s*String\(process\.pid\)/);

  const restart = main.slice(main.indexOf("async function restartLocalApp"), main.indexOf("async function showStartupRecovery"));
  assert.match(restart, /stopLocalApp\(\{ verifyRuntimeTree: true \}\)/);
  assert.match(restart, /Refused restart because the local runtime did not stop/);

  const quitting = main.slice(main.indexOf('app\.on("before-quit"'));
  assert.match(quitting, /stopLocalApp\(\{ verifyRuntimeTree: true \}\)[\s\S]*\.then\(\(\) => \{[\s\S]*app\.quit\(\)/);
  assert.doesNotMatch(quitting, /stopLocalApp\([^)]*\)\.finally/);
  assert.match(quitting, /Refused quit because the local runtime did not stop/);
  assert.match(quitting, /quitInProgress = false[\s\S]*shuttingDown = false/);
  assert.match(quitting, /nativeUpdateLifecycle\?\.stop\(\)[\s\S]*stopLocalApp/);
  assert.match(quitting, /shuttingDown = false[\s\S]*startMenuRefreshTimer\(\)[\s\S]*nativeUpdateLifecycle\?\.start\(\)/);

  const runner = readFileSync(new URL("../apps/runner/src/index.ts", import.meta.url), "utf8");
  assert.match(
    runner,
    /updateLaunchInProgress[\s\S]*RIOS_NATIVE_UPDATE_REQUEST[\s\S]*!existsSync\(nativeRequestPath\)[\s\S]*updateLaunchInProgress = false/
  );
});
