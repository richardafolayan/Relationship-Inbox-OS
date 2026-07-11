const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const {
  chmodSync,
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync
} = require("node:fs");
const { get } = require("node:http");
const { homedir } = require("node:os");
const { join } = require("node:path");
const {
  APP_NAME,
  LOGS_DIR_NAME,
  STORAGE_DIR_NAME,
  REQUIRED_NODE_MAJOR,
  dashboardUrl,
  desktopPaths,
  isInternalAppUrl,
  isSafeExternalUrl,
  isSupportedNodeVersion,
  loadingHtml,
  mergeEnvValues,
  nodeCandidates,
  resolveAppDir,
  runnerPort,
  startAppArgs,
  startAppEnvironment
} = require("./launcher.cjs");

const APP_DIR = resolveAppDir(__dirname);
const START_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1000;
const STOP_TIMEOUT_MS = 8000;

let mainWindow = null;
let appProcess = null;
let appProcessStartedAt = 0;
let currentLogPath = "";
let desktopStorage = null;
const expectedProcessExits = new Set();
let lifecycleGeneration = 0;
let logStream = null;
let permissionPromptShown = false;
let quitInProgress = false;
let quitReady = false;
let recoveryDialogOpen = false;
let restartHistory = [];
let shuttingDown = false;

app.setName(APP_NAME);
// Pin storage to the pre-rebrand folder BEFORE anything resolves userData:
// setName("Tovi") would otherwise move it to .../Application Support/Tovi and
// every existing install would boot with an empty database.
app.setPath("userData", join(app.getPath("appData"), STORAGE_DIR_NAME));
app.setAppLogsPath(join(homedir(), "Library", "Logs", LOGS_DIR_NAME));

function storagePaths() {
  if (desktopStorage) return desktopStorage;
  if (!app.isPackaged) {
    desktopStorage = {
      configDir: APP_DIR,
      dataDir: join(APP_DIR, "data"),
      legacyDir: join(homedir(), "RelationshipInboxOS"),
      logsDir: app.getPath("logs"),
      stateDir: join(APP_DIR, "data", "runtime")
    };
    return desktopStorage;
  }
  desktopStorage = desktopPaths({
    userData: app.getPath("userData"),
    logs: app.getPath("logs"),
    home: homedir()
  });
  return desktopStorage;
}

