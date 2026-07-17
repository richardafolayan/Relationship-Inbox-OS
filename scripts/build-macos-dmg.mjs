#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveAppName } from "./lib/branding.mjs";

// Display name only — driven by RIOS_APP_NAME (default "Tovi"). The DMG volume,
// the .app folder and CFBundleName/DisplayName all follow this.
export const APP_NAME = resolveAppName();
// BUNDLE_ID intentionally keeps the original identifier: macOS TCC permission
// grants (Full Disk Access, Automation, Accessibility) are keyed to it.
export const BUNDLE_ID = "com.relationshipinboxos.desktop";
export const REQUIRED_NODE_MAJOR = 22;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const ICON_SIZES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];

export function parseArgs(argv) {
  const out = { notes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--out") out.out = next();
    else if (arg === "--ref") out.ref = next();
    else if (arg === "--channel") out.channel = next();
    else if (arg === "--node-dir") out.nodeDir = next();
    else if (arg === "--skip-install") out.skipInstall = true;
    else if (arg === "--skip-build") out.skipBuild = true;
    else if (arg === "--skip-dmg") out.skipDmg = true;
    else if (arg === "--no-sign") out.noSign = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
  }
  return out;
}

export function macArchToNodeArch(arch = process.arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "x64";
}

export function macArchToOpenSslArch(arch = process.arch) {
  return arch === "arm64" ? "darwin64-arm64-cc" : "darwin64-x86_64-cc";
}

export function appVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || "0.0.0";
}

// The DMG is the local/dev artifact (pilots install via the zip installer), so
// it stamps channel "dev" by default: the installed app then checks the
// rolling GitHub `dev` prerelease feed and can self-update in place on every
// push to v1/strip-back-pr1 (issue #843). Pass --channel student to build a
// pilot-flavoured bundle with no baked feed.
export const DMG_CHANNELS = ["dev", "student"];
export const DEFAULT_DMG_CHANNEL = "dev";

export function devUpdateFeedUrl(root = ROOT, env = process.env) {
  if (env.RIOS_DEV_UPDATE_FEED_URL?.trim()) return env.RIOS_DEV_UPDATE_FEED_URL.trim();
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) {
    throw new Error(`could not derive the GitHub repo from origin (${remote}); set RIOS_DEV_UPDATE_FEED_URL`);
  }
  return `https://github.com/${match[1]}/${match[2]}/releases/download/dev/latest.json`;
}

// Mirror of the release builder's dev stamping: -dev.<commit count> makes each
// branch commit strictly newer within the dev channel.
export function channelReleaseVersion(channel, ref, root = ROOT) {
  const core = appVersion(root);
  if (channel !== "dev") return core;
  const count = execFileSync("git", ["rev-list", "--count", ref], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  return `${core}-dev.${count}`;
}

export function electronTemplateApp() {
  const electronExecutable = require("electron");
  return resolve(dirname(electronExecutable), "..", "..");
}

export function bundledNodeCandidate(appDir) {
  return join(appDir, "..", "runtime", "node", "bin", "node");
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...options
  });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options
  }).trim();
}

function ensureMac() {
  if (process.platform !== "darwin") {
    throw new Error("macOS DMG builds must run on macOS.");
  }
}

function ensureTool(name) {
  try {
    execFileSync("/usr/bin/which", [name], { stdio: "ignore" });
  } catch {
    throw new Error(`${name} is required to build the macOS app.`);
  }
}

function plistSet(plist, key, value) {
  const command = `Set :${key} ${value}`;
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist], { stdio: "ignore" });
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], { stdio: "ignore" });
  }
}

