const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const APP_NAME = "Relationship Inbox OS";
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

function nodeCandidates(env = process.env, home = homedir()) {
  return [
    env.RIOS_NODE_PATH,
    join(home, ".rios-node", "bin", "node"),
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

function startAppEnvironment(env = process.env, nodeExecutable = "") {
  const nodePath = nodeExecutable && nodeExecutable !== "node"
    ? `${dirname(nodeExecutable)}:${env.PATH || ""}`
    : env.PATH;
  return {
    ...env,
    DASHBOARD_PORT: dashboardPort(env),
    PATH: nodePath,
    RUNNER_PORT: runnerPort(env),
    RIOS_DESKTOP: "1"
  };
}

function startAppArgs(appDir) {
  return [join(appDir, "scripts", "start-app.mjs")];
}

function loadingHtml() {
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
      display: grid;
      width: 72px;
      height: 72px;
      place-items: center;
      border-radius: 18px;
      background: #f4f1ea;
      color: #111317;
      font-size: 34px;
      font-weight: 700;
      letter-spacing: 0;
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
    <div class="mark">R</div>
    <p>Starting Relationship Inbox OS...</p>
  </main>
</body>
</html>`;
}

module.exports = {
  APP_NAME,
  REQUIRED_NODE_MAJOR,
  dashboardPort,
  dashboardUrl,
  isInternalAppUrl,
  isLocalDashboardUrl,
  loadingHtml,
  nodeCandidates,
  parseNodeMajor,
  resolveAppDir,
  runnerPort,
  isSupportedNodeVersion,
  startAppArgs,
  startAppEnvironment
};
