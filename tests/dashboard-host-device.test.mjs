import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatHostLastSeen,
  hostDeviceLabel,
  hostKindNoun,
  hostOfflineExplanation,
  hostStatusLine,
  humanizeHostname,
  isRemoteActionAvailable,
  remoteActionLabel,
  runsOnLine,
  updatesInstallLabel,
  voiceModelSizeLabel
} from "../apps/dashboard/lib/host-device.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");

test("humanizeHostname strips .local and title-cases hostname segments", () => {
  assert.equal(humanizeHostname("Richards-MacBook-Pro.local"), "Richards MacBook Pro");
  assert.equal(humanizeHostname("office-pc.lan"), "Office Pc");
  assert.equal(humanizeHostname(""), "");
  assert.equal(humanizeHostname(null), "");
});

test("hostDeviceLabel falls back to your Mac or PC", () => {
  assert.equal(hostDeviceLabel("Richards-MacBook-Pro.local", "darwin"), "Richards MacBook Pro");
  assert.equal(hostDeviceLabel(null, "darwin"), "your Mac");
  assert.equal(hostDeviceLabel(undefined, "win32"), "your PC");
  assert.equal(hostKindNoun("darwin"), "Mac");
  assert.equal(hostKindNoun("win32"), "PC");
});


test("hostDeviceLabel prefers runner-resolved ComputerName label", () => {
  assert.equal(
    hostDeviceLabel("Mac.home", "darwin", "Richard's MacBook"),
    "Richard's MacBook"
  );
  assert.equal(hostDeviceLabel("office-mac.local", "darwin", null), "Office Mac");
});

test("runsOnLine and hostStatusLine describe online and offline host state", () => {
  assert.equal(runsOnLine("Richards-MacBook-Pro.local", "darwin"), "Runs on Richards MacBook Pro");
  assert.equal(runsOnLine(null, "darwin"), "Runs on your Mac");

  assert.equal(
    hostStatusLine({ online: undefined }),
    "Checking connection…"
  );
  assert.equal(
    hostStatusLine({ online: true, lastSeenAt: Date.now() }),
    "Online · Last seen now"
  );
  assert.equal(
    hostStatusLine({
      online: false,
      lastSeenAt: Date.now() - 5 * 60_000,
      now: Date.now()
    }),
    "Offline · Last seen 5m ago"
  );
  assert.equal(
    hostStatusLine({ online: false, lastSeenAt: null, platform: "darwin" }),
    "Offline · Mac unavailable"
  );
  assert.equal(formatHostLastSeen(Date.now() - 90_000, Date.now()), "1m ago");
});

test("remote action labels name the host device for phone Settings", () => {
  assert.equal(remoteActionLabel("scan", "darwin"), "Runs on your Mac");
  assert.equal(remoteActionLabel("openBrowser", "darwin"), "Opens on your Mac");
  assert.equal(remoteActionLabel("fullDiskAccess", "darwin"), "Complete this on your Mac");
  assert.equal(remoteActionLabel("voiceModel", "darwin"), "Installed on your Mac");
  assert.equal(remoteActionLabel("updates", "darwin"), "Updates install on your Mac");
  assert.equal(remoteActionLabel("setupMac", "darwin"), "Complete this on your Mac");
  assert.equal(remoteActionLabel("scan", "win32"), "Runs on your PC");
  assert.equal(
    voiceModelSizeLabel("About 150 MB", "darwin"),
    "Installed on your Mac · About 150 MB"
  );
  assert.equal(updatesInstallLabel("darwin"), "Updates install on your Mac");
});

test("offline actions stay available only while the host is not known offline", () => {
  assert.equal(isRemoteActionAvailable(undefined), true);
  assert.equal(isRemoteActionAvailable(true), true);
  assert.equal(isRemoteActionAvailable(false), false);
  assert.match(
    hostOfflineExplanation("darwin", "Tovi"),
    /Unavailable while your Mac is offline/
  );
  assert.match(hostOfflineExplanation("darwin", "Tovi"), /Open Tovi on your Mac/);
});

