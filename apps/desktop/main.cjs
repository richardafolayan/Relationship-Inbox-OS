const { app, autoUpdater, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { get } = require("node:http");
const { homedir } = require("node:os");
const { join } = require("node:path");
const {
  APP_ID,
  APP_NAME,
  LOGS_DIR_NAME,
  STORAGE_DIR_NAME,
  REQUIRED_NODE_MAJOR,
  dashboardUrl,
  desktopCapabilities,
  desktopPaths,
  isInternalAppUrl,
  isSafeExternalUrl,
  isSupportedNodeVersion,
  loadingHtml,
  mergeEnvValues,
  nodeCandidates,
  packagedFeatureDefaults,
  packagedFeatureMergeOptions,
  resolveAppDir,
  runnerPort,
  startAppArgs,
  startAppEnvironment
} = require("./launcher.cjs");
const {
  createNativeUpdateLifecycle,
  isSigningCertificateTrusted,
  nativeUpdateRequestPath,
  nativeUpdaterConfiguration,
  signingCertificatePath,
  trustSigningCertificate
} = require("./updater.cjs");
const {
  prepareLegacyStorageMigration,
  writePrivateTextAtomically
} = require("./legacy-storage-migration.cjs");

const APP_DIR = resolveAppDir(__dirname);
const START_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1000;
const STOP_TIMEOUT_MS = 8000;
const MENU_REFRESH_INTERVAL_MS = 60_000;
// Keep these values aligned with apps/dashboard/lib/ui-scale.ts.
const TEXT_SIZE_LEVELS = ["normal", "large", "extra"];
const UI_SCALE_STORAGE_KEY = "inbox_os_ui_scale";
const UI_SCALE_CHANGE_EVENT = "inbox-ui-scale";

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
let reclaimPortConflictsOnce = false;
let restartHistory = [];
let shuttingDown = false;
let favouriteContacts = [];
let currentTextSize = "normal";
let menuRefreshTimer = null;
let nativeUpdateLifecycle = null;
let nativeUpdateRequest = "";

function startMenuRefreshTimer() {
  if (menuRefreshTimer || shuttingDown) return;
  menuRefreshTimer = setInterval(() => {
    if (!shuttingDown && appProcess && mainWindow && !mainWindow.isDestroyed()) {
      void refreshFavourites();
    }
  }, MENU_REFRESH_INTERVAL_MS);
  menuRefreshTimer.unref?.();
}

app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
// Pin storage to the pre-rebrand folder BEFORE anything resolves userData:
// setName("Tovi") would otherwise move it to .../Application Support/Tovi and
// every existing install would boot with an empty database.
app.setPath("userData", join(app.getPath("appData"), STORAGE_DIR_NAME));
app.setAppLogsPath(
  process.platform === "darwin"
    ? join(homedir(), "Library", "Logs", LOGS_DIR_NAME)
    : join(app.getPath("userData"), "logs")
);

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

async function preparePackagedStorage() {
  const paths = storagePaths();
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  if (!app.isPackaged) return true;

  const nodeExecutable = pickNodeExecutable();
  if (!nodeExecutable) {
    throw new Error(`Node.js ${REQUIRED_NODE_MAJOR} is required to verify existing message data`);
  }
  const migration = await prepareLegacyStorageMigration({
    paths,
    nodeExecutable,
    backupScript: join(APP_DIR, "scripts", "lib", "backup-sqlite.mjs"),
    lockScript: join(APP_DIR, "scripts", "install-maintenance.mjs"),
    stopScript: join(APP_DIR, "scripts", "stop-existing-install.mjs"),
    decide: async () => {
      const result = await showMessageBox({
        type: "question",
        title: APP_NAME,
        message: `Existing ${APP_NAME} (${STORAGE_DIR_NAME}) data was found.`,
        detail:
          `Import your existing settings and message database into ${APP_NAME}? The original folder will remain unchanged, so you can return to it if needed.`,
        buttons: ["Import existing data", "Start fresh", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      return result.response === 0 ? "import" : result.response === 1 ? "fresh" : "quit";
    }
  });
  if (!migration.proceed) return false;
  if (migration.decision === "imported" && migration.migrated) {
    writeLog(`Imported legacy data from ${paths.legacyDir}; the source was preserved.`);
  } else if (migration.decision === "fresh") {
    writeLog(`Started fresh; legacy data remains at ${paths.legacyDir}.`);
  }

  const envPath = join(paths.configDir, ".env");
  const examplePath = join(APP_DIR, ".env.example");
  const envAlreadyExists = existsSync(envPath);
  let envText = "";
  if (envAlreadyExists) envText = readFileSync(envPath, "utf8");
  else if (existsSync(examplePath)) envText = readFileSync(examplePath, "utf8");
  // Path keys must always point outside the signed bundle; feature keys are
  // set-once defaults so a user's later .env edits survive relaunches.
  envText = mergeEnvValues(envText, {
    DATABASE_URL: `file:${join(paths.dataDir, "inbox-os.sqlite")}`,
    TRANSCRIPTION_MODEL_DIR: join(paths.dataDir, "models")
  });
  const featureDefaults = packagedFeatureDefaults(process.platform);
  envText = mergeEnvValues(envText, {
    IMESSAGE_ENABLED: featureDefaults.IMESSAGE_ENABLED,
    ...(process.platform === "win32"
      ? { BROWSER_PROFILE_MODE: featureDefaults.BROWSER_PROFILE_MODE }
      : {})
  });
  envText = mergeEnvValues(envText, {
    ...(process.platform === "win32"
      ? {}
      : { BROWSER_PROFILE_MODE: featureDefaults.BROWSER_PROFILE_MODE }),
    ...(featureDefaults.WHATSAPP_ENABLED
      ? { WHATSAPP_ENABLED: featureDefaults.WHATSAPP_ENABLED }
      : {}),
    ...(featureDefaults.GOOGLE_MESSAGES_ENABLED
      ? { GOOGLE_MESSAGES_ENABLED: featureDefaults.GOOGLE_MESSAGES_ENABLED }
      : {})
  }, packagedFeatureMergeOptions(envAlreadyExists));
  writePrivateTextAtomically(envPath, envText);
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

function startupConflictPath() {
  return join(storagePaths().stateDir, "startup-conflict.json");
}

function readStartupConflict() {
  const path = startupConflictPath();
  try {
    const conflict = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path, { force: true });
    return conflict?.version === 1 && conflict?.kind === "port_conflict" ? conflict : null;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

async function localAppReady() {
  const [dashboard, runner] = await Promise.all([dashboardReady(), runnerReady()]);
  return dashboard && runner;
}

function showLoading(message = `Starting ${APP_NAME}...`) {
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
        setTimeout(refreshMenuState, 500);
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
      `Node.js ${REQUIRED_NODE_MAJOR} is missing from this Mac app. Reinstall ${APP_NAME} from the DMG, then try again.`
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
    stateDir: paths.stateDir,
    nativeUpdateRequest
  });
  rmSync(startupConflictPath(), { force: true });
  if (reclaimPortConflictsOnce) environment.RIOS_RECLAIM_PORT_CONFLICTS = "1";
  else delete environment.RIOS_RECLAIM_PORT_CONFLICTS;
  reclaimPortConflictsOnce = false;
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
    const conflict = readStartupConflict();
    if (conflict) {
      void showPortConflictRecovery(conflict);
      return;
    }
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

async function configureNativeUpdater() {
  const configuration = nativeUpdaterConfiguration({
    appDir: APP_DIR,
    isPackaged: app.isPackaged,
    platform: process.platform
  });
  if (!configuration.enabled) return;

  const certificatePath = signingCertificatePath(APP_DIR, configuration.release);
  if (!isSigningCertificateTrusted(certificatePath)) {
    const result = await showMessageBox({
      type: "info",
      title: `${APP_NAME} updates`,
      message: "Enable seamless updates on this Mac?",
      detail:
        `${APP_NAME} uses its own free code-signing certificate because this build is not distributed through Apple's paid developer programme. ` +
        "Trust it once and future updates can replace the app without resetting its macOS permissions.",
      buttons: ["Enable seamless updates", "Not now"],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response !== 0) return;
    const trust = trustSigningCertificate(certificatePath);
    if (!trust.ok) {
      writeLog(`Could not trust update certificate: ${trust.error}`);
      await showMessageBox({
        type: "warning",
        title: `${APP_NAME} updates`,
        message: "Seamless updates could not be enabled.",
        detail: "The app will keep working, but a future update may need a manual reinstall. Try again after unlocking your login keychain.",
        buttons: ["OK"]
      });
      return;
    }
  }

  nativeUpdateRequest = nativeUpdateRequestPath(storagePaths().stateDir);
  autoUpdater.setFeedURL({ url: configuration.feedUrl, serverType: "json" });
  nativeUpdateLifecycle = createNativeUpdateLifecycle({
    autoUpdater,
    requestPath: nativeUpdateRequest,
    host: {
      log: writeLog,
      beginShutdown() {
        shuttingDown = true;
        ++lifecycleGeneration;
      },
      stopRuntime() {
        return stopLocalApp({ verifyRuntimeTree: true });
      },
      markReplacementReady() {
        quitReady = true;
      },
      async recoverReplacementFailure(error) {
        quitReady = false;
        shuttingDown = false;
        writeLog(`Native replacement could not start: ${error.message}`);
        startMenuRefreshTimer();
        const generation = startLocalApp();
        if (generation) void loadDashboardWhenReady(mainWindow, dashboardUrl(process.env), generation);
        await showMessageBox({
          type: "warning",
          title: `${APP_NAME} updates`,
          message: "The update was downloaded, but macOS could not start the replacement.",
          detail: "Tovi restarted its local services and kept the update ready to retry. Quit Tovi completely, reopen it, then try the update again.",
          buttons: ["OK"]
        });
      },
      async recoverShutdownFailure(error) {
        shuttingDown = false;
        writeLog(`Refused native replacement because the local runtime did not stop: ${error.message}`);
        await showMessageBox({
          type: "warning",
          title: `${APP_NAME} updates`,
          message: "The update was downloaded, but the running app could not be stopped safely.",
          detail: "Quit Tovi completely and try the update again. No app files were replaced.",
          buttons: ["OK"]
        });
      }
    }
  });
  nativeUpdateLifecycle.start();
}

async function showPortConflictRecovery(conflict) {
  if (recoveryDialogOpen || shuttingDown) return;
  recoveryDialogOpen = true;
  try {
    const recoverable = conflict.recoverable === true;
    const result = await showMessageBox({
      type: "warning",
      title: APP_NAME,
      message: recoverable ? `Another copy of ${APP_NAME} is still running.` : `Another app is blocking ${APP_NAME}.`,
      detail: recoverable
        ? `An older ${APP_NAME} process is using port ${conflict.port}. ${APP_NAME} can stop it safely and start this copy. Your message data is not removed.`
        : `Port ${conflict.port} is being used by another application. Close that application, then choose Retry. Show Logs opens the diagnostic log.`,
      buttons: recoverable ? [`Stop old ${APP_NAME} and retry`, "Show Logs", "Quit"] : ["Retry", "Show Logs", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (result.response === 0) {
      reclaimPortConflictsOnce = recoverable;
      await restartLocalApp();
    } else if (result.response === 1) {
      if (currentLogPath) shell.showItemInFolder(currentLogPath);
      else await shell.openPath(storagePaths().logsDir);
    } else app.quit();
  } finally {
    recoveryDialogOpen = false;
  }
}

async function stopVerifiedRuntimeTree() {
  const node = pickNodeExecutable();
  if (!node) throw new Error("The bundled Node.js runtime is unavailable");
  const paths = storagePaths();
  const environment = startAppEnvironment(process.env, node, {
    appDir: APP_DIR,
    configDir: paths.configDir,
    dataDir: paths.dataDir,
    packaged: app.isPackaged,
    stateDir: paths.stateDir,
    nativeUpdateRequest
  });
  await new Promise((resolveStop, rejectStop) => {
    const stopper = spawn(node, [
      join(APP_DIR, "scripts", "stop-existing-install.mjs"),
      "--app-dir",
      APP_DIR,
      "--backend-only",
      "--preserve-pid",
      String(process.pid)
    ], {
      cwd: APP_DIR,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    stopper.stderr.on("data", (chunk) => (stderr += chunk));
    const timeout = setTimeout(() => {
      try { stopper.kill("SIGKILL"); } catch {}
      rejectStop(new Error("Timed out while verifying that the local runtime stopped"));
    }, 20_000);
    stopper.once("error", (error) => {
      clearTimeout(timeout);
      rejectStop(error);
    });
    stopper.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveStop();
      else rejectStop(new Error(stderr.trim() || `Runtime stopper exited with code ${code}`));
    });
  });
}

async function stopLocalApp({ verifyRuntimeTree = false } = {}) {
  const child = appProcess;
  if (child) {
    expectedProcessExits.add(child);
    await new Promise((resolveStop, rejectStop) => {
      let settled = false;
      let forceTimer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (error) rejectStop(error);
        else resolveStop();
      };
      child.once("exit", () => finish());
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
          finish();
          return;
        }
        forceTimer = setTimeout(() => {
          finish(new Error("The local app process did not exit after it was force-stopped"));
        }, 2_000);
      }, STOP_TIMEOUT_MS).unref();
    });
    if (appProcess === child) appProcess = null;
  }
  if (verifyRuntimeTree) await stopVerifiedRuntimeTree();
}

async function restartLocalApp() {
  if (shuttingDown) return;
  ++lifecycleGeneration;
  showLoading(`Restarting ${APP_NAME}...`);
  try {
    await stopLocalApp({ verifyRuntimeTree: true });
  } catch (error) {
    writeLog(`Refused restart because the local runtime did not stop: ${error.message}`);
    await showMessageBox({
      type: "warning",
      title: APP_NAME,
      message: `${APP_NAME} could not stop its running services safely.`,
      detail: "The restart was cancelled so a second copy could not start. Quit the app completely, then open it again.",
      buttons: ["OK"]
    });
    return;
  }
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
      message: `${APP_NAME} needs help starting.`,
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
  if (!desktopCapabilities(process.platform).imessageSupported) {
    return { status: "unsupported", path: "" };
  }
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
  if (!desktopCapabilities(process.platform).macPermissionsSupported) {
    if (onlyWhenMissing) return;
    await showMessageBox({
      type: "info",
      title: "Windows permissions",
      message: "No extra Windows permissions are needed.",
      detail: "LinkedIn uses Chrome and WhatsApp connects through a QR code. iMessage is only available on macOS.",
      buttons: ["Done"],
      defaultId: 0,
      noLink: true
    });
    return;
  }
  const access = messagesAccessStatus();
  if (onlyWhenMissing && access.status === "granted") return;
  if (access.status === "messages_not_set_up") {
    const result = await showMessageBox({
      type: "info",
      title: "Set up Messages",
      message: "Messages is not ready on this Mac.",
      detail:
        `1. Open the Messages app.\n2. Sign in and confirm a conversation is visible.\n3. Return to ${APP_NAME} and choose Check Permissions from the app menu.\n\nNo SIP changes are required.`,
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
      message: `${APP_NAME} needs Full Disk Access to read your local Messages database.`,
      detail:
        `1. Open System Settings, then Privacy & Security, then Full Disk Access.\n2. Turn on ${APP_NAME}. If it is not listed, use the plus button and choose the app from Applications.\n3. Quit and reopen ${APP_NAME}, then choose Check Permissions.\n\nContacts names use the same local access. Sending asks separately for Automation only when you choose Send. File attachments may also ask for Accessibility. No SIP changes are required.`,
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
      `Automation is requested only when you choose Send. Allow ${APP_NAME} to control Messages, then retry the send. File attachments may also require Accessibility. Contacts names are read locally and are never uploaded by the desktop app.`,
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

// Dispatch a DOM CustomEvent inside the dashboard page. Used by menu items
// that trigger in-app surfaces (the pilot feedback modal listens for
// "pilot-feedback-open" on window — see dashboard lib/pilot.ts). Serialised
// through JSON so no page content can leak into main-process code.
function dispatchInApp(eventName, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${JSON.stringify(detail ?? null)} })); undefined;`;
  mainWindow.webContents.executeJavaScript(script, true).catch((error) => {
    writeLog(`Could not dispatch ${eventName}: ${error.message}`);
  });
}

function goInHistory(direction) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents) return;
  const history = contents.navigationHistory;
  if (direction === "back" && history.canGoBack()) history.goBack();
  if (direction === "forward" && history.canGoForward()) history.goForward();
}

function runInPage(expression) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents) return Promise.resolve(undefined);
  return contents.executeJavaScript(expression, true).catch((error) => {
    writeLog(`Could not run page script: ${error.message}`);
    return undefined;
  });
}

function getRunnerJson(path) {
  return new Promise((resolveJson) => {
    let handle;
    try {
      handle = get(`http://127.0.0.1:${runnerPort(process.env)}${path}`, { timeout: 2500 }, (response) => {
        if (!(response.statusCode > 0 && response.statusCode < 400)) {
          response.resume();
          resolveJson(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 256_000) body += chunk;
        });
        response.on("end", () => {
          try {
            resolveJson(JSON.parse(body));
          } catch {
            resolveJson(null);
          }
        });
      });
    } catch {
      resolveJson(null);
      return;
    }
    handle.on("timeout", () => {
      handle.destroy();
      resolveJson(null);
    });
    handle.on("error", () => resolveJson(null));
  });
}