function createLogPath() {
  const paths = storagePaths();
  mkdirSync(paths.logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(paths.logsDir, `desktop-${stamp}.log`);
}

function writeLog(line) {
  try {
    if (!logStream) {
      currentLogPath = createLogPath();
      logStream = createWriteStream(currentLogPath, { flags: "a", mode: 0o600 });
      logStream.on("error", () => {});
    }
    const text = String(line).endsWith("\n") ? String(line) : `${line}\n`;
    logStream.write(`${new Date().toISOString()} ${text}`);
  } catch {
    // Logging must not make an otherwise healthy desktop app fail to open.
  }
}

function showMessageBox(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function pickNodeExecutable() {
  for (const candidate of nodeCandidates(process.env)) {
    if (candidate !== "node" && !existsSync(candidate)) continue;
    const version = spawnSync(candidate, ["-v"], { encoding: "utf8" });
    if (version.status === 0 && isSupportedNodeVersion(version.stdout)) return candidate;
  }
  return "";
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const target = join(destination, entry);
    if (existsSync(target)) continue;
    cpSync(join(source, entry), target, { recursive: true, errorOnExist: true });
  }
}

function writeMigrationMarker(paths, decision) {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(
    join(paths.stateDir, "legacy-migration-v1.json"),
    `${JSON.stringify({ decision, recordedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

async function preparePackagedStorage() {
  const paths = storagePaths();
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  if (!app.isPackaged) return true;

  const marker = join(paths.stateDir, "legacy-migration-v1.json");
  const legacyData = join(paths.legacyDir, "data");
  const newDatabase = join(paths.dataDir, "inbox-os.sqlite");
  const canMigrate = !existsSync(marker) && !existsSync(newDatabase) && existsSync(legacyData);
  if (canMigrate) {
    const result = await showMessageBox({
      type: "question",
      title: APP_NAME,
      message: "Existing Tovi (Relationship Inbox OS) data was found.",
      detail:
        "Import your existing settings, message database and browser sessions into the Mac app? The original folder will remain unchanged, so you can return to it if needed.",
      buttons: ["Import existing data", "Start fresh", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (result.response === 2) return false;
    if (result.response === 0) {
      copyDirectoryContents(legacyData, paths.dataDir);
      const legacyEnv = join(paths.legacyDir, ".env");
      if (existsSync(legacyEnv) && !existsSync(join(paths.configDir, ".env"))) {
        cpSync(legacyEnv, join(paths.configDir, ".env"), { errorOnExist: true });
      }
      writeMigrationMarker(paths, "imported");
      writeLog(`Imported legacy data from ${paths.legacyDir}; the source was preserved.`);
    } else {
      writeMigrationMarker(paths, "fresh");
      writeLog(`Started fresh; legacy data remains at ${paths.legacyDir}.`);
    }
  }

  const envPath = join(paths.configDir, ".env");
  const examplePath = join(APP_DIR, ".env.example");
  let envText = "";
  if (existsSync(envPath)) envText = readFileSync(envPath, "utf8");
  else if (existsSync(examplePath)) envText = readFileSync(examplePath, "utf8");
  // Path keys must always point outside the signed bundle; feature keys are
  // set-once defaults so a user's later .env edits survive relaunches.
  envText = mergeEnvValues(envText, {
    DATABASE_URL: `file:${join(paths.dataDir, "inbox-os.sqlite")}`,
    TRANSCRIPTION_MODEL_DIR: join(paths.dataDir, "models")
  });
  envText = mergeEnvValues(envText, {
    BROWSER_PROFILE_MODE: "personal",
    IMESSAGE_ENABLED: "true"
  }, { keepExisting: true });
  writeFileSync(envPath, envText, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return true;
}

function request(url, { json = false } = {}) {
  return new Promise((resolveRequest) => {
    const requestHandle = get(url, { timeout: 2500 }, (response) => {
      if (!json) {
        response.resume();
        resolveRequest(response.statusCode > 0 && response.statusCode < 500);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length < 64_000) body += chunk;
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolveRequest(
            response.statusCode > 0 &&
            response.statusCode < 500 &&
            parsed?.application === "relationship-inbox-os"
          );
        } catch {
          resolveRequest(false);
        }
      });
    });
    requestHandle.on("timeout", () => {
      requestHandle.destroy();
      resolveRequest(false);
    });
    requestHandle.on("error", () => resolveRequest(false));
  });
}

function dashboardReady() {
  return request(dashboardUrl(process.env));
}

function runnerReady() {
  return request(`http://127.0.0.1:${runnerPort(process.env)}/health`, { json: true });
}

async function localAppReady() {
  const [dashboard, runner] = await Promise.all([dashboardReady(), runnerReady()]);
  return dashboard && runner;
}

function showLoading(message = "Starting Tovi...") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml(message))}`)
    .catch((error) => writeLog(`Could not show startup screen: ${error.message}`));
}

async function loadDashboardWhenReady(window, url, generation) {
  if (!window) return;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!window.isDestroyed() && generation === lifecycleGeneration && Date.now() < deadline) {
    if (await localAppReady()) {
      try {
        await window.loadURL(url);
        if (!window.isVisible()) window.show();
        restartHistory = [];
        if (!permissionPromptShown) {
          permissionPromptShown = true;
          setTimeout(() => void showPermissionHelp({ onlyWhenMissing: true }), 750);
        }
      } catch (error) {
        if (!shuttingDown) writeLog(`Could not load dashboard: ${error.message}`);
      }
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  if (window.isDestroyed() || generation !== lifecycleGeneration || shuttingDown) return;
  showLoading("The app could not finish starting. Choose Retry from the app menu.");
  await showStartupRecovery("The local services did not become ready in time.");
}

function startLocalApp() {
  if (appProcess || shuttingDown) return false;
  const node = pickNodeExecutable();
  if (!node) {
    dialog.showErrorBox(
      APP_NAME,
      `Node.js ${REQUIRED_NODE_MAJOR} is missing from this Mac app. Reinstall Tovi from the DMG, then try again.`
    );
    quitReady = true;
    app.quit();
    return false;
  }

  const paths = storagePaths();
  const generation = ++lifecycleGeneration;
  const environment = startAppEnvironment(process.env, node, {
    appDir: APP_DIR,
    configDir: paths.configDir,
    dataDir: paths.dataDir,
    packaged: app.isPackaged,
    stateDir: paths.stateDir
  });
  writeLog(`Starting local app from ${APP_DIR}`);
  const child = spawn(node, startAppArgs(APP_DIR), {
    cwd: APP_DIR,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  appProcess = child;
  appProcessStartedAt = Date.now();
  child.stdout.on("data", (chunk) => writeLog(chunk.toString()));
  child.stderr.on("data", (chunk) => writeLog(chunk.toString()));
  child.on("error", (error) => writeLog(`Failed to start: ${error.message}`));
  child.on("exit", (code, signalName) => {
    if (appProcess === child) appProcess = null;
    writeLog(`Local app exited with code=${code ?? ""} signal=${signalName ?? ""}`);
    if (shuttingDown || expectedProcessExits.delete(child)) return;
    const now = Date.now();
    restartHistory = restartHistory.filter((time) => now - time < 60_000);
    if (restartHistory.length < 1) {
      restartHistory.push(now);
      writeLog("Attempting one automatic recovery after an unexpected stop.");
      showLoading("Recovering after an unexpected stop...");
      setTimeout(() => {
        if (!shuttingDown && !appProcess) {
          startLocalApp();
          void loadDashboardWhenReady(mainWindow, dashboardUrl(process.env), lifecycleGeneration);
        }
      }, 1200);
      return;
    }
    void showStartupRecovery(
      `The local app stopped ${Math.round((now - appProcessStartedAt) / 1000)} seconds after launch.`
    );
  });
  return generation;
}

async function stopLocalApp() {
  const child = appProcess;
  if (!child) return;
  expectedProcessExits.add(child);
  await new Promise((resolveStop) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveStop();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (settled) return;
      writeLog(`Local app did not stop within ${STOP_TIMEOUT_MS}ms; forcing it to close.`);
      try {
        child.kill("SIGKILL");
      } catch {
        // It exited between the timeout and the signal.
      }
      finish();
    }, STOP_TIMEOUT_MS).unref();
  });
  if (appProcess === child) appProcess = null;
}

async function restartLocalApp() {
  if (shuttingDown) return;
  ++lifecycleGeneration;
  showLoading("Restarting Tovi...");
  await stopLocalApp();
  restartHistory = [];
  const generation = startLocalApp();
  if (generation) void loadDashboardWhenReady(mainWindow, dashboardUrl(process.env), generation);
}

async function showStartupRecovery(reason) {
  if (recoveryDialogOpen || shuttingDown) return;
  recoveryDialogOpen = true;
  try {
    const result = await showMessageBox({
      type: "warning",
      title: APP_NAME,
      message: "Tovi needs help starting.",
      detail: `${reason}\n\nRetry starts the runner and dashboard again. Show Logs opens the diagnostic log. Your message data is not removed.`,
      buttons: ["Retry", "Show Logs", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (result.response === 0) await restartLocalApp();
    else if (result.response === 1) {
      if (currentLogPath) shell.showItemInFolder(currentLogPath);
      else await shell.openPath(storagePaths().logsDir);
    } else app.quit();
  } finally {
    recoveryDialogOpen = false;
  }
}

function messagesAccessStatus() {
  const path = join(homedir(), "Library", "Messages", "chat.db");
  try {
    const fd = openSync(path, "r");
    closeSync(fd);
    return { status: "granted", path };
  } catch (error) {
    return {
      status: error?.code === "ENOENT" ? "messages_not_set_up" : "full_disk_access_required",
      path,
      code: error?.code || "UNKNOWN"
    };
  }
}

async function showPermissionHelp({ onlyWhenMissing = false } = {}) {
  const access = messagesAccessStatus();
  if (onlyWhenMissing && access.status === "granted") return;
  if (access.status === "messages_not_set_up") {
    const result = await showMessageBox({
      type: "info",
      title: "Set up Messages",
      message: "Messages is not ready on this Mac.",
      detail:
        "1. Open the Messages app.\n2. Sign in and confirm a conversation is visible.\n3. Return to Tovi and choose Check Permissions from the app menu.\n\nNo SIP changes are required.",
      buttons: ["Open Messages", "Not now"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (result.response === 0) await shell.openExternal("imessage:");
    return;
  }
  if (access.status === "full_disk_access_required") {
    const result = await showMessageBox({
      type: "warning",
      title: "Allow iMessage access",
      message: "Tovi needs Full Disk Access to read your local Messages database.",
      detail:
        "1. Open System Settings, then Privacy & Security, then Full Disk Access.\n2. Turn on Tovi. If it is not listed, use the plus button and choose the app from Applications.\n3. Quit and reopen Tovi, then choose Check Permissions.\n\nContacts names use the same local access. Sending asks separately for Automation only when you choose Send. File attachments may also ask for Accessibility. No SIP changes are required.",
      buttons: ["Open Full Disk Access", "Retry", "Not now"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (result.response === 0) {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
    } else if (result.response === 1) {
      await showPermissionHelp();
    }
    return;
  }

  const result = await showMessageBox({
    type: "info",
    title: "Mac permissions",
    message: "iMessage reading is ready.",
    detail:
      "Automation is requested only when you choose Send. Allow Tovi to control Messages, then retry the send. File attachments may also require Accessibility. Contacts names are read locally and are never uploaded by the desktop app.",
    buttons: ["Done", "Open Privacy & Security"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (result.response === 1) {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security");
  }
}

function readWindowBounds() {
  try {
    const parsed = JSON.parse(readFileSync(join(storagePaths().stateDir, "window.json"), "utf8"));
    if ([parsed?.width, parsed?.height, parsed?.x, parsed?.y].every(Number.isFinite)) return parsed;
  } catch {
    // Use centered defaults when the prior state is missing or malformed.
  }
  return null;
}

function saveWindowBounds(window) {
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  try {
    mkdirSync(storagePaths().stateDir, { recursive: true });
    writeFileSync(
      join(storagePaths().stateDir, "window.json"),
      `${JSON.stringify(window.getBounds(), null, 2)}\n`,
      { mode: 0o600 }
    );
  } catch (error) {
    writeLog(`Could not save window position: ${error.message}`);
  }
}

function openDashboardPath(pathname) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const target = new URL(pathname, dashboardUrl(process.env)).toString();
  void mainWindow.loadURL(target).catch((error) => writeLog(`Could not open ${pathname}: ${error.message}`));
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings...", accelerator: "CommandOrControl+,", click: () => openDashboardPath("/settings") },
        { label: "Check Permissions...", click: () => void showPermissionHelp() },
        { label: "Retry Startup", click: () => void restartLocalApp() },
        { label: "Show Logs", click: () => void shell.openPath(storagePaths().logsDir) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const savedBounds = readWindowBounds();
  mainWindow = new BrowserWindow({
    width: savedBounds?.width || 1280,
    height: savedBounds?.height || 820,
    x: savedBounds?.x,
    y: savedBounds?.y,
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

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", () => saveWindowBounds(mainWindow));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("unresponsive", () => {
    if (!shuttingDown) void showStartupRecovery("The app window stopped responding.");
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    writeLog(`Window process stopped: reason=${details.reason} exitCode=${details.exitCode}`);
    if (!shuttingDown) void showStartupRecovery("The app window closed unexpectedly.");
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isInternalAppUrl(targetUrl, process.env)) {
      void mainWindow.loadURL(targetUrl);
    } else if (isSafeExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    } else {
      writeLog(`Blocked unsupported external URL: ${targetUrl}`);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (isInternalAppUrl(targetUrl, process.env)) return;
    event.preventDefault();
    if (isSafeExternalUrl(targetUrl)) void shell.openExternal(targetUrl);
    else writeLog(`Blocked unsupported navigation: ${targetUrl}`);
  });

  showLoading();
  return mainWindow;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  quitReady = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const storageReady = await preparePackagedStorage();
    if (!storageReady) {
      quitReady = true;
      app.quit();
      return;
    }
    createMenu();
    createWindow();
    const generation = startLocalApp();
    if (generation) void loadDashboardWhenReady(mainWindow, dashboardUrl(process.env), generation);
  }).catch((error) => {
    writeLog(`Desktop startup failed: ${error.message}`);
    dialog.showErrorBox(APP_NAME, `Tovi could not start.\n\n${error.message}`);
    quitReady = true;
    app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
    if (!appProcess && !shuttingDown) {
      const generation = startLocalApp();
      if (generation) void loadDashboardWhenReady(mainWindow, dashboardUrl(process.env), generation);
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    shuttingDown = true;
    ++lifecycleGeneration;
    void stopLocalApp().finally(() => {
      quitReady = true;
      if (logStream) {
        logStream.end();
        logStream = null;
      }
      app.quit();
    });
  });
}
