const { randomUUID } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, renameSync, rmSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { homedir } = require("node:os");

function readDesktopRelease(appDir) {
  try {
    return JSON.parse(readFileSync(join(appDir, "release.json"), "utf8"));
  } catch {
    return {};
  }
}

function nativeUpdateRequestPath(stateDir) {
  return join(stateDir, "native-update-request.json");
}

function nativeUpdaterConfiguration({ appDir, isPackaged, platform }) {
  const release = readDesktopRelease(appDir);
  const enabled = isPackaged &&
    platform === "darwin" &&
    release.updateMode === "squirrel-mac" &&
    typeof release.updateFeedUrl === "string" &&
    release.updateFeedUrl.startsWith("https://");
  return { enabled, feedUrl: enabled ? release.updateFeedUrl : "", release };
}

function claimNativeUpdateRequest(path, hooks = {}) {
  const claimPrefix = `${basename(path)}.processing-`;
  let claimPath = join(
    dirname(path),
    `${claimPrefix}${process.pid}-${Date.now()}-${randomUUID()}`
  );
  try {
    renameSync(path, claimPath);
  } catch (error) {
    if (error?.code !== "ENOENT") return null;
    let priorClaims = [];
    try {
      priorClaims = readdirSync(dirname(path))
        .filter((entry) => entry.startsWith(claimPrefix))
        .sort();
    } catch {}
    if (priorClaims.length === 0) return null;
    claimPath = join(dirname(path), priorClaims[0]);
  }
  hooks.afterClaim?.(claimPath);
  try {
    const request = JSON.parse(readFileSync(claimPath, "utf8"));
    if (typeof request?.toVersion === "string" && request.toVersion.trim()) {
      return { claimPath, livePath: path, request };
    }
  } catch {}
  const quarantine = `${path}.invalid-${process.pid}-${Date.now()}`;
  try {
    renameSync(claimPath, quarantine);
  } catch {
    try { rmSync(claimPath, { force: true }); } catch {}
  }
  return null;
}

function acknowledgeNativeUpdateRequest(claim) {
  if (!claim?.claimPath || !claim?.livePath) return false;
  const expectedPrefix = `${claim.livePath}.processing-`;
  if (!claim.claimPath.startsWith(expectedPrefix)) return false;
  try {
    rmSync(claim.claimPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function beginNativeReplacement(autoUpdater, claim, acknowledge = acknowledgeNativeUpdateRequest) {
  autoUpdater.quitAndInstall();
  return !claim || acknowledge(claim);
}

function createNativeUpdateLifecycle({
  autoUpdater,
  requestPath,
  host,
  intervalMs = 500,
  claimRequest = claimNativeUpdateRequest,
  acknowledgeRequest = acknowledgeNativeUpdateRequest,
  replace = beginNativeReplacement
}) {
  let timer = null;
  let currentClaim = null;
  let inProgress = false;
  let pausedUntilRestart = false;

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const pauseUntilRestart = () => {
    pausedUntilRestart = true;
    stop();
  };

  const acknowledgeCurrentRequest = (failureMessage) => {
    if (currentClaim && !acknowledgeRequest(currentClaim)) {
      host.log(failureMessage);
    } else {
      currentClaim = null;
    }
    inProgress = false;
  };

  const start = () => {
    if (timer || pausedUntilRestart || !requestPath) return;
    timer = setInterval(() => {
      if (inProgress) return;
      const claim = claimRequest(requestPath);
      if (!claim) return;
      currentClaim = claim;
      inProgress = true;
      host.log(`Downloading signed update ${claim.request.fromVersion || ""} -> ${claim.request.toVersion}.`);
      try {
        autoUpdater.checkForUpdates();
      } catch (error) {
        acknowledgeCurrentRequest("Could not clear the native update request after startup failed; the desktop will retry it.");
        host.log(`Could not start native update: ${error.message}`);
      }
    }, intervalMs);
    timer.unref?.();
  };

  autoUpdater.on("error", (error) => {
    if (pausedUntilRestart) return;
    host.log(`Native update failed: ${error.message}`);
    acknowledgeCurrentRequest("Could not clear the failed native update request; the desktop will retry it.");
  });

  autoUpdater.on("update-not-available", () => {
    if (pausedUntilRestart) return;
    acknowledgeCurrentRequest("Could not clear the no-update request; the desktop will retry it.");
  });

  autoUpdater.on("update-downloaded", () => {
    if (pausedUntilRestart || !inProgress) return;
    pauseUntilRestart();
    host.beginShutdown();
    void (async () => {
      try {
        await host.stopRuntime();
      } catch (error) {
        inProgress = false;
        await host.recoverShutdownFailure(error);
        return;
      }

      host.markReplacementReady();
      try {
        if (!replace(autoUpdater, currentClaim)) {
          host.log("Could not clear the completed native update request after replacement started.");
        } else {
          currentClaim = null;
        }
      } catch (error) {
        inProgress = false;
        await host.recoverReplacementFailure(error);
      }
    })();
  });

  return { start, stop };
}

function signingCertificatePath(appDir, release) {
  if (typeof release?.signingCertificate !== "string" || !release.signingCertificate) return "";
  return join(appDir, release.signingCertificate);
}

function isSigningCertificateTrusted(certificatePath) {
  if (!certificatePath || !existsSync(certificatePath)) return false;
  return spawnSync("/usr/bin/security", ["verify-cert", "-c", certificatePath, "-p", "codeSign"], {
    stdio: "ignore"
  }).status === 0;
}

function trustSigningCertificate(certificatePath) {
  if (!certificatePath || !existsSync(certificatePath)) {
    return { ok: false, error: "The bundled update certificate is missing." };
  }
  const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
  const result = spawnSync("/usr/bin/security", [
    "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificatePath
  ], { encoding: "utf8", timeout: 20_000 });
  return {
    ok: result.status === 0 && isSigningCertificateTrusted(certificatePath),
    error: (result.stderr || result.stdout || "macOS did not trust the certificate.").trim()
  };
}

module.exports = {
  acknowledgeNativeUpdateRequest,
  beginNativeReplacement,
  claimNativeUpdateRequest,
  createNativeUpdateLifecycle,
  isSigningCertificateTrusted,
  nativeUpdateRequestPath,
  nativeUpdaterConfiguration,
  readDesktopRelease,
  signingCertificatePath,
  trustSigningCertificate
};
