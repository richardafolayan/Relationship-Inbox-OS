import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWindowsRuntime } from "./prepare-windows-runtime.mjs";
import { resolveAppName } from "./lib/branding.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WINDOWS_BRANDING_DIR = "build/windows-branding";

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
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

export function electronBuilderArgs(appName = resolveAppName()) {
  return [
    "exec", "--", "electron-builder", "--win", "nsis", "--x64",
    `--config.productName=${appName}`,
    `--config.win.artifactName=${appName}-Setup-\${version}-\${arch}.\${ext}`,
    `--config.nsis.shortcutName=${appName}`
  ];
}

// Child npm/electron-builder processes do not load the repo .env. Always pass
// the resolved display name so dashboard copy and the NSIS product name match.
export function packagingEnv(appName = resolveAppName(), env = process.env) {
  return {
    ...env,
    RIOS_APP_NAME: appName
  };
}

// Write package-only branding files under build/ (never the developer's root
// .env) so electron-builder can ship a minimal .env + release.json that the
// launcher and runner read at runtime without embedding local secrets.
export function writeWindowsBrandingArtifacts(root = ROOT, appName = resolveAppName()) {
  const brandingDir = join(root, WINDOWS_BRANDING_DIR);
  mkdirSync(brandingDir, { recursive: true });
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || "0.0.0";
  const release = {
    version,
    appName,
    build: new Date().toISOString(),
    channel: "windows"
  };
  writeFileSync(join(brandingDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  // Named without a leading dot so default ignore rules do not drop it; the
  // electron-builder FileSet maps it to `.env` inside the package.
  writeFileSync(join(brandingDir, "branding.env"), `RIOS_APP_NAME=${appName}\n`);
  return { brandingDir, release, envBody: `RIOS_APP_NAME=${appName}\n` };
}

function runNpm(args, env = process.env) {
  const invocation = npmInvocation(args, env);
  run(invocation.command, invocation.args, { env });
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
  const appName = resolveAppName();
  const env = packagingEnv(appName);
  writeWindowsBrandingArtifacts(ROOT, appName);
  runNpm(["run", "db:generate"], env);
  runNpm(["run", "build", "--workspace", "@inbox-os/core"], env);
  runNpm(["run", "build", "--workspace", "@inbox-os/runner"], env);
  runNpm(["run", "build", "--workspace", "@inbox-os/dashboard"], env);
  run("node.exe", ["-e", "require('better-sqlite3')"], { env });
  await prepareWindowsRuntime({ arch: "x64", root: ROOT });
  runNpm(electronBuilderArgs(appName), env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWindowsInstaller();
}
