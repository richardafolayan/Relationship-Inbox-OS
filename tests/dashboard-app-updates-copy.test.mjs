import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(
  join(ROOT, "apps/dashboard/components/settings/AppUpdates.tsx"),
  "utf8"
);
const SETUP_SOURCE = readFileSync(
  join(ROOT, "apps/dashboard/components/common/SetupWizard.tsx"),
  "utf8"
);

test("app update card identifies the host device being updated", () => {
  assert.match(SOURCE, /hostAppTitle/);
  assert.match(SOURCE, /hostDeviceLabel/);
  assert.match(SOURCE, /hostDeviceKind/);
  assert.match(SOURCE, /installLocationCopy/);
  assert.match(SOURCE, /Automatic updates/);
  // Phone remote-control props from host-device Settings wiring.
  assert.match(SOURCE, /from "@\/lib\/host-device"/);
  assert.match(SOURCE, /hostOfflineExplanation/);
  assert.match(SOURCE, /remoteAvailable/);
});

test("app update card keeps pilot copy away from terminal commands", () => {
  assert.match(SOURCE, /Update app/);
  assert.match(SOURCE, /Updating app…/);
  assert.match(SOURCE, /Start runner/);
  assert.match(SOURCE, /checks shortly after opening and once an hour/);
  assert.match(SOURCE, /What&apos;s new|What's new/);
  assert.match(SOURCE, /Array\.isArray\(res\.currentReleaseNotes\)/);
  assert.doesNotMatch(SOURCE, /npm run|node scripts|Terminal|Ctrl \+ C|Update and relaunch|Update staged/);
  assert.doesNotMatch(SOURCE, /Is the app running/);
});

test("raw commit and branch metadata is behind Technical details, not the main view", () => {
  assert.match(SOURCE, /Technical details/);
  assert.match(SOURCE, /buildTechnicalDetails/);
  assert.match(SOURCE, /presentReleaseNotes/);
  assert.match(SOURCE, /technicalDetailsOpenByDefault/);
  // Native <details> only accepts open (React DetailsHTMLAttributes); defaultOpen is invalid.
  assert.match(SOURCE, /open=\{techOpenDefault \? true : undefined\}/);
  assert.doesNotMatch(SOURCE, /defaultOpen=/);
  // Main "What's new" list must not render raw note strings directly.
  assert.doesNotMatch(SOURCE, /currentReleaseNotes\.slice\(0,\s*4\)\.map/);
  assert.doesNotMatch(SOURCE, /info\.releaseNotes\.slice\(0,\s*4\)\.map/);
});

test("host offline disables check and explains why", () => {
  assert.match(SOURCE, /hostOfflineCheckMessage|offlineMessage|hostOfflineExplanation/);
  assert.match(SOURCE, /checkDisabled/);
  assert.match(SOURCE, /hostOffline|runnerOffline/);
  assert.match(SOURCE, /disabled=\{checkDisabled\}/);
});

test("update progress and phone disconnect states are surfaced", () => {
  assert.match(SOURCE, /Downloading and installing|describeUpdateState/);
  assert.match(SOURCE, /restart_required|updateRestartNotice/);
  assert.match(SOURCE, /updateRestartNotice/);
  assert.match(SOURCE, /statusMessage/);
});

test("version and update state are preserved across navigation", () => {
  assert.match(SOURCE, /readAppUpdatesSnapshot/);
  assert.match(SOURCE, /writeAppUpdatesSnapshot/);
});

test("UI copy avoids em and en dashes", () => {
  assert.doesNotMatch(SOURCE, /[—–]/);
});

test("replacement instructions use runner host data instead of browser guessing", () => {
  assert.match(SOURCE, /replaceAppUpdateInstructions\(APP_NAME, LEGACY_APP_NAME, hostKind\)/);
  assert.match(SETUP_SOURCE, /apiGetRaw<HealthResponse>\("\/runner\/health"\)/);
  assert.match(SETUP_SOURCE, /setupUpdateInstructions\(APP_NAME, hostKind\)/);
  assert.doesNotMatch(SETUP_SOURCE, /navigator\.userAgent|navigator\.platform/);
});
