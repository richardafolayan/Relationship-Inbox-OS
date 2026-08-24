#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_APP_NAME, resolveAppName, LEGACY_APP_NAME } from "./lib/branding.mjs";
import { installRecoveryBootstrapPath } from "./lib/install-transaction.mjs";

// Display name only — driven by RIOS_APP_NAME (default "Tovi").
export const APP_NAME = resolveAppName();
export { LEGACY_APP_NAME };
export const DEFAULT_BUNDLE_ID = "com.relationshipinboxos.app";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--app-dir") out.appDir = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--node-dir") out.nodeDir = next();
    else if (arg === "--bundle-id") out.bundleId = next();
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
  }
  return out;
}

function readVersion(appDir) {
  try {
    return JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function plistEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function resolveBundlePath(out) {
  const target = resolve(out || join(homedir(), "Applications"));
  return target.endsWith(".app") ? target : join(target, `${APP_NAME}.app`);
}

export function buildInfoPlist({ bundleId = DEFAULT_BUNDLE_ID, version = "0.0.0" } = {}) {
  const safeBundleId = plistEscape(bundleId);
  const safeVersion = plistEscape(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${safeBundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${safeVersion}</string>
  <key>CFBundleSignature</key>
  <string>RIOS</string>
  <key>CFBundleVersion</key>
  <string>${safeVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>${APP_NAME} sends through Messages when you press Send or enable a focus note for one focus window.</string>
  <key>NSContactsUsageDescription</key>
  <string>${APP_NAME} uses contacts stored on this Mac to show familiar names. Contact data stays on this Mac.</string>
</dict>
</plist>
`;
}

export function buildLauncherScript({ appDir, nodeDir }) {
  const recoveryScript = installRecoveryBootstrapPath(appDir);
  return `#!/bin/bash
set -u

APP_DIR=${shellSingleQuote(appDir)}
NODE_DIR=${shellSingleQuote(nodeDir || "")}
RECOVERY_SCRIPT=${shellSingleQuote(recoveryScript)}
DASHBOARD_PORT="\${DASHBOARD_PORT:-3100}"
DASHBOARD_URL="http://localhost:\${DASHBOARD_PORT}"
LOG_DIR="$HOME/Library/Logs/RelationshipInboxOS"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="\${TMPDIR:-/tmp}"
LOG_FILE="$LOG_DIR/app-$(date +%Y%m%d-%H%M%S).log"

alert() {
  /usr/bin/osascript -e "display dialog \\"$1\\" buttons {\\"OK\\"} default button \\"OK\\" with title \\"${APP_NAME}\\"" >/dev/null 2>&1 || true
}

if /usr/bin/curl -fsS --max-time 2 "$DASHBOARD_URL" >/dev/null 2>&1; then
  /usr/bin/open "$DASHBOARD_URL" >/dev/null 2>&1 || true
  exit 0
fi

NODE=""
if [ -n "\${RIOS_NODE_PATH:-}" ] && [ -x "\${RIOS_NODE_PATH:-}" ]; then
  NODE="$RIOS_NODE_PATH"
elif [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ]; then
  NODE="$NODE_DIR/bin/node"
elif [ -x "$HOME/.rios-node/bin/node" ]; then
  NODE="$HOME/.rios-node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
fi

if [ -z "$NODE" ]; then
  alert "Node.js is missing. Run the ${APP_NAME} installer again so it can repair the app."
  exit 1
fi

if [ ! -f "$APP_DIR/scripts/start-student.mjs" ] && [ -f "$RECOVERY_SCRIPT" ]; then
  "$NODE" "$RECOVERY_SCRIPT" recover-serialized --app-dir "$APP_DIR" >>"$LOG_FILE" 2>&1 || true
fi

if [ ! -f "$APP_DIR/scripts/start-student.mjs" ]; then
  alert "${APP_NAME} is not installed where this app expects it. Run the installer again."
  exit 1
fi

export PATH="$(dirname "$NODE"):$APP_DIR/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$APP_DIR" || exit 1

echo "Starting ${APP_NAME} from $APP_DIR" >>"$LOG_FILE"
exec "$NODE" "$APP_DIR/scripts/start-student.mjs" >>"$LOG_FILE" 2>&1
`;
}

export function createMacosAppBundle({ appDir = ROOT, out, nodeDir, bundleId = DEFAULT_BUNDLE_ID, dryRun = false } = {}) {
  const resolvedAppDir = resolve(appDir);
  const bundlePath = resolveBundlePath(out);
  const contentsDir = join(bundlePath, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  const executablePath = join(macosDir, APP_NAME);
  const version = readVersion(resolvedAppDir);
  const resolvedNodeDir = nodeDir ? resolve(nodeDir) : join(homedir(), ".rios-node");

  if (dryRun) {
    return { bundlePath, executablePath, version, dryRun: true };
  }

  rmSync(bundlePath, { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(join(contentsDir, "Info.plist"), buildInfoPlist({ bundleId, version }));
  writeFileSync(
    join(resourcesDir, "app-path.txt"),
    `${resolvedAppDir}\n`
  );
  writeFileSync(executablePath, buildLauncherScript({ appDir: resolvedAppDir, nodeDir: resolvedNodeDir }));
  chmodSync(executablePath, 0o755);

  // A display-name change can leave an older wrapper beside the new one.
  // Remove known prior names only when the bundle identifier proves it is ours.
  for (const priorName of new Set([DEFAULT_APP_NAME, LEGACY_APP_NAME])) {
    const legacyBundle = join(dirname(bundlePath), `${priorName}.app`);
    if (legacyBundle === bundlePath || !existsSync(legacyBundle)) continue;
    try {
      const plist = readFileSync(join(legacyBundle, "Contents", "Info.plist"), "utf8");
      if (plist.includes(`<string>${bundleId}</string>`)) {
        rmSync(legacyBundle, { recursive: true, force: true });
      }
    } catch {
      // Unreadable plist means it is not our wrapper; leave it alone.
    }
  }

  return { bundlePath, executablePath, version, dryRun: false };
}

function printHelp() {
  process.stdout.write(`Create a local macOS app bundle for ${APP_NAME}.

Usage:
  node scripts/create-macos-app-bundle.mjs [--app-dir DIR] [--out DIR_OR_APP] [--node-dir DIR]

Defaults:
  --app-dir   current repo/install folder
  --out       ~/Applications/${APP_NAME}.app
  --node-dir  ~/.rios-node
`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!existsSync(resolve(args.appDir || ROOT, "package.json"))) {
    process.stderr.write("Could not find package.json in the app dir.\n");
    process.exit(1);
  }
  const result = createMacosAppBundle(args);
  process.stdout.write(
    result.dryRun
      ? `Would create ${result.bundlePath}\n`
      : `Created ${result.bundlePath}\n`
  );
}