async function refreshFavourites() {
  const data = await getRunnerJson("/data/favourites");
  if (!Array.isArray(data)) return;
  const next = data
    .filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && item.name.trim())
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      name: String(item.name),
      threadId: typeof item.threadId === "string" ? item.threadId : null
    }));
  if (JSON.stringify(next) === JSON.stringify(favouriteContacts)) return;
  favouriteContacts = next;
  createMenu();
}

function openFavourite(contact) {
  if (contact.threadId) openDashboardPath(`/thread/${encodeURIComponent(contact.threadId)}`);
  else openDashboardPath(`/inbox?q=${encodeURIComponent(contact.name)}`);
}

function textSizeScript(op, arg) {
  return `(function(){
  var order = ${JSON.stringify(TEXT_SIZE_LEVELS)};
  var KEY = ${JSON.stringify(UI_SCALE_STORAGE_KEY)};
  var EVENT = ${JSON.stringify(UI_SCALE_CHANGE_EVENT)};
  var bridge = window.__toviUiScale;
  function read(){
    var attr = document.documentElement.getAttribute("data-ui-scale");
    if (attr === "large" || attr === "extra") return attr;
    try { var s = localStorage.getItem(KEY); if (s === "large" || s === "extra") return s; } catch (e) {}
    return "normal";
  }
  function apply(next){
    if (order.indexOf(next) < 0) next = "normal";
    if (next === "normal") document.documentElement.removeAttribute("data-ui-scale");
    else document.documentElement.setAttribute("data-ui-scale", next);
    try { if (next === "normal") localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { scale: next } })); } catch (e) {}
    return next;
  }
  function step(dir){
    var i = order.indexOf(read()); if (i < 0) i = 0;
    var j = Math.max(0, Math.min(order.length - 1, dir === "down" ? i - 1 : i + 1));
    return apply(order[j]);
  }
  var op = ${JSON.stringify(op)}, arg = ${JSON.stringify(arg ?? null)};
  if (op === "get") return bridge && bridge.get ? bridge.get() : read();
  if (op === "set") return bridge && bridge.set ? bridge.set(arg) : apply(arg);
  if (op === "step") return bridge && bridge.step ? bridge.step(arg) : step(arg);
  return read();
})();`;
}

