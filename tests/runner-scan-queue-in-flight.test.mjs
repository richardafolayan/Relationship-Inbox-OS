import test from "node:test";
import assert from "node:assert/strict";
import {
  isLinkedInInFlight
} from "../apps/runner/dist/services/linkedin-inflight-guard.js";

test("LinkedIn in-flight guard blocks second trigger while LinkedIn scan is active", () => {
  const currentJob = {
    platform: "LINKEDIN"
  };
  const blocked = isLinkedInInFlight({
    requestedPlatform: "LINKEDIN",
    currentJob,
    queuedJobs: []
  });
  assert.equal(blocked, true);
});

test("LinkedIn in-flight guard blocks second trigger when all-platform job is queued", () => {
  const blocked = isLinkedInInFlight({
    requestedPlatform: "LINKEDIN",
    currentJob: null,
    queuedJobs: [{ platform: undefined }]
  });
  assert.equal(blocked, true);
});

test("LinkedIn in-flight guard allows non-LinkedIn-only scans when LinkedIn is active", () => {
  const blocked = isLinkedInInFlight({
    requestedPlatform: "INSTAGRAM",
    currentJob: { platform: "LINKEDIN" },
    queuedJobs: []
  });
  assert.equal(blocked, false);
});
