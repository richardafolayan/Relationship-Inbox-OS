import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWindowsRuntime } from "./prepare-windows-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
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

requireWindowsNode22();
run("npm.cmd", ["run", "db:generate"]);
run("npm.cmd", ["run", "build", "--workspace", "@inbox-os/core"]);
run("npm.cmd", ["run", "build", "--workspace", "@inbox-os/runner"]);
run("npm.cmd", ["run", "build", "--workspace", "@inbox-os/dashboard"]);
run("node.exe", ["-e", "require('better-sqlite3')"]);
await prepareWindowsRuntime({ arch: "x64", root: ROOT });
run("npx.cmd", ["electron-builder", "--win", "nsis", "--x64"]);
