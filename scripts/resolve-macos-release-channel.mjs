#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export function resolveMacosReleaseChannel({ branch, coreVersion, commitCount }) {
  const cleanBranch = String(branch || "").trim();
  const cleanVersion = String(coreVersion || "").trim();
  const count = Number(commitCount);

  if (!CORE_VERSION_RE.test(cleanVersion)) {
    throw new Error(`coreVersion must be MAJOR.MINOR.PATCH, received ${JSON.stringify(coreVersion)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`commitCount must be a positive integer, received ${JSON.stringify(commitCount)}`);
  }

  if (cleanBranch === "develop") {
    return {
      releaseTrack: "dev",
      buildChannel: "dev",
      releaseTag: "macos-free-dev",
      // Preserve the existing public asset names. Installed dev builds already
      // have this exact feed URL baked into release.json.
      zipName: "Tovi-macos-arm64-latest.zip",
      dmgName: "Tovi-macos-arm64-latest.dmg",
      feedName: "latest-macos.json",
      releaseTitle: "Free signed macOS dev channel",
      releaseVersionOverride: "",
      prerelease: true
    };
  }

  if (cleanBranch === "main") {
    return {
      releaseTrack: "pilot",
      // The macOS builder still calls the non-dev distribution channel
      // "student" internally. The public release track is pilot.
      buildChannel: "student",
      releaseTag: "macos-free-pilot",
      zipName: "Tovi-macos-arm64-pilot-latest.zip",
      dmgName: "Tovi-macos-arm64-pilot-latest.dmg",
      feedName: "latest-macos-pilot.json",
      releaseTitle: "Free signed macOS pilot channel",
      // A rolling prerelease suffix makes every promotion commit strictly newer
      // without requiring a manual package-version bump for each pilot publish.
      releaseVersionOverride: `${cleanVersion}-pilot.${count}`,
      prerelease: false
    };
  }

  throw new Error(`Unsupported release branch ${JSON.stringify(cleanBranch)}. Use develop or main.`);
}

export function githubEnvEntries(config) {
  return {
    RELEASE_TRACK: config.releaseTrack,
    BUILD_CHANNEL: config.buildChannel,
    RELEASE_TAG: config.releaseTag,
    ZIP_NAME: config.zipName,
    DMG_NAME: config.dmgName,
    FEED_NAME: config.feedName,
    RELEASE_TITLE: config.releaseTitle,
    RELEASE_VERSION_OVERRIDE: config.releaseVersionOverride,
    RELEASE_IS_PRERELEASE: config.prerelease ? "true" : "false"
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--branch") out.branch = next();
    else if (arg === "--core-version") out.coreVersion = next();
    else if (arg === "--commit-count") out.commitCount = next();
    else if (arg === "--github-env") out.githubEnv = next();
    else if (arg === "--json") out.json = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
  }
  return out;
}

function rootCoreVersion() {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
}

function headCommitCount() {
  return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8"
  }).trim());
}

function printHelp() {
  process.stdout.write(
    "Resolve a Git branch to Tovi's signed macOS release track.\n\n" +
    "Usage:\n" +
    "  node scripts/resolve-macos-release-channel.mjs --branch develop --json\n" +
    "  node scripts/resolve-macos-release-channel.mjs --branch main --github-env \"$GITHUB_ENV\"\n"
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const config = resolveMacosReleaseChannel({
      branch: args.branch || process.env.GITHUB_REF_NAME,
      coreVersion: args.coreVersion || rootCoreVersion(),
      commitCount: args.commitCount || headCommitCount()
    });
    const entries = githubEnvEntries(config);

    if (args.githubEnv) {
      const text = Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
      appendFileSync(resolve(args.githubEnv), text);
    }

    if (args.json || !args.githubEnv) {
      process.stdout.write(JSON.stringify({ ...config, env: entries }, null, 2) + "\n");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
