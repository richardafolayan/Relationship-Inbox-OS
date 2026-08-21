const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { delimiter, dirname, join, resolve, win32 } = require("node:path");

// Read RIOS_APP_NAME from the app's .env as a fallback so the packaged/dev
// desktop shell reflects the configured name even when the Electron process was
// not started with the variable already exported. Defensive: any failure just
// yields "" and the default applies.
function configuredAppName(appDir = resolve(__dirname, "../..")) {
  try {
    const text = readFileSync(join(appDir, ".env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1 || line.slice(0, eq).trim() !== "RIOS_APP_NAME") continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value.trim();
    }
  } catch {}
  try {
    const release = JSON.parse(readFileSync(join(appDir, "release.json"), "utf8"));
    return typeof release.appName === "string" ? release.appName.trim() : "";
  } catch {}
  return "";
}

function validateAppName(value) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u.test(value)) {
    throw new Error(
      "RIOS_APP_NAME must be 1-80 letters, numbers, spaces, dots, underscores, parentheses or hyphens."
    );
  }
  return value;
}

// Display name only — driven by RIOS_APP_NAME (default "Tovi") so the whole app
// can be rebranded from one place in .env. This is what shows in the macOS app
// menu, window title and dialogs. The storage identity below is NOT derived
// from it (see the STORAGE_DIR_NAME note).
const APP_NAME = validateAppName(
  (process.env.RIOS_APP_NAME || "").trim() || configuredAppName() || "Tovi"
);
const APP_ID = "relationship-inbox-os";
// The storage folder keeps the pre-rebrand name: macOS TCC grants and every
// existing install's data live under this directory, keyed alongside the
// unchanged bundle id. Renaming it strands user data and permissions.
const STORAGE_DIR_NAME = "Relationship Inbox OS";
const LOGS_DIR_NAME = "RelationshipInboxOS";
const DEFAULT_DASHBOARD_PORT = "3100";
const DEFAULT_RUNNER_PORT = "4001";
const REQUIRED_NODE_MAJOR = 22;

function resolveAppDir(fromDir = __dirname) {
  return resolve(fromDir, "../..");
}

function dashboardPort(env = process.env) {
  return String(env.DASHBOARD_PORT || DEFAULT_DASHBOARD_PORT).trim() || DEFAULT_DASHBOARD_PORT;
}

function runnerPort(env = process.env) {
  return String(env.RUNNER_PORT || DEFAULT_RUNNER_PORT).trim() || DEFAULT_RUNNER_PORT;
}

function dashboardUrl(env = process.env) {
  return `http://localhost:${dashboardPort(env)}`;
}

function isLocalDashboardUrl(value, env = process.env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  return url.protocol === "http:" &&
    allowedHosts.has(url.hostname) &&
    url.port === dashboardPort(env);
}

function isInternalAppUrl(value, env = process.env) {
  return String(value).startsWith("data:text/html") || isLocalDashboardUrl(value, env);
}

