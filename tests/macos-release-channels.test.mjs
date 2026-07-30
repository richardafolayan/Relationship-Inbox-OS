import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isNewer } from "../scripts/lib/release-manifest.mjs";
import {
  githubEnvEntries,
  resolveMacosReleaseChannel
} from "../scripts/resolve-macos-release-channel.mjs";
import { finalizeMacosReleaseFeed } from "../scripts/finalize-macos-release-feed.mjs";
import { resolveUpdateFeedUrl } from "../apps/runner/dist/services/system-update.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "publish-free-macos-release.yml"),
  "utf8"
);

test("develop publishes to the existing dev feed without breaking installed dev apps", () => {
  const config = resolveMacosReleaseChannel({
    branch: "develop",
    coreVersion: "0.1.20",
    commitCount: 912
  });

  assert.deepEqual(config, {
    releaseTrack: "dev",
    buildChannel: "dev",
    releaseTag: "macos-free-dev",
    zipName: "Tovi-macos-arm64-latest.zip",
    dmgName: "Tovi-macos-arm64-latest.dmg",
    feedName: "latest-macos.json",
    releaseTitle: "Free signed macOS dev channel",
    releaseVersionOverride: "",
    prerelease: true
  });

  const env = githubEnvEntries(config);
  assert.equal(env.RELEASE_TAG, "macos-free-dev");
  assert.equal(env.FEED_NAME, "latest-macos.json");
  assert.equal(env.RELEASE_IS_PRERELEASE, "true");
});

test("main publishes an isolated rolling pilot release", () => {
  const config = resolveMacosReleaseChannel({
    branch: "main",
    coreVersion: "0.1.20",
    commitCount: 920
  });

  assert.equal(config.releaseTrack, "pilot");
  assert.equal(config.buildChannel, "student");
  assert.equal(config.releaseTag, "macos-free-pilot");
  assert.equal(config.feedName, "latest-macos-pilot.json");
  assert.equal(config.zipName, "Tovi-macos-arm64-pilot-latest.zip");
  assert.equal(config.dmgName, "Tovi-macos-arm64-pilot-latest.dmg");
  assert.equal(config.releaseVersionOverride, "0.1.20-pilot.920");
  assert.equal(config.prerelease, false);

  assert.ok(isNewer("0.1.20-pilot.920", "0.1.20-pilot.919"));
  assert.ok(
    isNewer("0.1.20-pilot.920", "0.1.20-dev.919"),
    "the first pilot build must outrank the existing signed dev build"
  );
});

test("only develop and main may publish signed rolling releases", () => {
  assert.throws(
    () => resolveMacosReleaseChannel({ branch: "feature/test", coreVersion: "0.1.20", commitCount: 1 }),
    /Unsupported release branch/
  );
});

test("rolling feeds keep a migration-safe installer floor and expose their public track", () => {
  const pilot = finalizeMacosReleaseFeed({
    version: "0.1.20-pilot.920",
    channel: "student",
    minimumInstallerVersion: "0.1.20-pilot.920"
  }, "pilot");

  assert.equal(pilot.channel, "student", "the existing updater channel guard remains compatible");
  assert.equal(pilot.releaseTrack, "pilot");
  assert.equal(pilot.minimumInstallerVersion, "0.0.1");

  assert.throws(() => finalizeMacosReleaseFeed({}, "nightly"), /dev or pilot/);
});

test("signed dev and pilot apps stay pinned to their own baked feeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "tovi-release-track-"));
  const configuredPilotSourceFeed = "https://dropbox.example/source-pilot.json";
  try {
    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "0.1.20-dev.920",
      channel: "dev",
      updateFeedUrl: "https://github.com/o/r/releases/download/macos-free-dev/latest-macos.json",
      updateMode: "squirrel-mac"
    }));
    assert.equal(
      resolveUpdateFeedUrl(dir, configuredPilotSourceFeed),
      "https://github.com/o/r/releases/download/macos-free-dev/latest-macos.json"
    );

    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "0.1.20-pilot.920",
      channel: "student",
      updateFeedUrl: "https://github.com/o/r/releases/download/macos-free-pilot/latest-macos-pilot.json",
      updateMode: "squirrel-mac"
    }));
    assert.equal(
      resolveUpdateFeedUrl(dir, configuredPilotSourceFeed),
      "https://github.com/o/r/releases/download/macos-free-pilot/latest-macos-pilot.json"
    );

    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "0.1.20-pilot.921",
      channel: "student",
      updateMode: "squirrel-mac"
    }));
    assert.equal(
      resolveUpdateFeedUrl(dir, configuredPilotSourceFeed),
      undefined,
      "a signed app with a missing baked feed must fail closed instead of crossing channels"
    );

    writeFileSync(join(dir, "release.json"), JSON.stringify({
      version: "0.1.20",
      channel: "student"
    }));
    assert.equal(
      resolveUpdateFeedUrl(dir, configuredPilotSourceFeed),
      configuredPilotSourceFeed,
      "legacy source/student installs continue using their configured Dropbox feed"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow publishes both branches with one app identity and separate assets", () => {
  assert.match(WORKFLOW, /branches:\s*\n\s*- develop\s*\n\s*- main/);
  assert.match(WORKFLOW, /resolve-macos-release-channel\.mjs/);
  assert.match(WORKFLOW, /RIOS_FREE_MACOS_IDENTITY/);
  assert.match(WORKFLOW, /identifier \"com\.relationshipinboxos\.desktop\"/);
  assert.match(WORKFLOW, /release-dist\/macos\/Tovi\.app/);
  assert.doesNotMatch(WORKFLOW, /Tovi Dev\.app|Tovi Pilot\.app/);
  assert.match(WORKFLOW, /publish-free-macos-release-\$\{\{ github\.ref_name \}\}/);
  assert.match(WORKFLOW, /gh release upload \"\$RELEASE_TAG\" --clobber/);
});