async function applyTextSize(op, arg) {
  const result = await runInPage(textSizeScript(op, arg));
  if (typeof result !== "string" || !TEXT_SIZE_LEVELS.includes(result)) return;
  const changed = result !== currentTextSize;
  currentTextSize = result;
  if (changed || op === "get") createMenu();
}

function refreshMenuState() {
  void refreshFavourites();
  void applyTextSize("get");
}

function textSizeMenu() {
  const level = (label, value) => ({
    label,
    type: "radio",
    checked: currentTextSize === value,
    click: () => void applyTextSize("set", value)
  });
  return {
    label: "Text Size",
    submenu: [
      { label: "Bigger", accelerator: "CommandOrControl+=", click: () => void applyTextSize("step", "up") },
      { label: "Smaller", accelerator: "CommandOrControl+-", click: () => void applyTextSize("step", "down") },
      { label: "Actual Size", accelerator: "CommandOrControl+0", click: () => void applyTextSize("set", "normal") },
      { type: "separator" },
      level("Normal", "normal"),
      level("Large", "large"),
      level("Extra Large", "extra")
    ]
  };
}

function favouriteMenuItems() {
  if (favouriteContacts.length === 0) {
    return [{ label: "No favourites yet", enabled: false }];
  }
  return favouriteContacts.map((contact, index) => ({
    label: contact.name,
    accelerator: index < 9 ? `CommandOrControl+Shift+${index + 1}` : undefined,
    click: () => openFavourite(contact)
  }));
}

