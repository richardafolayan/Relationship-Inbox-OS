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
  isSigningCertificateTrusted,
  nativeUpdateRequestPath,
  nativeUpdaterConfiguration,
  readDesktopRelease,
  signingCertificatePath,
  trustSigningCertificate
};
