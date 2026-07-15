import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const launcher = require("../apps/desktop/launcher.cjs");

test("dashboardUrl uses the dashboard port and keeps localhost local", () => {
  assert.equal(launcher.dashboardUrl({ DASHBOARD_PORT: "3199" }), "http://localhost:3199");
  assert.equal(launcher.dashboardUrl({ DASHBOARD_PORT: "" }), "http://localhost:3100");
  assert.equal(
    launcher.isLocalDashboardUrl("http://localhost:3199/thread/abc", { DASHBOARD_PORT: "3199" }),
    true
  );
  assert.equal(
    launcher.isLocalDashboardUrl("https://example.com", { DASHBOARD_PORT: "3199" }),
    false
  );
  assert.equal(
    launcher.isLocalDashboardUrl("http://localhost:4001/health", { DASHBOARD_PORT: "3199" }),
    false
  );
  assert.equal(launcher.isInternalAppUrl("data:text/html;charset=utf-8,<p>Loading</p>"), true);
});

test("startAppEnvironment pins desktop ports and marks desktop mode", () => {
  const env = launcher.startAppEnvironment({
    DASHBOARD_PORT: "3222",
    RUNNER_PORT: "4555",
    PATH: "/usr/bin",
    OTHER: "keep"
  }, "/tmp/node22/bin/node");
  assert.equal(env.DASHBOARD_PORT, "3222");
  assert.equal(env.RUNNER_PORT, "4555");
  assert.equal(env.RIOS_DESKTOP, "1");
  assert.equal(env.RIOS_RECLAIM_EXISTING, "1");
  assert.equal(env.OTHER, "keep");
  // The bundled Node must win, the caller's PATH stays, and the GUI-launch
  // fallback system paths come last so a terminal PATH is never shadowed.
  const parts = env.PATH.split(":");
  assert.equal(parts[0], "/tmp/node22/bin");
  assert.ok(parts.includes("/usr/bin"));
  assert.ok(env.PATH.endsWith("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
});

test("startAppEnvironment carries packaged storage locations to the launcher", () => {
  const env = launcher.startAppEnvironment({ PATH: "/usr/bin" }, "/tmp/node22/bin/node", {
    appDir: "/tmp/app",
    configDir: "/tmp/config",
    dataDir: "/tmp/config/data",
    stateDir: "/tmp/config/state",
    packaged: true
  });
  assert.equal(env.RIOS_CONFIG_DIR, "/tmp/config");
  assert.equal(env.RIOS_DATA_DIR, "/tmp/config/data");
  assert.equal(env.RIOS_STATE_DIR, "/tmp/config/state");
  assert.equal(env.RIOS_PACKAGED_APP, "1");
});

test("Windows desktop launch uses the bundled Node runtime and Windows capabilities", () => {
  const appDir = "C:\\Program Files\\Tovi\\resources\\app";
  assert.equal(
    launcher.bundledNodePath(appDir, "win32"),
    "C:\\Program Files\\Tovi\\resources\\runtime\\node\\node.exe"
  );

  const env = launcher.startAppEnvironment(
    { PATH: "C:\\Windows\\System32" },
    "C:\\Program Files\\Tovi\\resources\\runtime\\node\\node.exe",
    { appDir, platform: "win32" }
  );
  assert.match(env.PATH, /runtime\\node/);
  assert.doesNotMatch(env.PATH, /homebrew/);

  assert.deepEqual(launcher.desktopCapabilities("win32"), {
    imessageSupported: false,
    imessageUnavailableReason: "iMessage is only available on macOS.",
    macPermissionsSupported: false
  });
  assert.deepEqual(launcher.packagedFeatureDefaults("win32"), {
    BROWSER_PROFILE_MODE: "isolated",
    IMESSAGE_ENABLED: "false",
    WHATSAPP_ENABLED: "true"
  });
});

test("desktopPaths keeps config, data, state and logs outside the app bundle", () => {
  const paths = launcher.desktopPaths({
    userData: "/Users/s/Library/Application Support/Relationship Inbox OS",
    logs: "/Users/s/Library/Logs/RelationshipInboxOS",
    home: "/Users/s"
  });
  assert.equal(paths.configDir, "/Users/s/Library/Application Support/Relationship Inbox OS");
  assert.equal(paths.dataDir, join(paths.configDir, "data"));
  assert.equal(paths.stateDir, join(paths.configDir, "state"));
  assert.equal(paths.logsDir, "/Users/s/Library/Logs/RelationshipInboxOS");
  assert.equal(paths.legacyDir, "/Users/s/RelationshipInboxOS");
});

test("mergeEnvValues forces keys, preserves comments, and keepExisting only fills gaps", () => {
  const input = "# comment\nDATABASE_URL=file:./old.sqlite\nIMESSAGE_ENABLED=false\n";
  const forced = launcher.mergeEnvValues(input, { DATABASE_URL: "file:/new/inbox.sqlite" });
  assert.match(forced, /^# comment$/m);
  assert.match(forced, /^DATABASE_URL=file:\/new\/inbox\.sqlite$/m);
  assert.match(forced, /^IMESSAGE_ENABLED=false$/m);

  const defaults = launcher.mergeEnvValues(forced, {
    IMESSAGE_ENABLED: "true",
    BROWSER_PROFILE_MODE: "personal"
  }, { keepExisting: true });
  // The user's explicit choice survives; missing keys are appended.
  assert.match(defaults, /^IMESSAGE_ENABLED=false$/m);
  assert.match(defaults, /^BROWSER_PROFILE_MODE=personal$/m);
});

test("isSafeExternalUrl allows web and mail links only", () => {
  assert.equal(launcher.isSafeExternalUrl("https://example.com"), true);
  assert.equal(launcher.isSafeExternalUrl("mailto:someone@example.com"), true);
  assert.equal(launcher.isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(launcher.isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(launcher.isSafeExternalUrl("not a url"), false);
});

test("node version helpers require Node 22", () => {
  assert.equal(launcher.parseNodeMajor("v22.21.1"), 22);
  assert.equal(launcher.parseNodeMajor("25.4.0"), 25);
  assert.equal(launcher.parseNodeMajor("not node"), null);
  assert.equal(launcher.isSupportedNodeVersion("v22.21.1"), true);
  assert.equal(launcher.isSupportedNodeVersion("v25.4.0"), false);
});

test("resolveAppDir and startAppArgs point at the existing launcher", () => {
  const appDir = launcher.resolveAppDir(resolve("apps/desktop"));
  assert.equal(appDir, resolve("."));
  assert.deepEqual(launcher.startAppArgs(appDir), [join(appDir, "scripts", "start-app.mjs")]);
});

test("loadingHtml uses the product name and no external assets", () => {
  const html = launcher.loadingHtml();
  assert.match(html, /Tovi/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("rebrand pins storage and permissions to the pre-Tovi identifiers", () => {
  // The app displays as Tovi, but the storage folder and log folder must keep
  // their original names: every existing install's database lives there, and
  // macOS TCC grants are keyed to the unchanged bundle id. Dropping either
  // pin strands user data on the next update.
  assert.equal(launcher.APP_NAME, "Tovi");
  assert.equal(launcher.STORAGE_DIR_NAME, "Relationship Inbox OS");
  assert.equal(launcher.LOGS_DIR_NAME, "RelationshipInboxOS");
  assert.equal(launcher.APP_ID, "relationship-inbox-os");

  const mainSource = readFileSync(
    join(resolve("apps/desktop"), "main.cjs"),
    "utf8"
  );
  const pin = /app\.setPath\(\s*"userData",\s*join\(app\.getPath\("appData"\),\s*STORAGE_DIR_NAME\)\s*\)/;
  assert.match(mainSource, pin, "main.cjs must pin userData before anything resolves storage paths");
  assert.ok(
    mainSource.indexOf('app.setPath("userData"') < mainSource.indexOf("function storagePaths"),
    "the userData pin must run before storagePaths() can be called"
  );
});

test("desktop recovery offers a one-click fix only for verified Tovi conflicts", () => {
  const mainSource = readFileSync(join(resolve("apps/desktop"), "main.cjs"), "utf8");
  assert.match(mainSource, /Stop old Tovi and retry/);
  assert.match(mainSource, /conflict\.recoverable === true/);
  assert.match(mainSource, /RIOS_RECLAIM_PORT_CONFLICTS/);
});