function isSafeExternalUrl(value) {
  try {
    return new Set(["https:", "http:", "mailto:"]).has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function bundledNodePath(appDir, platform = process.platform) {
  return platform === "win32"
    ? win32.join(appDir, "..", "runtime", "node", "node.exe")
    : join(appDir, "..", "runtime", "node", "bin", "node");
}

function nodeCandidates(env = process.env, home = homedir(), platform = process.platform) {
  const appDir = resolveAppDir(__dirname);
  return [
    env.RIOS_NODE_PATH,
    bundledNodePath(appDir, platform),
    platform === "win32"
      ? join(home, ".rios-node", "node.exe")
      : join(home, ".rios-node", "bin", "node"),
    "node"
  ].filter(Boolean);
}

function parseNodeMajor(versionText) {
  const match = String(versionText).trim().match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

function isSupportedNodeVersion(versionText) {
  return parseNodeMajor(versionText) === REQUIRED_NODE_MAJOR;
}

function desktopPaths({ userData, logs, home = homedir() }) {
  const configDir = resolve(userData);
  return {
    configDir,
    dataDir: join(configDir, "data"),
    legacyDir: join(home, "RelationshipInboxOS"),
    logsDir: resolve(logs),
    stateDir: join(configDir, "state")
  };
}

function startAppEnvironment(env = process.env, nodeExecutable = "", options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? win32 : { dirname, join };
  const appDir = platform === "win32"
    ? win32.resolve(options.appDir || resolveAppDir(__dirname))
    : resolve(options.appDir || resolveAppDir(__dirname));
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathEntries = [
    nodeExecutable && nodeExecutable !== "node" ? pathApi.dirname(nodeExecutable) : "",
    pathApi.join(appDir, "node_modules", ".bin"),
    env.PATH || "",
    platform === "win32" ? "" : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  ].filter(Boolean);
  return {
    ...env,
    DASHBOARD_PORT: dashboardPort(env),
    PATH: pathEntries.join(pathDelimiter),
    RUNNER_PORT: runnerPort(env),
    RIOS_CONFIG_DIR: options.configDir || env.RIOS_CONFIG_DIR,
    RIOS_DATA_DIR: options.dataDir || env.RIOS_DATA_DIR,
    RIOS_DESKTOP: "1",
    RUN_TRACE_DIR:
      options.packaged && options.dataDir
        ? pathApi.join(options.dataDir, "logs", "runs")
        : env.RUN_TRACE_DIR,
    RIOS_NATIVE_UPDATE_REQUEST: options.nativeUpdateRequest || env.RIOS_NATIVE_UPDATE_REQUEST,
    RIOS_PACKAGED_APP: options.packaged ? "1" : env.RIOS_PACKAGED_APP,
    RIOS_RECLAIM_EXISTING: "1",
    RIOS_RECLAIM_PORT_CONFLICTS: "1",
    RIOS_STATE_DIR: options.stateDir || env.RIOS_STATE_DIR
  };
}

function desktopCapabilities(platform = process.platform) {
  const imessageSupported = platform === "darwin";
  return {
    imessageSupported,
    imessageUnavailableReason: imessageSupported ? null : "iMessage is only available on macOS.",
    macPermissionsSupported: imessageSupported
  };
}

function packagedFeatureDefaults(platform = process.platform) {
  const defaults = {
    BROWSER_PROFILE_MODE: platform === "win32" ? "isolated" : "personal",
    IMESSAGE_ENABLED: platform === "darwin" ? "true" : "false"
  };
  if (platform === "win32") {
    defaults.WHATSAPP_ENABLED = "true";
    defaults.GOOGLE_MESSAGES_ENABLED = "true";
  }
  return defaults;
}

function startAppArgs(appDir) {
  return [join(appDir, "scripts", "start-app.mjs")];
}

function mergeEnvValues(input, values, { keepExisting = false } = {}) {
  const pending = new Map(Object.entries(values));
  const lines = String(input).split(/\r?\n/).map((line) => {
    if (line.trimStart().startsWith("#")) return line;
    const separator = line.indexOf("=");
    if (separator < 1) return line;
    const key = line.slice(0, separator).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return keepExisting ? line : `${key}=${value}`;
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadingHtml(message = `Starting ${APP_NAME}...`) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME}</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      background: #0f1115;
      color: #f4f1ea;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      display: grid;
      place-items: center;
    }
    main {
      display: grid;
      gap: 14px;
      justify-items: center;
    }
    .mark {
      width: 72px;
      height: 72px;
    }
    p {
      margin: 0;
      color: rgba(244, 241, 234, 0.72);
      font-size: 13px;
      letter-spacing: 0.02em;
    }
  </style>
</head>
<body>
  <main>
    <svg class="mark" viewBox="0 0 512 512" role="img" aria-label="${escapeHtml(APP_NAME)}"><rect x="36" y="36" width="440" height="440" rx="96.8" fill="#F7F2E8"/><path d="M 146 374 C 106 352 80 313 75 266 C 69 212 90 160 132 124 C 171 91 220 76 271 81 C 334 87 387 117 418 162 C 447 204 450 260 426 310 C 399 365 346 394 282 394 H 224 C 207 394 191 399 177 408 L 126 440" fill="none" stroke="#202A35" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" transform="translate(71.200 71.200) scale(0.721875)"/><circle cx="254.556" cy="253.113" r="21.656" fill="#D9902F"/></svg>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

module.exports = {
  APP_ID,
  APP_NAME,
  LOGS_DIR_NAME,
  STORAGE_DIR_NAME,
  REQUIRED_NODE_MAJOR,
  bundledNodePath,
  configuredAppName,
  dashboardPort,
  dashboardUrl,
  desktopCapabilities,
  desktopPaths,
  isInternalAppUrl,
  isLocalDashboardUrl,
  isSafeExternalUrl,
  loadingHtml,
  mergeEnvValues,
  nodeCandidates,
  packagedFeatureDefaults,
  parseNodeMajor,
  resolveAppDir,
  runnerPort,
  isSupportedNodeVersion,
  startAppArgs,
  startAppEnvironment
};