test("Settings wires the host-device banner and offline remote-action handling", () => {
  const settings = read("apps/dashboard/app/settings/page.tsx");
  const banner = read("apps/dashboard/components/settings/HostDeviceBanner.tsx");
  const optional = read("apps/dashboard/components/settings/OptionalComponents.tsx");
  const updates = read("apps/dashboard/components/settings/AppUpdates.tsx");
  const whatsapp = read("apps/dashboard/components/settings/WhatsAppConnect.tsx");
  const runnerHealth = read("apps/runner/src/index.ts");
  const types = read("apps/dashboard/lib/types.ts");

  assert.match(settings, /HostDeviceBanner/);
  assert.match(settings, /useHostDevice/);
  assert.match(settings, /usePhoneSettingsLayout/);
  assert.match(settings, /phoneLayout \? \(/);
  assert.match(settings, /host\.offlineExplanation/);
  assert.match(settings, /remoteDisabled/);
  assert.match(settings, /hideProcessPath=\{phoneLayout\}/);
  assert.match(settings, /Mac setup/);
  assert.match(settings, /deviceLabel=\{phoneLayout \? host\.actionLabel/);
  assert.match(settings, /host\.actionLabel\([\s\S]*"scan"/);
  assert.match(settings, /host\.actionLabel\([\s\S]*"connect"/);

  assert.match(banner, /host\.runsOn/);
  assert.match(banner, /host\.statusLine/);
  assert.match(banner, /host\.offlineExplanation/);

  assert.match(optional, /remoteActionLabel\("voiceModel"/);
  assert.match(optional, /Mac storage/);
  assert.match(optional, /remoteBlocked/);
  assert.match(optional, /voiceModelSizeLabel/);

  assert.match(updates, /hostDeviceLabel/);
  assert.match(updates, /from "@\/lib\/host-device"/);
  assert.match(updates, /hostOfflineExplanation/);
  assert.match(updates, /hostOffline|remoteAvailable|remoteBlocked/);
  assert.match(updates, /installLocationCopy|updatesInstallLabel/);

  assert.match(whatsapp, /deviceLabel/);
  assert.match(whatsapp, /remoteDisabled/);
  assert.match(whatsapp, /offlineExplanation/);

  // Runner hostname resolution is owned by services/host-device (shared health + updates).
  assert.match(runnerHealth, /hostDevice:/);
  assert.match(runnerHealth, /resolveHostDeviceInfo/);
  assert.match(runnerHealth, /services\/host-device/);
  assert.doesNotMatch(runnerHealth, /osHostname\(\)/);
  assert.match(types, /hostDevice\?: HostDeviceInfo/);
  assert.match(types, /label\?:/);

  const runnerService = read("apps/runner/src/services/host-device.ts");
  assert.match(runnerService, /export function resolveHostDeviceInfo/);
  assert.match(runnerService, /readMacComputerName/);
  // Version / update-check also surface host label for App updates.
  const runnerIndex = read("apps/runner/src/index.ts");
  assert.match(runnerIndex, /hostDeviceLabel/);
  assert.match(runnerIndex, /hostDeviceKind/);
  assert.match(runnerIndex, /hostDevice:/);

  // User-facing strings only (ignore code comments which may predate this rule).
  const stripComments = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(stripComments(settings), /—|–/);
  assert.doesNotMatch(stripComments(banner), /—|–/);
  assert.doesNotMatch(stripComments(optional), /—|–/);
});

test("auto-scan and scan cadence do not claim Mac-shared storage while phone-local", () => {
  const settings = read("apps/dashboard/app/settings/page.tsx");
  // Auto-scan loop is still a per-browser dashboard behaviour (localStorage).
  // Do not label those rows as Mac controls until they live in runner settings.
  assert.doesNotMatch(settings, /actionLabel\([\s\S]*autoScan/);
  assert.match(settings, /linkedin_dashboard_autoscan_enabled|AUTO_SCAN_KEY/);
  assert.match(settings, /readScanInterval|writeScanInterval/);
  // Headless remains a real Mac/runner setting and may keep the device label.
  assert.match(settings, /actionLabel\([\s\S]*headless/);
});
