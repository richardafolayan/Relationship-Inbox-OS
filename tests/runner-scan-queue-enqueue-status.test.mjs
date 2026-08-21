import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueueScanJobByPriority,
  jobCoversTriggeredScan,
  promoteQueuedJob,
  resolveEnqueueStatus,
  resolveScheduledScanPlatforms,
  shouldDelayBetweenThreadScans
} from "../apps/runner/dist/services/scan-queue.js";

// Regression for P1-L3: enqueueScan must report "running" for the job that
// starts immediately, not always "queued".
//
// The decision is read from `processing` BEFORE triggerProcessNext() runs.
// processNext() synchronously sets `processing = true` for the new job before
// its first await, so the old code (reading `processing` after the trigger)
// always evaluated to "queued" and the "running" branch was dead. The helper
// takes the pre-enqueue snapshot of `processing` and is the unit under test.

test("resolveEnqueueStatus reports running when no job is in flight", () => {
  // processing was false before enqueue -> this job starts immediately.
  assert.equal(resolveEnqueueStatus(false), "running");
});

test("event-triggered scans jump ahead of scheduled backlog", () => {
  const jobs = ["scheduled-linkedin", "scheduled-whatsapp"];
  enqueueScanJobByPriority(jobs, "live-imessage", true);
  assert.deepEqual(jobs, ["live-imessage", "scheduled-linkedin", "scheduled-whatsapp"]);
  enqueueScanJobByPriority(jobs, "manual-rescan", false);
  assert.equal(jobs.at(-1), "manual-rescan");
});

test("a coalesced live scan is promoted without duplicating it", () => {
  const jobs = ["scheduled-linkedin", "live-imessage", "manual-rescan"];
  promoteQueuedJob(jobs, 1);
  assert.deepEqual(jobs, ["live-imessage", "scheduled-linkedin", "manual-rescan"]);
});

test("resolveEnqueueStatus reports queued when a job is already in flight", () => {
  // processing was true before enqueue -> this job waits behind the active one.
  assert.equal(resolveEnqueueStatus(true), "queued");
});

test("scheduled scans include only enabled platforms with adapters", () => {
  const platforms = ["LINKEDIN", "IMESSAGE", "WHATSAPP"];
  const adapters = { LINKEDIN: {}, IMESSAGE: {}, WHATSAPP: {} };
  assert.deepEqual(
    resolveScheduledScanPlatforms(platforms, ["IMESSAGE", "WHATSAPP"], adapters),
    ["IMESSAGE", "WHATSAPP"]
  );
  assert.deepEqual(
    resolveScheduledScanPlatforms(platforms, ["LINKEDIN", "WHATSAPP"], {
      LINKEDIN: {}
    }),
    ["LINKEDIN"]
  );
});

test("human pacing applies only to LinkedIn browser scans", () => {
  assert.equal(shouldDelayBetweenThreadScans("LINKEDIN"), true);
  for (const platform of ["IMESSAGE", "WHATSAPP", "GOOGLE_MESSAGES", "INSTAGRAM", "TIKTOK"]) {
    assert.equal(shouldDelayBetweenThreadScans(platform), false, platform);
  }
});

test("platform-wide queued scans cover targeted change triggers", () => {
  assert.equal(
    jobCoversTriggeredScan({ platform: "WHATSAPP" }, "WHATSAPP", "group@g.us"),
    true
  );
  assert.equal(
    jobCoversTriggeredScan(
      { platform: "WHATSAPP", platformThreadId: "a@c.us" },
      "WHATSAPP",
      "b@c.us"
    ),
    false
  );
});
