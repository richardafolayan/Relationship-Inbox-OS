import { createRequire } from "node:module";
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
  assert.equal(env.PATH, "/tmp/node22/bin:/usr/bin");
  assert.equal(env.OTHER, "keep");
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
  assert.match(html, /Relationship Inbox OS/);
  assert.doesNotMatch(html, /https?:\/\//);
});
