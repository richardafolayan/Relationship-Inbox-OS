import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAutomaticUpdateScheduler, pendingUpdatePath, readAppVersion, runUpdateCheck, stagePendingUpdate
} from "../apps/runner/dist/services/system-update.js";
import { defaultSettings } from "../packages/core/dist/defaults.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("automatic update installation is on by default", () => {
  assert.equal(defaultSettings.automaticUpdates, true);
});

test("automatic update scheduler checks after startup and repeats", async () => {
  let installs = 0;
  let resolveRepeated;
  const repeated = new Promise((resolve) => {
    resolveRepeated = resolve;
  });
  const scheduler = createAutomaticUpdateScheduler({
    isEnabled: async () => true,
    installIfAvailable: async () => {
      installs += 1;
      if (installs === 2) resolveRepeated();
    },
    initialDelayMs: 5,
    intervalMs: 5
  });
  scheduler.start();
  try {
    await Promise.race([
      repeated,
      new Promise((_, reject) => setTimeout(() => reject(new Error("scheduler did not repeat")), 1000))
    ]);
    assert.equal(installs, 2);
  } finally {
    scheduler.stop();
  }
});

test("automatic update scheduler honours the off setting", async () => {
  let installs = 0;
  const scheduler = createAutomaticUpdateScheduler({
    isEnabled: async () => false,
    installIfAvailable: async () => {
      installs += 1;
    }
  });
  assert.equal(await scheduler.runNow(), "disabled");
  assert.equal(installs, 0);
});

// ---- readAppVersion ------------------------------------------------------

test("readAppVersion prefers release.json (with build, commit, and release notes)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-ver-"));
  try {
    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "9.9.9", build: "2026-06-06T00:00:00Z", commit: "abc1234", channel: "student",
      releaseNotes: ["A calmer update card", 123, "Clearer update steps"]
    }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }));
    const v = readAppVersion(dir);
    assert.equal(v.version, "9.9.9");
    assert.equal(v.commit, "abc1234");
    assert.equal(v.channel, "student");
    assert.deepEqual(v.releaseNotes, ["A calmer update card", "Clearer update steps"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAppVersion falls back to package.json, then to 0.0.0", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-ver2-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    assert.equal(readAppVersion(dir).version, "1.2.3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), "rios-ver3-"));
  try {
    assert.equal(readAppVersion(empty).version, "0.0.0");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// ---- stagePendingUpdate --------------------------------------------------

test("stagePendingUpdate writes the intent the start wrapper reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-intent-"));
  try {
    const intent = {
      requestedAt: "2026-06-06T00:00:00Z", fromVersion: "0.1.0",
      toVersion: "0.2.0", feedUrl: "https://example.com/latest.json?raw=1"
    };
    const path = stagePendingUpdate(join(dir, "data"), intent);
    assert.equal(path, pendingUpdatePath(join(dir, "data")));
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(written, intent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- runUpdateCheck (delegates to the real updater CLI) ------------------

test("runUpdateCheck reports an available update from a feed", async () => {
  // A throwaway app dir at 0.1.0 so 'current' is deterministic.
  const appDir = mkdtempSync(join(tmpdir(), "rios-app-"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ version: "0.1.0" }));

  const manifest = (version) => JSON.stringify({
    version, build: "2026-06-06T00:00:00Z", commit: "deadbee",
    zipUrl: "https://example.com/app.zip?dl=1", sha256: "a".repeat(64),
    releaseNotes: ["New stuff"], minimumInstallerVersion: "0.1.0"
  });

  const server = createServer((req, res) => {
    if (req.url.startsWith("/newer")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest("0.2.0"));
    }
    if (req.url.startsWith("/same")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest("0.1.0"));
    }
    if (req.url.startsWith("/html")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><html><body>Dropbox</body></html>");
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const updaterPath = join(REPO, "scripts", "update-student.mjs");
  const call = (path) =>
    runUpdateCheck({ projectRoot: appDir, feedUrl: `http://localhost:${port}${path}`, updaterPath, timeoutMs: 15000 });

  try {
    const newer = await call("/newer");
    assert.equal(newer.updateAvailable, true);
    assert.equal(newer.latestVersion, "0.2.0");
    assert.equal(newer.currentVersion, "0.1.0");
    assert.deepEqual(newer.currentReleaseNotes, []);
    assert.deepEqual(newer.releaseNotes, ["New stuff"]);
    assert.equal(newer.error, undefined);

    const same = await call("/same");
    assert.equal(same.updateAvailable, false);

    // A Dropbox HTML interstitial must fail safe, not crash.
    const html = await call("/html");
    assert.equal(html.updateAvailable, false);
    assert.ok(html.error, "expected an error for an HTML feed");
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(appDir, { recursive: true, force: true });
  }
});
