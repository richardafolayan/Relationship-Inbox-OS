import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNewer, validateLatestJson } from "../scripts/lib/release-manifest.mjs";
import {
  DEFAULT_DMG_CHANNEL, channelReleaseVersion, devUpdateFeedUrl
} from "../scripts/build-macos-dmg.mjs";
import {
  canSelfUpdateInPlace, containingAppBundle, resolveUpdateFeedUrl
} from "../apps/runner/dist/services/system-update.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATER = join(ROOT, "scripts", "update-student.mjs");
const HELPER = join(ROOT, "scripts", "apply-update-and-restart.mjs");
const BUILD = join(ROOT, "scripts", "build-student-release.mjs");

function runNode(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env }
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ---- version ordering across dev builds ------------------------------------

test("dev prerelease versions order numerically, and a release outranks them", () => {
  assert.ok(isNewer("0.1.15-dev.101", "0.1.15-dev.99"), "commit-count compare must be numeric");
  assert.ok(!isNewer("0.1.15-dev.99", "0.1.15-dev.101"));
  assert.ok(isNewer("0.1.16-dev.5", "0.1.15-dev.900"), "core version dominates");
  assert.ok(isNewer("0.1.15", "0.1.15-dev.900"), "a full release outranks its dev builds");
});

// ---- manifest channel validation -------------------------------------------

test("latest.json channel is optional but must be a non-empty string when present", () => {
  const base = {
    version: "0.1.0", build: "2026-06-06T00:00:00Z", commit: "abc1234",
    zipUrl: "https://example.com/app.zip?dl=1", sha256: "a".repeat(64),
    releaseNotes: [], minimumInstallerVersion: "0.1.0"
  };
  assert.equal(validateLatestJson(base).ok, true, "channel-less manifests stay valid");
  assert.equal(validateLatestJson({ ...base, channel: "dev" }).ok, true);
  assert.equal(validateLatestJson({ ...base, channel: "" }).ok, false);
  assert.equal(validateLatestJson({ ...base, channel: 7 }).ok, false);
});

// ---- runner service helpers -------------------------------------------------

