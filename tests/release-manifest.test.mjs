import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions, findForbiddenEntries, isNewer, parseVersion,
  sha256Buffer, validateLatestJson
} from "../scripts/lib/release-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function goodManifest(overrides = {}) {
  return {
    version: "0.1.0",
    build: "2026-06-06T00:00:00Z",
    commit: "abc1234",
    zipUrl: "https://www.dropbox.com/scl/fi/x/app.zip?rlkey=y&dl=1",
    sha256: "a".repeat(64),
    releaseNotes: ["Improved installer"],
    minimumInstallerVersion: "0.1.0",
    ...overrides
  };
}

// ---- version comparison --------------------------------------------------

test("compareVersions orders numeric segments, not lexically", () => {
  assert.equal(compareVersions("0.1.0", "0.1.10"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
});

test("a release ranks above the same core with a prerelease", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
});

test("unparseable versions sort below parseable ones", () => {
  assert.equal(compareVersions("not-a-version", "0.0.1"), -1);
  assert.equal(parseVersion("nope"), null);
  assert.deepEqual(
    { ...parseVersion("1.2.3") },
    { major: 1, minor: 2, patch: 3, prerelease: "", raw: "1.2.3" }
  );
});

test("isNewer is strict", () => {
  assert.equal(isNewer("0.1.1", "0.1.0"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.0.9", "0.1.0"), false);
});

// ---- manifest validation -------------------------------------------------

test("a well-formed manifest validates", () => {
  const { ok, errors } = validateLatestJson(goodManifest());
  assert.equal(ok, true, errors.join("; "));
});

test("missing required fields are reported", () => {
  const { ok, errors } = validateLatestJson({ version: "0.1.0" });
  assert.equal(ok, false);
  for (const field of ["build", "commit", "zipUrl", "sha256", "releaseNotes", "minimumInstallerVersion"]) {
    assert.ok(errors.some((e) => e.includes(field)), `expected an error mentioning ${field}`);
  }
});

test("malformed field values are rejected", () => {
  assert.equal(validateLatestJson(goodManifest({ version: "x.y" })).ok, false);
  assert.equal(validateLatestJson(goodManifest({ sha256: "tooshort" })).ok, false);
  assert.equal(validateLatestJson(goodManifest({ zipUrl: "ftp://nope" })).ok, false);
  assert.equal(validateLatestJson(goodManifest({ build: "not-a-date" })).ok, false);
  assert.equal(validateLatestJson(goodManifest({ releaseNotes: "a string" })).ok, false);
  assert.equal(validateLatestJson(goodManifest({ releaseNotes: [1, 2] })).ok, false);
});

test("a non-object manifest fails safely", () => {
  assert.equal(validateLatestJson(null).ok, false);
  assert.equal(validateLatestJson("a string").ok, false);
  assert.equal(validateLatestJson([1, 2, 3]).ok, false);
});

// ---- checksum ------------------------------------------------------------

test("sha256Buffer matches the known empty-string digest", () => {
  assert.equal(
    sha256Buffer(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

// ---- forbidden-file scan -------------------------------------------------

test("the forbidden scan flags secrets and runtime dirs", () => {
  const flagged = findForbiddenEntries([
    "relationship-inbox-os/.env",
    "relationship-inbox-os/data/inbox-os.sqlite",
    "relationship-inbox-os/node_modules/x/index.js",
    "relationship-inbox-os/logs/run.log",
    "relationship-inbox-os/private.pem",
    "relationship-inbox-os/.git/config"
  ]);
  assert.equal(flagged.length, 6);
});

test("the forbidden scan does NOT flag legitimate source paths", () => {
  const flagged = findForbiddenEntries([
    "relationship-inbox-os/apps/dashboard/app/logs/page.tsx", // a UI route named 'logs'
    "relationship-inbox-os/apps/runner/src/db.ts",
    "relationship-inbox-os/.env.example", // template, no secrets
    "relationship-inbox-os/scripts/build-student-release.mjs",
    "relationship-inbox-os/package.json"
  ]);
  assert.deepEqual(flagged, []);
});

test("no tracked file in the repo would leak into a release", () => {
  // git archive only ships tracked files; prove none of them are forbidden.
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const leaked = findForbiddenEntries(tracked);
  assert.deepEqual(leaked, [], `tracked secrets would leak: ${leaked.join(", ")}`);
});
