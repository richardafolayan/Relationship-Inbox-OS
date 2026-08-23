#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  acquireInstallOperation,
  acquireInstallMaintenance,
  releaseInstallOperation,
  releaseInstallMaintenance
} from "./lib/install-maintenance.mjs";

function parseArgs(argv) {
  const options = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--app-dir") options.appDir = argv[++index];
    else if (argv[index] === "--owner-pid") options.ownerPid = Number(argv[++index]);
    else if (argv[index] === "--token") options.token = argv[++index];
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.appDir || !isAbsolute(options.appDir)) {
    throw new Error("An absolute --app-dir is required");
  }
  const appDir = resolve(options.appDir);
  if (options.command === "acquire") {
    process.stdout.write(`${acquireInstallMaintenance(appDir, options)}\n`);
    return;
  }
  if (options.command === "acquire-operation") {
    process.stdout.write(`${acquireInstallOperation(appDir, options)}\n`);
    return;
  }
  if (options.command === "release") {
    if (!options.token || !releaseInstallMaintenance(appDir, options.token)) {
      throw new Error("The installation lock belongs to another process");
    }
    return;
  }
  if (options.command === "release-operation") {
    if (!options.token || !releaseInstallOperation(appDir, options.token)) {
      throw new Error("The installation operation lock belongs to another process");
    }
    return;
  }
  throw new Error(
    "Usage: install-maintenance.mjs <acquire|release|acquire-operation|release-operation> --app-dir <absolute path>"
  );
}

function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
