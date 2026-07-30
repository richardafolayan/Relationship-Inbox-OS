#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRACKS = new Set(["dev", "pilot"]);

export function finalizeMacosReleaseFeed(manifest, track) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be a JSON object");
  }
  if (!TRACKS.has(track)) {
    throw new Error(`track must be dev or pilot, received ${JSON.stringify(track)}`);
  }

  return {
    ...manifest,
    releaseTrack: track,
    // Both signed rolling channels must be able to migrate from the existing
    // 0.1.x signed builds. A floor equal to the new prerelease version would
    // block that first update under semver ordering.
    minimumInstallerVersion: "0.0.1"
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--path") out.path = next();
    else if (arg === "--track") out.track = next();
    else if (arg === "-h" || arg === "--help") out.help = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    "Finalize a signed macOS rolling-channel feed.\n\n" +
    "Usage:\n" +
    "  node scripts/finalize-macos-release-feed.mjs --path latest-macos.json --track dev\n" +
    "  node scripts/finalize-macos-release-feed.mjs --path latest-macos.json --track pilot\n"
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    if (!args.path) throw new Error("--path is required");
    if (!args.track) throw new Error("--track is required");
    const path = resolve(args.path);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const finalized = finalizeMacosReleaseFeed(manifest, args.track);
    writeFileSync(path, JSON.stringify(finalized, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