function plistSetBoolean(plist, key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
  } catch {
    // The key is absent on a fresh Electron template.
  }
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} bool ${value ? "true" : "false"}`, plist], {
    stdio: "ignore"
  });
}

function plistDelete(plist, key) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
  } catch {
    // Optional Electron template keys may not exist in every version.
  }
}

function nodeVersion(nodeBin) {
  if (!existsSync(nodeBin)) return "";
  try {
    return capture(nodeBin, ["-v"]);
  } catch {
    return "";
  }
}

function nodeMajor(versionText) {
  const match = String(versionText).trim().match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ensureNodeRuntime(targetDir) {
  const nodeBin = join(targetDir, "bin", "node");
  if (nodeMajor(nodeVersion(nodeBin)) === REQUIRED_NODE_MAJOR) return targetDir;

  ensureTool("tar");
  ensureTool("shasum");
  const nodeArch = macArchToNodeArch();
  const releaseBase = `https://nodejs.org/download/release/latest-v${REQUIRED_NODE_MAJOR}.x`;
  const sums = (await download(`${releaseBase}/SHASUMS256.txt`)).toString("utf8");
  const line = sums.split(/\r?\n/).find((entry) => entry.endsWith(`darwin-${nodeArch}.tar.gz`));
  if (!line) throw new Error(`could not find Node ${REQUIRED_NODE_MAJOR} for darwin-${nodeArch}`);
  const [expectedSha, fileName] = line.trim().split(/\s+/);
  const tarball = await download(`${releaseBase}/${fileName}`);
  const actualSha = createHash("sha256").update(tarball).digest("hex");
  if (actualSha !== expectedSha) throw new Error(`Node ${REQUIRED_NODE_MAJOR} checksum mismatch.`);

  const temp = mkdtempSync(join(tmpdir(), "rios-node-runtime-"));
  const tarPath = join(temp, fileName);
  try {
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(tarPath, tarball);
    run("tar", ["-xzf", tarPath, "-C", targetDir, "--strip-components=1"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (nodeMajor(nodeVersion(nodeBin)) !== REQUIRED_NODE_MAJOR) {
    throw new Error(`Node ${REQUIRED_NODE_MAJOR} did not install correctly at ${targetDir}.`);
  }
  return targetDir;
}

function stageSource(ref, appResourceDir) {
  mkdirSync(appResourceDir, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), "rios-source-"));
  const tarPath = join(temp, "source.tar");
  try {
    run("git", ["archive", "--format=tar", "--output", tarPath, ref]);
    run("tar", ["-xf", tarPath, "-C", appResourceDir]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Staged trees come from `git archive` and have no .env. Always pass the
// already-resolved display name so the dashboard build inlines the same brand
// as the DMG / Info.plist, even when RIOS_APP_NAME only lived in the host .env.
export function stagedChildEnv(nodeDir, appName = APP_NAME, env = process.env) {
  return {
    ...env,
    PATH: `${join(nodeDir, "bin")}:${env.PATH || ""}`,
    RIOS_APP_NAME: appName
  };
}

function installDependencies(appResourceDir, nodeDir) {
  const npm = join(nodeDir, "bin", "npm");
  run(npm, ["ci"], { cwd: appResourceDir, env: stagedChildEnv(nodeDir) });
}

function buildRuntimeArtifacts(appResourceDir, nodeDir) {
  const npm = join(nodeDir, "bin", "npm");
  const env = stagedChildEnv(nodeDir);
  run(npm, ["run", "db:generate"], { cwd: appResourceDir, env });
  run(npm, ["run", "build", "--workspace", "@inbox-os/core"], { cwd: appResourceDir, env });
  run(npm, ["run", "build", "--workspace", "@inbox-os/runner"], { cwd: appResourceDir, env });
  run(npm, ["run", "build", "--workspace", "@inbox-os/dashboard"], { cwd: appResourceDir, env });
}

function logicalBytes(path) {
  if (!existsSync(path)) return 0;
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce(
    (total, entry) => total + logicalBytes(join(path, entry)),
    0
  );
}

// lstat-based existence: existsSync FOLLOWS symlinks, so once the electron
// package dir is pruned, existsSync(".bin/electron") is false and the now
// dangling symlink survives into the bundle, where it fails
// `codesign --verify --deep --strict` with "No such file or directory".
function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function removeMeasured(path, removed) {
  if (!pathEntryExists(path)) return;
  const bytes = logicalBytes(path);
  rmSync(path, { recursive: true, force: true });
  removed.push({ path, bytes });
}

function removeDirectoryEntriesExcept(root, keep, removed) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (!keep.has(entry)) removeMeasured(join(root, entry), removed);
  }
}

export function prunePackagedFootprint({ appPath, appResourceDir, packagedNodeDir, arch = process.arch }) {
  const removed = [];
  const modulesDir = join(appResourceDir, "node_modules");

  for (const path of [
    join(appResourceDir, "apps", "dashboard", ".next", "cache"),
    join(modulesDir, "electron"),
    join(modulesDir, ".bin", "electron"),
    join(modulesDir, "@electron", "get"),
    join(modulesDir, "onnxruntime-web"),
    join(appResourceDir, "tests"),
    join(appResourceDir, "design-review-screenshots"),
    join(appPath, "Contents", "Resources", "default_app.asar"),
    join(appPath, "Contents", "Resources", "electron.icns")
  ]) {
    removeMeasured(path, removed);
  }

  const onnxRoot = join(modulesDir, "onnxruntime-node", "bin", "napi-v3");
  removeDirectoryEntriesExcept(onnxRoot, new Set(["darwin"]), removed);
  removeDirectoryEntriesExcept(
    join(onnxRoot, "darwin"),
    new Set([macArchToNodeArch(arch)]),
    removed
  );

  const opensslArchRoot = join(packagedNodeDir, "include", "node", "openssl", "archs");
  removeDirectoryEntriesExcept(
    opensslArchRoot,
    new Set([macArchToOpenSslArch(arch)]),
    removed
  );

  for (const path of [
    join(packagedNodeDir, "CHANGELOG.md"),
    join(packagedNodeDir, "README.md"),
    join(packagedNodeDir, "share"),
    join(packagedNodeDir, "bin", "corepack"),
    join(packagedNodeDir, "lib", "node_modules", "corepack")
  ]) {
    removeMeasured(path, removed);
  }

  return {
    removed,
    removedBytes: removed.reduce((total, entry) => total + entry.bytes, 0)
  };
}

function generateIcon(iconSvg, resourcesDir, tempDir) {
  ensureTool("sips");
  ensureTool("iconutil");
  const sourcePng = join(tempDir, "app-icon-1024.png");
  const iconsetDir = join(tempDir, "RelationshipInboxOS.iconset");
  const icnsPath = join(resourcesDir, "app.icns");
  mkdirSync(iconsetDir, { recursive: true });
  run("sips", ["-s", "format", "png", iconSvg, "--out", sourcePng]);
  for (const [name, size] of ICON_SIZES) {
    run("sips", ["-z", String(size), String(size), sourcePng, "--out", join(iconsetDir, name)]);
  }
  run("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath]);
  return icnsPath;
}

function rewriteInfoPlist(appPath, version) {
  const plist = join(appPath, "Contents", "Info.plist");
  plistSet(plist, "CFBundleDisplayName", APP_NAME);
  plistSet(plist, "CFBundleName", APP_NAME);
  plistSet(plist, "CFBundleIdentifier", BUNDLE_ID);
  plistSet(plist, "CFBundleShortVersionString", version);
  plistSet(plist, "CFBundleVersion", version);
  plistSet(plist, "CFBundleIconFile", "app");
  plistSet(plist, "LSApplicationCategoryType", "public.app-category.productivity");
  plistSet(plist, "LSMinimumSystemVersion", "13.0");
  plistSetBoolean(plist, "LSMultipleInstancesProhibited", true);
  plistSetBoolean(plist, "NSHighResolutionCapable", true);
  plistSet(plist, "NSAppleEventsUsageDescription", `${APP_NAME} asks before sending through Messages. Sending is always user-triggered.`);
  plistSet(plist, "NSContactsUsageDescription", `${APP_NAME} uses contacts stored on this Mac to show familiar names. Contact data stays on this Mac.`);
  plistSet(plist, "NSMicrophoneUsageDescription", `${APP_NAME} uses the microphone only when you choose dictation.`);
  plistSet(plist, "NSCameraUsageDescription", `${APP_NAME} uses the camera only if you choose a feature that asks for it.`);
  plistDelete(plist, "NSBluetoothAlwaysUsageDescription");
  plistDelete(plist, "NSBluetoothPeripheralUsageDescription");
}

function renameElectronExecutable(appPath) {
  const macosDir = join(appPath, "Contents", "MacOS");
  const oldPath = join(macosDir, "Electron");
  const newPath = join(macosDir, APP_NAME);
  if (existsSync(oldPath) && !existsSync(newPath)) renameSync(oldPath, newPath);
  plistSet(join(appPath, "Contents", "Info.plist"), "CFBundleExecutable", APP_NAME);
}

function signApp(appPath, identity) {
  const signIdentity = identity || "-";
  const entitlements = join(ROOT, "apps", "desktop", "entitlements.mac.plist");
  run("codesign", [
    "--force",
    "--deep",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    "--sign",
    signIdentity,
    appPath
  ]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function copyBundle(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  run("ditto", [source, destination]);
}

function createDmg(appPath, outDir, version) {
  ensureTool("hdiutil");
  const dmgRoot = join(outDir, "dmg-root");
  const dmgPath = join(outDir, `${APP_NAME}-${version}.dmg`);
  rmSync(dmgRoot, { recursive: true, force: true });
  mkdirSync(dmgRoot, { recursive: true });
  copyBundle(appPath, join(dmgRoot, basename(appPath)));
  run("ln", ["-s", "/Applications", join(dmgRoot, "Applications")]);
  rmSync(dmgPath, { force: true });
  run("hdiutil", ["create", "-volname", APP_NAME, "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgPath]);
  run("hdiutil", ["verify", dmgPath]);
  return dmgPath;
}

export function directorySizeBytes(path) {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += directorySizeBytes(join(path, entry));
  return total;
}

export function planPaths({ out, version = appVersion() } = {}) {
  const outDir = resolve(ROOT, out || "release-dist/macos");
  const appPath = join(outDir, `${APP_NAME}.app`);
  const dmgPath = join(outDir, `${APP_NAME}-${version}.dmg`);
  const runtimeDir = join(outDir, "runtime", `node-v${REQUIRED_NODE_MAJOR}-darwin-${macArchToNodeArch()}`);
  return { outDir, appPath, dmgPath, runtimeDir };
}

export async function buildMacosDmg(options = {}) {
  ensureMac();
  for (const tool of ["git", "tar", "sips", "iconutil", "hdiutil", "ditto"]) ensureTool(tool);

  const version = appVersion();
  const paths = planPaths({ out: options.out, version });
  const ref = options.ref || "HEAD";
  const channel = options.channel || DEFAULT_DMG_CHANNEL;
  if (!DMG_CHANNELS.includes(channel)) {
    throw new Error(`unknown --channel "${channel}"; use one of: ${DMG_CHANNELS.join(", ")}`);
  }
  const iconSvg = join(ROOT, "apps", "desktop", "assets", "icon.svg");
  const nodeDir = resolve(options.nodeDir || paths.runtimeDir);

  if (options.dryRun) {
    return { ...paths, nodeDir, ref, version, channel, dryRun: true };
  }

  mkdirSync(paths.outDir, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), "rios-macos-dmg-"));
  try {
    await ensureNodeRuntime(nodeDir);
    copyBundle(electronTemplateApp(), paths.appPath);

    const contentsDir = join(paths.appPath, "Contents");
    const resourcesDir = join(contentsDir, "Resources");
    const appResourceDir = join(resourcesDir, "app");
    rmSync(appResourceDir, { recursive: true, force: true });
    stageSource(ref, appResourceDir);

    // Bake a release.json so the installed app knows its exact build, channel,
    // and (dev only) which feed to self-update from. The runner prefers this
    // baked feed over RIOS_UPDATE_FEED_URL in .env, so a dev install never
    // fights the pilot Dropbox link that env-reconcile maintains there.
    const releaseVersion = channelReleaseVersion(channel, ref);
    const releaseInfo = {
      version: releaseVersion,
      build: new Date().toISOString(),
      commit: execFileSync("git", ["rev-parse", ref], { cwd: ROOT, encoding: "utf8" }).trim(),
      channel,
      appName: APP_NAME
    };
    if (channel === "dev") releaseInfo.updateFeedUrl = devUpdateFeedUrl();
    writeFileSync(
      join(appResourceDir, "release.json"),
      JSON.stringify(releaseInfo, null, 2) + "\n"
    );

    if (!options.skipInstall) installDependencies(appResourceDir, nodeDir);
    if (!options.skipBuild) buildRuntimeArtifacts(appResourceDir, nodeDir);
    generateIcon(iconSvg, resourcesDir, temp);
    rewriteInfoPlist(paths.appPath, version);
    renameElectronExecutable(paths.appPath);

    const packagedNodeDir = join(resourcesDir, "runtime", "node");
    rmSync(packagedNodeDir, { recursive: true, force: true });
    // ditto keeps npm/npx/corepack as relative symlinks; cpSync rewrites
    // them to absolute build-machine paths, which breaks npm on any other
    // Mac and fails strict codesign verification.
    copyBundle(nodeDir, packagedNodeDir);
    const footprint = prunePackagedFootprint({
      appPath: paths.appPath,
      appResourceDir,
      packagedNodeDir
    });

    if (!options.noSign) signApp(paths.appPath, process.env.RIOS_CODESIGN_IDENTITY);
    const dmgPath = options.skipDmg ? "" : createDmg(paths.appPath, paths.outDir, version);
    return {
      ...paths,
      dmgPath,
      nodeDir,
      ref,
      version,
      footprint,
      appSizeBytes: logicalBytes(paths.appPath),
      signingIdentity: options.noSign ? "unsigned" : process.env.RIOS_CODESIGN_IDENTITY || "ad-hoc"
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function printHelp() {
  process.stdout.write(`Build a local macOS DMG for ${APP_NAME}.

Usage:
  npm run build:macos-dmg -- [options]

Options:
  --out DIR          Output directory (default: release-dist/macos)
  --ref REF          Git ref to package (default: HEAD)
  --channel NAME     Release channel baked into release.json: "dev" (default,
                     self-updates from the GitHub dev prerelease feed) or
                     "student" (no baked feed; updates come from RIOS_UPDATE_FEED_URL)
  --node-dir DIR     Reuse/download Node 22 in this directory
  --skip-install     Do not run npm ci in the staged app
  --skip-build       Do not prebuild Prisma, runner, core, or dashboard
  --skip-dmg         Build the .app only
  --no-sign          Skip ad-hoc codesign
  --dry-run          Print planned paths without building
`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  buildMacosDmg(args).then((result) => {
    if (result.dryRun) {
      process.stdout.write(`Would build ${result.appPath}\n`);
      process.stdout.write(`Would create ${result.dmgPath}\n`);
      process.stdout.write(`Would use Node runtime ${result.nodeDir}\n`);
      return;
    }
    process.stdout.write(`Built ${result.appPath}\n`);
    if (result.dmgPath) process.stdout.write(`Created ${result.dmgPath}\n`);
    process.stdout.write(`Removed ${result.footprint.removedBytes} bytes of build-only or incompatible packaged files\n`);
  }).catch((error) => {
    process.stderr.write(`\n  build failed: ${error?.message || String(error)}\n`);
    process.exit(1);
  });
}
