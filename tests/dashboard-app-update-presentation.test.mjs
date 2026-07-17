import test from "node:test";
import assert from "node:assert/strict";

const {
  buildTechnicalDetails,
  clearAppUpdatesSnapshot,
  describeUpdateState,
  extractBranchRef,
  extractPullRequestRef,
  hostAppTitle,
  hostOfflineCheckMessage,
  installLocationCopy,
  isTechnicalReleaseNote,
  presentReleaseNotes,
  readAppUpdatesSnapshot,
  technicalDetailsOpenByDefault,
  toUserFacingReleaseNote,
  updateRestartNotice,
  writeAppUpdatesSnapshot
} = await import("../apps/dashboard/lib/app-update-presentation.ts");

// ---------------------------------------------------------------------------
// Host identity copy
// ---------------------------------------------------------------------------

test("hostAppTitle names the app and the host device", () => {
  assert.equal(hostAppTitle("Tovi", "Richard's MacBook"), "Tovi on Richard's MacBook");
  assert.equal(hostAppTitle("Tovi", "  "), "Tovi on your Mac");
});

test("install location copy points at the host, not the phone", () => {
  assert.equal(installLocationCopy("mac"), "Updates install on your Mac");
  assert.equal(installLocationCopy("pc"), "Updates install on this PC");
  assert.equal(installLocationCopy("computer"), "Updates install on this computer");
});

test("host offline copy explains why Check for updates is unavailable", () => {
  assert.match(hostOfflineCheckMessage("mac"), /unavailable while your Mac is offline/i);
  assert.match(hostOfflineCheckMessage("mac"), /Open the app on your Mac/i);
});

test("restart notice warns that phone access may disconnect", () => {
  const notice = updateRestartNotice("Tovi", "mac");
  assert.match(notice, /Phone access may disconnect/i);
  assert.match(notice, /restarts on your Mac/i);
  assert.match(notice, /messages and settings are kept/i);
});

// ---------------------------------------------------------------------------
// User-facing vs technical release notes
// ---------------------------------------------------------------------------

test("dev-build notes become calm user-facing copy and keep raw technical lines", () => {
  const raw = "Dev build abc1234: fix: improve platform connection reliability (#850)";
  assert.equal(toUserFacingReleaseNote(raw), "Improve platform connection reliability");
  const presented = presentReleaseNotes([raw]);
  assert.deepEqual(presented.userFacing, ["Improve platform connection reliability"]);
  assert.ok(presented.technicalLines.includes(raw));
});

test("already user-facing notes pass through without technical noise", () => {
  const raw = "Improved platform connection reliability";
  assert.equal(toUserFacingReleaseNote(raw), "Improved platform connection reliability");
  const presented = presentReleaseNotes([raw]);
  assert.deepEqual(presented.userFacing, [raw]);
  assert.equal(presented.technicalLines.length, 0);
});

test("merge and student pilot metadata stay out of the normal user view", () => {
  assert.equal(
    toUserFacingReleaseNote("Merge pull request #879 from richardafolayan/fix/platform-card-consistency"),
    null
  );
  assert.equal(toUserFacingReleaseNote("Student pilot build 0.1.15."), null);
  assert.equal(isTechnicalReleaseNote("Merge pull request #879 from org/fix/x"), true);
  assert.equal(isTechnicalReleaseNote("Student pilot build 0.1.15."), true);
});

test("technical details carry commit, channel, PR and branch metadata", () => {
  const notes = [
    "Dev build deadbeef: fix: clearer labels (#913)",
    "Merge pull request #913 from richardafolayan/fix/issue-913-mobile-app-updates"
  ];
  const details = buildTechnicalDetails({
    commit: "deadbeefcafebabe",
    channel: "dev",
    build: "2026-07-18T00:00:00Z",
    branch: extractBranchRef(notes),
    pullRequest: extractPullRequestRef(notes),
    technicalLines: presentReleaseNotes(notes).technicalLines
  });
  const byLabel = Object.fromEntries(details.map((d) => [d.label, d.value]));
  assert.equal(byLabel.Channel, "dev");
  assert.equal(byLabel.Commit, "deadbeefcafe");
  assert.equal(byLabel["Pull request"], "#913");
  assert.match(byLabel.Branch, /fix\/issue-913-mobile-app-updates/);
  assert.ok(details.some((d) => d.label === "Note"));
});

test("technical details open by default only in explicit developer mode", () => {
  assert.equal(technicalDetailsOpenByDefault("dev"), true);
  assert.equal(technicalDetailsOpenByDefault("student"), false);
  assert.equal(technicalDetailsOpenByDefault(undefined), false);
});

// ---------------------------------------------------------------------------
// Update states
// ---------------------------------------------------------------------------

test("describeUpdateState covers checking, available, installing, offline and error", () => {
  assert.equal(describeUpdateState({ state: "up_to_date" }), "Up to date");
  assert.equal(describeUpdateState({ state: "checking" }), "Checking…");
  assert.equal(
    describeUpdateState({ state: "available", latestVersion: "0.1.16" }),
    "Update available: v0.1.16"
  );
  assert.equal(describeUpdateState({ state: "updating" }), "Downloading and installing…");
  assert.match(describeUpdateState({ state: "restart_required" }), /Restart required/i);
  assert.equal(describeUpdateState({ state: "host_offline" }), "Host offline");
  assert.equal(
    describeUpdateState({ state: "error", errorMessage: "Feed unreachable" }),
    "Feed unreachable"
  );
});

// ---------------------------------------------------------------------------
// Snapshot cache survives Settings navigation
// ---------------------------------------------------------------------------

test("app updates snapshot can be written and read back", () => {
  clearAppUpdatesSnapshot();
  assert.equal(readAppUpdatesSnapshot(), null);
  writeAppUpdatesSnapshot({
    hostLabel: "Richard's MacBook",
    hostKind: "mac",
    currentVersion: "0.1.15",
    latestVersion: "0.1.15",
    updateAvailable: false,
    configured: true,
    automaticUpdates: true,
    currentReleaseNotes: [],
    releaseNotes: [],
    status: "up_to_date",
    statusMessage: "Up to date",
    error: "",
    started: null,
    installHelp: "",
    updatedAt: 1
  });
  const snap = readAppUpdatesSnapshot();
  assert.equal(snap?.hostLabel, "Richard's MacBook");
  assert.equal(snap?.currentVersion, "0.1.15");
  assert.equal(snap?.status, "up_to_date");
  clearAppUpdatesSnapshot();
});