function settingsSectionsSubmenu() {
  return [
    { label: "All Settings", click: () => openDashboardPath("/settings") },
    { type: "separator" },
    { label: "Platforms", click: () => openDashboardPath("/settings#platforms") },
    { label: "Notifications", click: () => openDashboardPath("/settings#notifications") },
    { label: "Reply Style", click: () => openDashboardPath("/settings#writing") },
    { label: "Focus", click: () => openDashboardPath("/settings#focus") },
    { label: "App & Updates", click: () => openDashboardPath("/settings#app") }
  ];
}

function createMenu() {
  const macPermissionsSupported = desktopCapabilities(process.platform).macPermissionsSupported;
  const appMenu = [
    { role: "about" },
    { type: "separator" },
    { label: "Settings...", accelerator: "CommandOrControl+,", click: () => openDashboardPath("/settings") },
    { label: `Use ${APP_NAME} on Your Phone...`, click: () => openDashboardPath("/settings#phone") },
    { type: "separator" },
    ...(macPermissionsSupported
      ? [{ label: "Check Permissions...", click: () => void showPermissionHelp() }]
      : []),
    { label: "Retry Startup", click: () => void restartLocalApp() },
    { label: "Show Logs", click: () => void shell.openPath(storagePaths().logsDir) },
    { type: "separator" },
    ...(process.platform === "darwin"
      ? [{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }]
      : []),
    { role: "quit" }
  ];
  const template = [
    {
      label: APP_NAME,
      submenu: appMenu
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: "CommandOrControl+[", click: () => goInHistory("back") },
        { label: "Forward", accelerator: "CommandOrControl+]", click: () => goInHistory("forward") },
        { role: "reload" },
        { type: "separator" },
        textSizeMenu(),
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Go",
      submenu: [
        { label: "Today", accelerator: "CommandOrControl+1", click: () => openDashboardPath("/today") },
        { label: "Inbox", accelerator: "CommandOrControl+2", click: () => openDashboardPath("/inbox") },
        { label: "Reconnect", accelerator: "CommandOrControl+3", click: () => openDashboardPath("/reconnect") },
        { label: "Archived", accelerator: "CommandOrControl+4", click: () => openDashboardPath("/archived") },
        { label: "People", accelerator: "CommandOrControl+5", click: () => openDashboardPath("/people") },
        { type: "separator" },
        { label: "Settings", submenu: settingsSectionsSubmenu() }
      ]
    },
    {
      label: "Favourites",
      submenu: [
        ...favouriteMenuItems(),
        { type: "separator" },
        { label: "All People...", click: () => openDashboardPath("/people") }
      ]
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
    {
      label: "Help",
      submenu: [
        { label: "Send Feedback...", click: () => dispatchInApp("pilot-feedback-open", { type: "feedback" }) },
        { label: "Report a Bug...", click: () => dispatchInApp("pilot-feedback-open", { type: "bug" }) },
        { type: "separator" },
        ...(macPermissionsSupported
          ? [{ label: "Check Permissions...", click: () => void showPermissionHelp() }]
          : []),
        { label: "Show Logs", click: () => void shell.openPath(storagePaths().logsDir) }
      ]
    }
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
  mainWindow.on("focus", () => {
    if (!shuttingDown && appProcess) refreshMenuState();
  });
  mainWindow.on("unresponsive", () => {
    if (!shuttingDown) void showStartupRecovery("The app window stopped responding.");
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    writeLog(`Window process stopped: reason=${details.reason} exitCode=${details.exitCode}`);
    if (!shuttingDown) void showStartupRecovery("The app window closed unexpectedly.");
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    // Never replace the app inside the main window. Routing internal URLs
    // through loadURL() here meant a target="_blank" photo or document
    // swapped the whole window for the raw file with no back button — the
    // operator was stranded until they found the Settings menu item
    // (R-0103 / #821). The dashboard now opens photos in an in-app viewer,
    // and internal URLs are plain http on localhost, so the default browser
    // renders/downloads them fine and has its own chrome + back button.
    if (isSafeExternalUrl(targetUrl)) {
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
    await configureNativeUpdater();
    startMenuRefreshTimer();
    const generation = startLocalApp();
    if (generation) void loadDashboardWhenReady(mainWindow, dashboardUrl(process.env), generation);
  }).catch((error) => {
    writeLog(`Desktop startup failed: ${error.message}`);
    dialog.showErrorBox(APP_NAME, `${APP_NAME} could not start.\n\n${error.message}`);
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
    if (menuRefreshTimer) {
      clearInterval(menuRefreshTimer);
      menuRefreshTimer = null;
    }
    nativeUpdateLifecycle?.stop();
    void stopLocalApp({ verifyRuntimeTree: true })
      .then(() => {
        quitReady = true;
        if (logStream) {
          logStream.end();
          logStream = null;
        }
        app.quit();
      })
      .catch(async (error) => {
        quitInProgress = false;
        shuttingDown = false;
        writeLog(`Refused quit because the local runtime did not stop: ${error.message}`);
        startMenuRefreshTimer();
        nativeUpdateLifecycle?.start();
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        await showMessageBox({
          type: "warning",
          title: APP_NAME,
          message: `${APP_NAME} could not stop its running services safely.`,
          detail: "The desktop app remains open so background work is not hidden. Try quitting again. If this keeps happening, restart the computer before reopening Tovi.",
          buttons: ["OK"]
        });
      });
  });
}