test("resolveUpdateFeedUrl prefers the baked dev feed over the env feed", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-feed-"));
  try {
    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "0.1.15-dev.100", channel: "dev",
      updateFeedUrl: "https://github.com/o/r/releases/download/dev/latest.json"
    }));
    assert.equal(
      resolveUpdateFeedUrl(dir, "https://dropbox.example/latest.json?raw=1"),
      "https://github.com/o/r/releases/download/dev/latest.json"
    );
    // A student install keeps the configured feed even if a stray URL exists.
    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "0.1.15", channel: "student",
      updateFeedUrl: "https://github.com/o/r/releases/download/dev/latest.json"
    }));
    assert.equal(
      resolveUpdateFeedUrl(dir, "https://dropbox.example/latest.json?raw=1"),
      "https://dropbox.example/latest.json?raw=1"
    );
    // A dev install with NO baked feed must NOT fall back to the pilot Dropbox
    // feed (wrong channel/stale version). It reports "not configured" instead.
    // This is the exact strand a pre-fix dev zip caused after the first update.
    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "0.1.15-dev.101", channel: "dev"
    }));
    assert.equal(
      resolveUpdateFeedUrl(dir, "https://dropbox.example/latest.json?raw=1"),
      undefined
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canSelfUpdateInPlace gates packaged installs on the native signed updater", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-gate-"));
  try {
    writeFileSync(join(dir, "release.json"), JSON.stringify({ version: "1.0.0-dev.1", channel: "dev" }));
    assert.equal(canSelfUpdateInPlace(dir, true), false, "legacy ad-hoc dev apps cannot safely replace themselves");
    assert.equal(canSelfUpdateInPlace(dir, false), true);
    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "1.0.0-dev.2", channel: "dev", updateMode: "squirrel-mac"
    }));
    assert.equal(canSelfUpdateInPlace(dir, true), true);
    writeFileSync(join(dir, "release.json"), JSON.stringify({ version: "1.0.0", channel: "student" }));
    assert.equal(canSelfUpdateInPlace(dir, true), false);
    assert.equal(canSelfUpdateInPlace(dir, false), true, "zip installs always self-update");
    // No release.json at all (old DMG installs) = not dev = replace-app.
    rmSync(join(dir, "release.json"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    assert.equal(canSelfUpdateInPlace(dir, true), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("containingAppBundle recognises the packaged layout only", () => {
  assert.equal(
    containingAppBundle("/Applications/Tovi.app/Contents/Resources/app"),
    "/Applications/Tovi.app"
  );
  assert.equal(containingAppBundle("/Users/someone/RelationshipInboxOS"), "");
  assert.equal(containingAppBundle("/Applications/Tovi.app/Contents/other/app"), "");
});

// ---- DMG builder helpers -----------------------------------------------------

test("DMG channel stamping: dev default, dev version suffix, derived feed URL", () => {
  assert.equal(DEFAULT_DMG_CHANNEL, "dev");
  const dev = channelReleaseVersion("dev", "HEAD");
  assert.match(dev, /^\d+\.\d+\.\d+-dev\.\d+$/);
  const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.ok(dev.endsWith(`-dev.${count}`), "suffix must be the ref's commit count");
  assert.match(channelReleaseVersion("student", "HEAD"), /^\d+\.\d+\.\d+$/);

  assert.equal(
    devUpdateFeedUrl(ROOT, { RIOS_DEV_UPDATE_FEED_URL: "https://example.com/feed.json" }),
    "https://example.com/feed.json"
  );
  assert.match(
    devUpdateFeedUrl(ROOT, {}),
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/dev\/latest\.json$/
  );
});

// ---- release builder dev channel ---------------------------------------------

test("build-student-release --channel dev stamps version, channel, and floor", () => {
  const out = mkdtempSync(join(tmpdir(), "rios-dev-build-"));
  try {
    const feedUrl = "https://github.com/o/r/releases/download/dev/latest.json";
    execFileSync(process.execPath, [
      BUILD, "--channel", "dev", "--out", out,
      "--zip-url", "https://github.com/o/r/releases/download/dev/relationship-inbox-os-dev-latest.zip",
      "--update-feed-url", feedUrl
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, RIOS_RELEASE_ENV_FILE: "/nonexistent/.env.release.local" }
    });

    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.match(manifest.version, /^\d+\.\d+\.\d+-dev\.\d+$/);
    assert.equal(manifest.channel, "dev");
    // Below any real version: 0.1.0-dev.N ranks UNDER 0.1.0 in semver, so a
    // 0.1.0 floor would block a 0.1.0-core dev install from updating.
    assert.equal(manifest.minimumInstallerVersion, "0.0.1");
    assert.equal(validateLatestJson(manifest).ok, true);
    assert.match(manifest.releaseNotes[0], /^Dev build /);

    const latestZip = join(out, "relationship-inbox-os-dev-latest.zip");
    assert.ok(existsSync(latestZip), "dev zips use the -dev- name");
    assert.ok(existsSync(join(out, `relationship-inbox-os-dev-${manifest.version}.zip`)));
    const release = JSON.parse(execFileSync(
      "unzip", ["-p", latestZip, "relationship-inbox-os/release.json"], { encoding: "utf8" }
    ));
    assert.equal(release.channel, "dev");
    assert.equal(release.version, manifest.version);
    // The self-update feed MUST be baked into the ZIP's release.json so it
    // survives each in-place update; without it a dev install reverts to the
    // pilot feed after the first update (the strand this test guards against).
    assert.equal(release.updateFeedUrl, feedUrl);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("build-student-release explicit dev feed overrides the environment default", () => {
  const out = mkdtempSync(join(tmpdir(), "rios-dev-explicit-feed-"));
  try {
    const feedUrl = "https://github.com/o/r/releases/download/dev/latest.json";
    execFileSync(process.execPath, [
      BUILD, "--channel", "dev", "--out", out,
      "--zip-url", "https://github.com/o/r/releases/download/dev/relationship-inbox-os-dev-latest.zip",
      "--update-feed-url", feedUrl
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...process.env,
        RIOS_RELEASE_ENV_FILE: "/nonexistent/.env.release.local",
        RIOS_DEV_UPDATE_FEED_URL: "https://github.com/stale/fork/releases/download/dev/latest.json"
      }
    });
    const release = JSON.parse(execFileSync(
      "unzip", ["-p", join(out, "relationship-inbox-os-dev-latest.zip"), "relationship-inbox-os/release.json"],
      { encoding: "utf8" }
    ));
    assert.equal(release.updateFeedUrl, feedUrl);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("build-student-release --channel dev derives the feed URL from git origin", () => {
  const out = mkdtempSync(join(tmpdir(), "rios-dev-derive-"));
  try {
    // No --update-feed-url and no RIOS_DEV_UPDATE_FEED_URL: the builder must
    // derive it from the repo's origin so a plain `--channel dev` build is
    // still self-perpetuating.
    execFileSync(process.execPath, [
      BUILD, "--channel", "dev", "--out", out,
      "--zip-url", "https://github.com/o/r/releases/download/dev/relationship-inbox-os-dev-latest.zip"
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, RIOS_RELEASE_ENV_FILE: "/nonexistent/.env.release.local", RIOS_DEV_UPDATE_FEED_URL: "" }
    });
    const release = JSON.parse(execFileSync(
      "unzip", ["-p", join(out, "relationship-inbox-os-dev-latest.zip"), "relationship-inbox-os/release.json"],
      { encoding: "utf8" }
    ));
    assert.match(
      release.updateFeedUrl,
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/dev\/latest\.json$/
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("build-student-release rejects an unknown channel", () => {
  assert.throws(() => {
    execFileSync(process.execPath, [BUILD, "--channel", "nightly"], { cwd: ROOT, stdio: "pipe" });
  }, /Unknown --channel/);
});

// ---- updater: channel guard, backup root, re-sign ------------------------------

test("dev updater: channel guard, backup root outside the bundle, ad-hoc re-sign", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "rios-dev-updater-"));
  // A pretend packaged install: Tovi.app/Contents/Resources/app
  const bundle = join(work, "Tovi.app");
  const appDir = join(bundle, "Contents", "Resources", "app");
  const backupRoot = join(work, "backups");
  mkdirSync(join(appDir, "data"), { recursive: true });
  mkdirSync(backupRoot, { recursive: true });

  const seedInstall = (channel) => {
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.1.0" }));
    writeFileSync(join(appDir, "release.json"), JSON.stringify({ version: "0.1.0-dev.1", channel }));
  };
  seedInstall("dev");

  // A newer dev release zip.
  const stage = join(work, "stage");
  const inner = join(stage, "relationship-inbox-os");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.1.0" }));
  writeFileSync(join(inner, "release.json"), JSON.stringify({
    version: "0.1.0-dev.2",
    channel: "dev",
    updateFeedUrl: "https://github.com/o/r/releases/download/dev/latest.json"
  }));
  writeFileSync(join(inner, "NEWCODE.txt"), "dev.2");
  const zipPath = join(work, "app.zip");
  execFileSync("zip", ["-r", "-q", zipPath, "relationship-inbox-os"], { cwd: stage });
  const zipBuf = readFileSync(zipPath);
  const sha = createHash("sha256").update(zipBuf).digest("hex");

  // PATH shim: record codesign invocations instead of really signing.
  const shims = join(work, "shims");
  mkdirSync(shims, { recursive: true });
  const codesignLog = join(work, "codesign.log");
  writeFileSync(join(shims, "codesign"), `#!/bin/sh\necho "$@" >> "${codesignLog}"\n`);
  chmodSync(join(shims, "codesign"), 0o755);

  const manifest = (channel, version = "0.1.0-dev.2") => JSON.stringify({
    version, build: "2026-06-06T00:00:00Z", commit: "deadbee", channel,
    zipUrl: `http://localhost:${PORT}/app.zip`, sha256: sha,
    releaseNotes: ["dev build"], minimumInstallerVersion: "0.0.1"
  });
  let PORT;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/dev.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest("dev"));
    }
    if (req.url.startsWith("/student.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest("student", "0.2.0"));
    }
    if (req.url.startsWith("/app.zip")) {
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(zipBuf);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, r));
  PORT = server.address().port;
  const url = (p) => `http://localhost:${PORT}${p}`;
  const env = { PATH: `${shims}:${process.env.PATH}`, RIOS_APP_BUNDLE_DIR: join(work, "no-bundles") };

  try {
    await t.test("a dev install refuses a student feed", async () => {
      const { code, stderr } = await runNode(UPDATER, [
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/student.json")
      ], env);
      assert.notEqual(code, 0);
      assert.match(stderr, /channel/i);
      assert.ok(!existsSync(join(appDir, "NEWCODE.txt")), "install was modified despite channel mismatch");
    });

    await t.test("apply with --backup-root and --resign swaps, backs up outside, re-signs", async () => {
      const { code, stdout } = await runNode(UPDATER, [
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/dev.json"),
        "--backup-root", backupRoot, "--resign", bundle, "--keep-backups", "1"
      ], env);
      assert.equal(code, 0, `updater failed:\n${stdout}`);
      assert.ok(existsSync(join(appDir, "NEWCODE.txt")), "new code missing");
      assert.equal(
        JSON.parse(readFileSync(join(appDir, "release.json"), "utf8")).version,
        "0.1.0-dev.2"
      );
      assert.equal(
        JSON.parse(readFileSync(join(appDir, "release.json"), "utf8")).updateFeedUrl,
        "https://github.com/o/r/releases/download/dev/latest.json"
      );
      const backups = readdirSync(backupRoot).filter((n) => n.startsWith(".rios-backup-"));
      assert.equal(backups.length, 1, "backup must land in --backup-root");
      const bundleEntries = readdirSync(join(bundle, "Contents", "Resources"));
      assert.ok(
        !bundleEntries.some((n) => n.startsWith(".rios-")),
        "no staging or backups may bloat the bundle"
      );
      const signed = readFileSync(codesignLog, "utf8");
      assert.match(signed, /--force --deep --sign - .*Tovi\.app/, "bundle was not re-signed");
      assert.ok(
        !existsSync(join(work, "no-bundles", "Tovi.app")),
        "packaged apply must not create a second ~/Applications bundle"
      );
    });
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(work, { recursive: true, force: true });
  }
});

// ---- apply-and-restart helper: packaged orchestration ---------------------------

test("apply helper in --bundle mode quits the app, clears the intent, and reopens it", async () => {
  const work = mkdtempSync(join(tmpdir(), "rios-dev-helper-"));
  const bundle = join(work, "Tovi.app");
  const appDir = join(bundle, "Contents", "Resources", "app");
  const dataDir = join(work, "app-support", "data");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // The helper runs the updater from INSIDE the install, like a real one.
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.1.0" }));
  writeFileSync(join(appDir, "release.json"), JSON.stringify({ version: "0.1.0-dev.2", channel: "dev" }));
  mkdirSync(join(appDir, "scripts", "lib"), { recursive: true });
  cpSync(UPDATER, join(appDir, "scripts", "update-student.mjs"));
  cpSync(join(ROOT, "scripts", "lib", "release-manifest.mjs"), join(appDir, "scripts", "lib", "release-manifest.mjs"));
  cpSync(join(ROOT, "scripts", "lib", "env-file.mjs"), join(appDir, "scripts", "lib", "env-file.mjs"));
  cpSync(join(ROOT, "scripts", "lib", "branding.mjs"), join(appDir, "scripts", "lib", "branding.mjs"));
  writeFileSync(join(dataDir, "pending-update.json"), JSON.stringify({ toVersion: "0.1.0-dev.2" }));

  // Shims: no real quit/kill/open, just a call log.
  const shims = join(work, "shims");
  mkdirSync(shims, { recursive: true });
  const callLog = join(work, "calls.log");
  for (const tool of ["osascript", "open", "pkill", "pgrep"]) {
    // pgrep exits 1 = "no such process", so the helper sees the app as gone.
    writeFileSync(
      join(shims, tool),
      `#!/bin/sh\necho "${tool} $@" >> "${callLog}"\n${tool === "pgrep" ? "exit 1" : "exit 0"}\n`
    );
    chmodSync(join(shims, tool), 0o755);
  }

  // Feed says the installed version is already current: the updater no-ops,
  // which exercises the quit -> update -> relaunch orchestration cheaply.
  const manifest = JSON.stringify({
    version: "0.1.0-dev.2", build: "2026-06-06T00:00:00Z", commit: "deadbee", channel: "dev",
    zipUrl: "https://example.com/app.zip?dl=1", sha256: "a".repeat(64),
    releaseNotes: [], minimumInstallerVersion: "0.0.1"
  });
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(manifest);
  });
  await new Promise((r) => server.listen(0, r));
  const feed = `http://localhost:${server.address().port}/latest.json`;

  try {
    const { code, stdout } = await runNode(HELPER, [
      "--url", feed, "--dir", appDir, "--bundle", bundle
    ], {
      PATH: `${shims}:${process.env.PATH}`,
      RIOS_DATA_DIR: dataDir,
      RIOS_CONFIG_DIR: join(work, "app-support"),
      // Unused local ports so the "is the app still up" probes come back down.
      DASHBOARD_PORT: "45771",
      RUNNER_PORT: "45772"
    });
    assert.equal(code, 0, `helper failed:\n${stdout}`);
    const calls = readFileSync(callLog, "utf8");
    assert.match(calls, /osascript -e quit app id /, "app was not asked to quit");
    assert.match(calls, new RegExp(`open ${bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "bundle was not reopened");
    assert.ok(!existsSync(join(dataDir, "pending-update.json")), "pending intent must be cleared");
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(work, { recursive: true, force: true });
  }
});
