import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bakePilotEnv, compareVersions, findEnvExampleSecretLeaks, findForbiddenEntries,
  isNewer, parseVersion, reconcileEnvWithExample, sha256Buffer, validateLatestJson
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

test("build metadata is ignored when parsing and comparing versions", () => {
  assert.deepEqual(
    { ...parseVersion("1.0.0+build-123") },
    { major: 1, minor: 0, patch: 0, prerelease: "", raw: "1.0.0+build-123" }
  );
  assert.equal(compareVersions("1.0.0+build-123", "1.0.0"), 0);
  assert.equal(isNewer("1.3.0", "1.3.0+build-42"), false);
  assert.equal(isNewer("1.3.0+build-42", "1.3.0"), false);
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

test("the forbidden scan flags key / credential file types", () => {
  const flagged = findForbiddenEntries([
    "r/cert.p12", "r/cert.pfx", "r/release.jks", "r/my.keystore",
    "r/.ssh/id_ed25519", "r/id_ecdsa", "r/id_dsa",
    "r/firebase-adminsdk-abc.json", "r/my-service-account.json", "r/client_secret_123.json",
    "r/.npmrc", "r/key.ppk", "r/secret.asc"
  ]);
  assert.equal(flagged.length, 13);
});

test("node_modules is flagged at any depth", () => {
  assert.deepEqual(
    findForbiddenEntries(["r/apps/dashboard/node_modules/leftpad/index.js"]),
    ["r/apps/dashboard/node_modules/leftpad/index.js"]
  );
});

test("the forbidden scan does NOT flag legitimate source paths", () => {
  const flagged = findForbiddenEntries([
    "relationship-inbox-os/apps/dashboard/app/logs/page.tsx", // a UI route named 'logs'
    "relationship-inbox-os/apps/runner/src/db.ts",
    "relationship-inbox-os/.env.example", // template, no secrets
    "relationship-inbox-os/scripts/build-student-release.mjs",
    "relationship-inbox-os/package.json",
    "relationship-inbox-os/apps/dashboard/lib/data-table.tsx", // 'data-table' != 'data'
    "relationship-inbox-os/tsconfig.json"
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

// ---- pilot distribution config baking + leak guard ------------------------

const SAMPLE_ENV = [
  "OPENAI_API_KEY=",
  "AI_PROVIDER=openai",
  "GEMINI_MODEL=gemma-4-31b-it",
  "RIOS_UPDATE_FEED_URL=",
  "PILOT_FEEDBACK_WEBHOOK_URL=",
  "PILOT_FEEDBACK_SECRET=",
  "PILOT_FEEDBACK_STATUS_URL="
].join("\n");

test("bakePilotEnv fills the distribution lines from the source env", () => {
  const { text, injected } = bakePilotEnv(SAMPLE_ENV, {
    RIOS_UPDATE_FEED_URL: "https://www.dropbox.com/scl/fi/f/latest.json?rlkey=k&raw=1",
    PILOT_FEEDBACK_WEBHOOK_URL: "https://example.test/exec",
    PILOT_FEEDBACK_SECRET: "shh-123",
    OPENAI_API_KEY: "sk-should-not-be-baked"
  });
  assert.match(text, /^RIOS_UPDATE_FEED_URL=https:\/\/www\.dropbox\.com\/scl\/fi\/f\/latest\.json\?rlkey=k&raw=1$/m);
  assert.match(text, /^PILOT_FEEDBACK_WEBHOOK_URL=https:\/\/example\.test\/exec$/m);
  assert.match(text, /^PILOT_FEEDBACK_SECRET=shh-123$/m);
  assert.match(text, /^PILOT_FEEDBACK_STATUS_URL=$/m, "unset key stays blank");
  assert.match(text, /^OPENAI_API_KEY=$/m, "only distribution keys are ever baked");
  assert.deepEqual(injected, [
    "RIOS_UPDATE_FEED_URL", "PILOT_FEEDBACK_WEBHOOK_URL", "PILOT_FEEDBACK_SECRET"
  ]);
});

test("bakePilotEnv with no distribution config injects nothing", () => {
  const { text, injected } = bakePilotEnv(SAMPLE_ENV, { OPENAI_API_KEY: "sk-x" });
  assert.equal(injected.length, 0);
  assert.equal(text, SAMPLE_ENV);
});

test("bakePilotEnv appends a missing feed-url line", () => {
  const noFeedLine = "AI_PROVIDER=openai";
  const { text, injected } = bakePilotEnv(noFeedLine, {
    RIOS_UPDATE_FEED_URL: "https://example.test/latest.json"
  });
  assert.match(text, /^RIOS_UPDATE_FEED_URL=https:\/\/example\.test\/latest\.json$/m);
  assert.deepEqual(injected, ["RIOS_UPDATE_FEED_URL"]);
});

test("findEnvExampleSecretLeaks passes baked distribution config but catches real secrets", () => {
  const baked = bakePilotEnv(SAMPLE_ENV, {
    RIOS_UPDATE_FEED_URL: "https://www.dropbox.com/scl/fi/f/latest.json?rlkey=k&raw=1",
    PILOT_FEEDBACK_WEBHOOK_URL: "https://example.test/exec",
    PILOT_FEEDBACK_SECRET: "shh-123"
  }).text;
  assert.deepEqual(findEnvExampleSecretLeaks(baked), [], "distribution config alone is allowed");

  const leaked = baked + "\nOPENAI_API_KEY=sk-real\nGITHUB_TOKEN=ghp_real\nDROPBOX_REFRESH_TOKEN=abc";
  assert.deepEqual(
    findEnvExampleSecretLeaks(leaked).sort(),
    ["DROPBOX_REFRESH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]
  );
});

test("findEnvExampleSecretLeaks ignores non-secret config keys", () => {
  const cfg = "AI_PROVIDER=openai\nGEMINI_BASE_URL=https://x\nGEMINI_MODEL=gemma\nOPENAI_MODEL=gpt-5-nano\nZ_AI_BASE_URL=https://y";
  assert.deepEqual(findEnvExampleSecretLeaks(cfg), []);
});

// ---- launch-time .env reconcile -------------------------------------------

const EXAMPLE_WITH_CONFIG = [
  "# template",
  "AI_PROVIDER=openai",
  "RIOS_UPDATE_FEED_URL=https://example.test/latest.json?raw=1",
  "PILOT_FEEDBACK_WEBHOOK_URL=https://example.test/exec",
  "PILOT_FEEDBACK_SECRET=shh-123",
  "PILOT_FEEDBACK_STATUS_URL=https://example.test/status",
  "NEXT_PUBLIC_APP_VERSION=0.1.9"
].join("\n");

test("reconcile fills blank and missing distribution keys from the example", () => {
  const env = [
    "OPENAI_API_KEY=sk-mine",
    "RIOS_UPDATE_FEED_URL=",
    "PILOT_FEEDBACK_WEBHOOK_URL="
    // SECRET + STATUS_URL lines missing entirely
  ].join("\n");
  const { text, filled, synced } = reconcileEnvWithExample(env, EXAMPLE_WITH_CONFIG);
  assert.match(text, /^RIOS_UPDATE_FEED_URL=https:\/\/example\.test\/latest\.json\?raw=1$/m);
  assert.match(text, /^PILOT_FEEDBACK_WEBHOOK_URL=https:\/\/example\.test\/exec$/m);
  assert.match(text, /^PILOT_FEEDBACK_SECRET=shh-123$/m);
  assert.match(text, /^PILOT_FEEDBACK_STATUS_URL=https:\/\/example\.test\/status$/m);
  assert.match(text, /^OPENAI_API_KEY=sk-mine$/m, "unrelated keys untouched");
  assert.deepEqual(filled, [
    "RIOS_UPDATE_FEED_URL", "PILOT_FEEDBACK_WEBHOOK_URL",
    "PILOT_FEEDBACK_SECRET", "PILOT_FEEDBACK_STATUS_URL"
  ]);
  assert.deepEqual(synced, ["NEXT_PUBLIC_APP_VERSION"], "missing version stamp is added too");
});

test("reconcile never overwrites a non-blank distribution value", () => {
  const env = "RIOS_UPDATE_FEED_URL=https://my-own-mirror.test/latest.json\nNEXT_PUBLIC_APP_VERSION=0.1.9";
  const { text, filled, synced } = reconcileEnvWithExample(env, EXAMPLE_WITH_CONFIG);
  assert.match(text, /^RIOS_UPDATE_FEED_URL=https:\/\/my-own-mirror\.test\/latest\.json$/m);
  assert.deepEqual(filled, ["PILOT_FEEDBACK_WEBHOOK_URL", "PILOT_FEEDBACK_SECRET", "PILOT_FEEDBACK_STATUS_URL"]);
  assert.deepEqual(synced, []);
});

test("reconcile keeps the version stamp equal to the example", () => {
  const env = "NEXT_PUBLIC_APP_VERSION=0.1.7\nRIOS_UPDATE_FEED_URL=https://x.test/l.json";
  const { text, synced } = reconcileEnvWithExample(env, EXAMPLE_WITH_CONFIG);
  assert.match(text, /^NEXT_PUBLIC_APP_VERSION=0\.1\.9$/m);
  assert.deepEqual(synced, ["NEXT_PUBLIC_APP_VERSION"]);
});

test("reconcile is a no-op when everything already matches", () => {
  const env = [
    "RIOS_UPDATE_FEED_URL=https://example.test/latest.json?raw=1",
    "PILOT_FEEDBACK_WEBHOOK_URL=https://example.test/exec",
    "PILOT_FEEDBACK_SECRET=shh-123",
    "PILOT_FEEDBACK_STATUS_URL=https://example.test/status",
    "NEXT_PUBLIC_APP_VERSION=0.1.9",
    "# a comment",
    "OPENAI_API_KEY=sk-mine"
  ].join("\n");
  const { text, filled, synced } = reconcileEnvWithExample(env, EXAMPLE_WITH_CONFIG);
  assert.equal(text, env, "byte-identical when nothing to do");
  assert.deepEqual(filled, []);
  assert.deepEqual(synced, []);
});

test("reconcile ignores keys the example leaves blank and never copies other keys", () => {
  const example = "RIOS_UPDATE_FEED_URL=\nOPENAI_API_KEY=sk-template\nAI_PROVIDER=glm";
  const env = "RIOS_UPDATE_FEED_URL=\nOPENAI_API_KEY=\nAI_PROVIDER=openai";
  const { text, filled, synced } = reconcileEnvWithExample(env, example);
  assert.equal(text, env, "blank example value fills nothing; non-allowlisted keys never copied");
  assert.deepEqual(filled, []);
  assert.deepEqual(synced, []);
});

test("reconcile preserves comments, ordering, and unrelated lines", () => {
  const env = [
    "# my notes",
    "OPENAI_API_KEY=sk-mine",
    "RIOS_UPDATE_FEED_URL=",
    "# more notes",
    "BROWSER_PROFILE_MODE=personal"
  ].join("\n");
  const { text } = reconcileEnvWithExample(env, EXAMPLE_WITH_CONFIG);
  const lines = text.split("\n");
  assert.equal(lines[0], "# my notes");
  assert.equal(lines[1], "OPENAI_API_KEY=sk-mine");
  assert.equal(lines[2], "RIOS_UPDATE_FEED_URL=https://example.test/latest.json?raw=1");
  assert.equal(lines[3], "# more notes");
  assert.equal(lines[4], "BROWSER_PROFILE_MODE=personal");
});
