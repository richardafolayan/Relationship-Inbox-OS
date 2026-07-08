import test from "node:test";
import assert from "node:assert/strict";
import {
  findPendingCoalescedScan,
  jobCoversPlatform,
  resolveEnqueueStatus
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

test("resolveEnqueueStatus reports queued when a job is already in flight", () => {
  // processing was true before enqueue -> this job waits behind the active one.
  assert.equal(resolveEnqueueStatus(true), "queued");
});

test("jobCoversPlatform treats all-platform jobs as covering a platform", () => {
  assert.equal(jobCoversPlatform(undefined, "LINKEDIN"), true);
  assert.equal(jobCoversPlatform("LINKEDIN", "LINKEDIN"), true);
  assert.equal(jobCoversPlatform("IMESSAGE", "LINKEDIN"), false);
});

test("findPendingCoalescedScan returns an existing queued platform scan", () => {
  const queued = [
    { jobId: "imessage-1", platform: "IMESSAGE" },
    { jobId: "linkedin-1", platform: "LINKEDIN" }
  ];

  assert.equal(findPendingCoalescedScan(queued, "LINKEDIN")?.jobId, "linkedin-1");
  assert.equal(findPendingCoalescedScan(queued, "WHATSAPP"), null);
});

test("findPendingCoalescedScan coalesces behind an all-platform queued scan", () => {
  const queued = [{ jobId: "all-1", platform: undefined }];

  assert.equal(findPendingCoalescedScan(queued, "WHATSAPP")?.jobId, "all-1");
});
