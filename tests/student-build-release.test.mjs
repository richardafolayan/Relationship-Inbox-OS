import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "scripts", "build-student-release.mjs");
const RELEASE_ENV = {
  ...process.env,
  RIOS_RELEASE_ENV_FILE: "/nonexistent/.env.release.local"
};

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env }
  }).trim();
}

function commitPackageVersion(version, work) {
  const index = join(work, "index");
  const pkgPath = join(work, "package.json");
  const pkg = JSON.parse(git(["show", "HEAD:package.json"]));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const env = { GIT_INDEX_FILE: index };
  git(["read-tree", "HEAD"], { env });
  const blob = git(["hash-object", "-w", pkgPath]);
  git(["update-index", "--cacheinfo", "100644", blob, "package.json"], { env });
  const tree = git(["write-tree"], { env });
  return git(["commit-tree", tree, "-p", "HEAD", "-m", `test package ${version}`], {
    env: {
      ...env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
}

function readZipReleaseJson(zipPath) {
  return JSON.parse(execFileSync(
    "unzip", ["-p", zipPath, "relationship-inbox-os/release.json"],
    { encoding: "utf8" }
  ));
}

test("build-student-release reads the release version from the archived ref", () => {
  const work = mkdtempSync(join(tmpdir(), "rios-build-release-test-"));
  const out = join(work, "release-dist");
  try {
    const ref = commitPackageVersion("9.8.7", work);
    execFileSync(process.execPath, [
      BUILD,
      "--ref", ref,
      "--out", out,
      "--notes", "A concise release summary"
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: RELEASE_ENV
    });

    const versionedZip = join(out, "relationship-inbox-os-student-9.8.7.zip");
    assert.ok(existsSync(versionedZip), "zip filename should use the ref package version");

    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.equal(manifest.version, "9.8.7");
    assert.deepEqual(manifest.releaseNotes, ["A concise release summary"]);
    // The student channel's minimumInstallerVersion must default to the stable
    // floor, NOT the release version — otherwise every older install
    // self-blocks (see the updater's enforceMinimumInstallerVersion gate).
    assert.equal(manifest.minimumInstallerVersion, "0.1.0");

    const release = readZipReleaseJson(versionedZip);
    assert.equal(release.version, "9.8.7");
    assert.equal(release.commit, ref);
    assert.deepEqual(release.releaseNotes, manifest.releaseNotes);
    assert.equal(
      release.minimumInstallerVersion,
      "0.1.0",
      "the ZIP-carried release.json must bake the effective floor for --manifest-only"
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("build-student-release: --min-installer overrides the default floor", () => {
  const work = mkdtempSync(join(tmpdir(), "rios-build-release-mininstaller-"));
  const out = join(work, "release-dist");
  try {
    const ref = commitPackageVersion("9.8.7", work);
    execFileSync(process.execPath, [BUILD, "--ref", ref, "--out", out, "--min-installer", "9.5.0"], {
      cwd: ROOT,
      stdio: "ignore",
      env: RELEASE_ENV
    });

    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.equal(manifest.version, "9.8.7");
    assert.equal(
      manifest.minimumInstallerVersion,
      "9.5.0",
      "an explicit --min-installer must win over the default floor"
    );

    const release = readZipReleaseJson(join(out, "relationship-inbox-os-student-9.8.7.zip"));
    assert.equal(
      release.minimumInstallerVersion,
      "9.5.0",
      "raised --min-installer must travel with the ZIP so manifest-only can recover it"
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("build-student-release: raised --min-installer survives --manifest-only regen", () => {
  const work = mkdtempSync(join(tmpdir(), "rios-build-release-mininstaller-manifest-only-"));
  const out = join(work, "release-dist");
  try {
    const ref = commitPackageVersion("9.8.7", work);
    execFileSync(process.execPath, [
      BUILD, "--ref", ref, "--out", out, "--min-installer", "9.5.0", "--notes", "protocol break"
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: RELEASE_ENV
    });

    // Documented two-step flow: re-stamp the Dropbox URL without re-passing
    // --min-installer. The raised floor must come back from the ZIP.
    execFileSync(process.execPath, [
      BUILD,
      "--manifest-only",
      "--out", out,
      "--zip-url", "https://www.dropbox.com/s/example/relationship-inbox-os-student-latest.zip?dl=1"
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: RELEASE_ENV
    });

    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.equal(manifest.version, "9.8.7");
    assert.equal(
      manifest.minimumInstallerVersion,
      "9.5.0",
      "manifest-only must preserve a raised floor baked into the ZIP (#888)"
    );
    assert.deepEqual(manifest.releaseNotes, ["protocol break"]);
    assert.equal(
      manifest.zipUrl,
      "https://www.dropbox.com/s/example/relationship-inbox-os-student-latest.zip?dl=1"
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("build-student-release: --manifest-only fails loud when min-installer cannot be recovered", () => {
  const work = mkdtempSync(join(tmpdir(), "rios-build-release-mininstaller-missing-"));
  const out = join(work, "release-dist");
  const staging = join(work, "staging");
  const appDir = join(staging, "relationship-inbox-os");
  try {
    mkdirSync(appDir, { recursive: true });
    // Pre-fix ZIP shape: release.json has identity fields but no floor.
    writeFileSync(join(appDir, "release.json"), JSON.stringify({
      version: "9.8.7",
      build: "2026-01-01T00:00:00.000Z",
      commit: "deadbee",
      channel: "student",
      releaseNotes: ["legacy zip"]
    }, null, 2) + "\n");
    mkdirSync(out, { recursive: true });
    const zipPath = join(out, "relationship-inbox-os-student-latest.zip");
    execFileSync("zip", ["-r", "-X", "-q", zipPath, "relationship-inbox-os"], { cwd: staging });

    let threw = false;
    let stderr = "";
    try {
      execFileSync(process.execPath, [
        BUILD,
        "--manifest-only",
        "--out", out,
        "--zip-url", "https://www.dropbox.com/s/example/latest.zip?dl=1"
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: RELEASE_ENV
      });
    } catch (err) {
      threw = true;
      stderr = String(err.stderr || err.message || "");
    }
    assert.equal(threw, true, "manifest-only must not silently fall back to the default floor");
    assert.match(
      stderr,
      /minimumInstallerVersion/,
      "error must name the missing floor so the operator can pass --min-installer"
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("build-student-release: --manifest-only --min-installer overrides a baked floor", () => {
  const work = mkdtempSync(join(tmpdir(), "rios-build-release-mininstaller-override-"));
  const out = join(work, "release-dist");
  try {
    const ref = commitPackageVersion("9.8.7", work);
    execFileSync(process.execPath, [
      BUILD, "--ref", ref, "--out", out, "--min-installer", "9.5.0"
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: RELEASE_ENV
    });

    execFileSync(process.execPath, [
      BUILD,
      "--manifest-only",
      "--out", out,
      "--min-installer", "9.9.0",
      "--zip-url", "https://www.dropbox.com/s/example/latest.zip?dl=1"
    ], {
      cwd: ROOT,
      stdio: "ignore",
      env: RELEASE_ENV
    });

    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.equal(
      manifest.minimumInstallerVersion,
      "9.9.0",
      "an explicit --min-installer on manifest-only must win over the ZIP-baked floor"
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
