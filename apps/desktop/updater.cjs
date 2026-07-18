const { existsSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
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

function consumeNativeUpdateRequest(path) {
  if (!existsSync(path)) return null;
  try {
    const request = JSON.parse(readFileSync(path, "utf8"));
    return typeof request?.toVersion === "string" ? request : null;
  } catch {
    return null;
  } finally {
    rmSync(path, { force: true });
  }
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
  consumeNativeUpdateRequest,
  isSigningCertificateTrusted,
  nativeUpdateRequestPath,
  nativeUpdaterConfiguration,
  readDesktopRelease,
  signingCertificatePath,
  trustSigningCertificate
};
