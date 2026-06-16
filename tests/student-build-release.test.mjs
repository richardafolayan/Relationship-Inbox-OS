import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "scripts", "build-student-release.mjs");

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

test("build-student-release reads the release version from the archived ref", () => {
  const work = mkdtempSync(join(tmpdir(), "rios-build-release-test-"));
  const out = join(work, "release-dist");
  try {
    const ref = commitPackageVersion("9.8.7", work);
    execFileSync(process.execPath, [BUILD, "--ref", ref, "--out", out], {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...process.env,
        RIOS_RELEASE_ENV_FILE: "/nonexistent/.env.release.local"
      }
    });

    const versionedZip = join(out, "relationship-inbox-os-student-9.8.7.zip");
    assert.ok(existsSync(versionedZip), "zip filename should use the ref package version");

    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.equal(manifest.version, "9.8.7");
    assert.equal(manifest.minimumInstallerVersion, "9.8.7");

    const release = JSON.parse(execFileSync(
      "unzip", ["-p", versionedZip, "relationship-inbox-os/release.json"],
      { encoding: "utf8" }
    ));
    assert.equal(release.version, "9.8.7");
    assert.equal(release.commit, ref);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
