import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWindowsRuntime } from "./prepare-windows-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

export function npmInvocation(args, env = process.env) {
  if (!env.npm_execpath) {
    throw new Error("npm_execpath is missing. Run this builder through npm run build:windows.");
  }
  return {
    command: process.execPath,
    args: [env.npm_execpath, ...args]
  };
}

function runNpm(args) {
  const invocation = npmInvocation(args);
  run(invocation.command, invocation.args);
}

function requireWindowsNode22() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (process.platform !== "win32") {
    throw new Error("Windows installers must be built on Windows so native modules match the target OS.");
  }
  if (major !== 22) {
    throw new Error(`Windows installers require Node 22. Current runtime: ${process.version}`);
  }
}

export async function buildWindowsInstaller() {
  requireWindowsNode22();
  runNpm(["run", "db:generate"]);
  runNpm(["run", "build", "--workspace", "@inbox-os/core"]);
  runNpm(["run", "build", "--workspace", "@inbox-os/runner"]);
  runNpm(["run", "build", "--workspace", "@inbox-os/dashboard"]);
  run("node.exe", ["-e", "require('better-sqlite3')"]);
  await prepareWindowsRuntime({ arch: "x64", root: ROOT });
  runNpm(["exec", "--", "electron-builder", "--win", "nsis", "--x64"]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWindowsInstaller();
}
