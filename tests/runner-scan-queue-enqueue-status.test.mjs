import test from "node:test";
import assert from "node:assert/strict";
import {
  beginAdapterCollectionBoundary,
  enqueueScanJobByPriority,
  jobCoversTriggeredScan,
  promoteQueuedJob,
  resolveEnqueueStatus
} from "../apps/runner/dist/services/scan-queue.js";
import {
  PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR,
  resolveCollectionBoundaryFreshness,
  resolvePlatformScanFreshness
} from "../apps/runner/dist/services/message-identity-reconciliation.js";

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

test("a typed bounded collector cannot publish freshness as complete", () => {
  let began = false;
  const capability = beginAdapterCollectionBoundary({
    collectionBoundary: {
      beginCycle: () => {
        began = true;
      },
      getMetrics: () => ({
        totalFound: 3,
        unreadFound: 1,
        stopReason: "instagram_bounded_snapshot"
      })
    }
  });

  assert.equal(began, true);
  const metrics = capability.getMetrics();
  const boundary = resolveCollectionBoundaryFreshness(
    metrics.stopReason,
    metrics.failures,
    true
  );
  const freshness = resolvePlatformScanFreshness({
    quarantinedMessages: 0,
    threadFailures: boundary.collectionFailures,
    candidateCapBroke: boundary.candidateCapBroke,
    collectionIncomplete: boundary.collectionIncomplete
  });

  assert.equal(freshness.freshnessComplete, false);
  assert.equal(freshness.advanceLastScanAt, false);
  assert.equal(freshness.lastError, PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR);
});
