const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { createWriteStream, existsSync, mkdirSync } = require("node:fs");
const { get } = require("node:http");
const { join } = require("node:path");
const {
  APP_NAME,
  REQUIRED_NODE_MAJOR,
  dashboardUrl,
  isInternalAppUrl,
  isSupportedNodeVersion,
  loadingHtml,
  nodeCandidates,
  resolveAppDir,
  startAppArgs,
  startAppEnvironment
} = require("./launcher.cjs");

const APP_DIR = resolveAppDir(__dirname);
const START_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1500;

let mainWindow = null;
let appProcess = null;
let logStream = null;
let shuttingDown = false;

app.setName(APP_NAME);

function logPath() {
  const dir = join(app.getPath("logs"), "RelationshipInboxOS");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `desktop-${stamp}.log`);
}

function writeLog(line) {
  if (!logStream) logStream = createWriteStream(logPath(), { flags: "a" });
  logStream.write(line.endsWith("\n") ? line : `${line}\n`);
}

function pickNodeExecutable() {
  for (const candidate of nodeCandidates(process.env)) {
    if (candidate !== "node" && !existsSync(candidate)) continue;
    const version = spawnSync(candidate, ["-v"], { encoding: "utf8" });
    if (version.status === 0 && isSupportedNodeVersion(version.stdout)) return candidate;
  }
  return "";
}

function startLocalApp() {
  if (appProcess) return;
  const node = pickNodeExecutable();
  if (!node) {
    dialog.showErrorBox(
      APP_NAME,
      `Node.js ${REQUIRED_NODE_MAJOR} is missing. Run the Relationship Inbox OS installer again so it can repair the app.`
    );
    app.quit();
    return;
  }

  writeLog(`Starting local app from ${APP_DIR}`);
  appProcess = spawn(node, startAppArgs(APP_DIR), {
    cwd: APP_DIR,
    env: startAppEnvironment(process.env, node),
    stdio: ["ignore", "pipe", "pipe"]
  });

  appProcess.stdout.on("data", (chunk) => writeLog(chunk.toString()));
  appProcess.stderr.on("data", (chunk) => writeLog(chunk.toString()));
  appProcess.on("error", (error) => {
    writeLog(`Failed to start: ${error.message}`);
    dialog.showErrorBox(APP_NAME, `Could not start Relationship Inbox OS.\n\n${error.message}`);
  });
  appProcess.on("exit", (code, signal) => {
    writeLog(`Local app exited with code=${code ?? ""} signal=${signal ?? ""}`);
    appProcess = null;
    if (!shuttingDown) {
      dialog.showErrorBox(APP_NAME, "Relationship Inbox OS stopped. Reopen the app to start it again.");
      app.quit();
    }
  });
}

function dashboardReady(url) {
  return new Promise((resolve) => {
    const request = get(url, { timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode > 0 && response.statusCode < 500);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function loadDashboardWhenReady(window, url) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!window.isDestroyed() && Date.now() < deadline) {
    if (await dashboardReady(url)) {
      await window.loadURL(url);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (!window.isDestroyed()) {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml().replace("Starting Relationship Inbox OS...", "Still starting. Check the app log if this takes more than a minute."))}`);
  }
}

function createWindow() {
  const url = dashboardUrl(process.env);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: "#0f1115",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isInternalAppUrl(targetUrl, process.env)) return { action: "allow" };
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (isInternalAppUrl(targetUrl, process.env)) return;
    event.preventDefault();
    shell.openExternal(targetUrl);
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  void loadDashboardWhenReady(mainWindow, url);
}

function stopLocalApp() {
  shuttingDown = true;
  if (appProcess) {
    appProcess.kill("SIGTERM");
    appProcess = null;
  }
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (!(await dashboardReady(dashboardUrl(process.env)))) {
      startLocalApp();
    }
    createWindow();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", stopLocalApp);
}
