import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAdapterFailureKind,
  resolveConnectFailureResponse,
  shouldStopScanForFailureKind
} from "../apps/runner/dist/services/failure-routing.js";
import { AdapterFailure } from "../apps/runner/dist/platforms/utils.js";
import { buildAdaptiveProbeIndices, findFirstPassingProbeIndex } from "../apps/runner/dist/services/selector-tests.js";

test("resolveConnectFailureResponse maps AUTH_REQUIRED failures to 401 and NOT_CONNECTED", () => {
  const error = new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
    kind: "AUTH_REQUIRED",
    details: { url: "https://www.linkedin.com/uas/login?session_redirect=true" }
  });

  const resolved = resolveConnectFailureResponse({
    message: error.message,
    error
  });

  assert.equal(resolved.failureKind, "AUTH_REQUIRED");
  assert.equal(resolved.failureType, "AUTH_REQUIRED");
  assert.equal(resolved.httpStatus, 401);
  assert.equal(resolved.platformStatus, "NOT_CONNECTED");
});

test("resolveConnectFailureResponse falls back to message-based auth detection", () => {
  const error = new Error(
    "LinkedIn connect failed (waiting for selector) (url: https://www.linkedin.com/uas/login?session_redirect=true)"
  );

  const resolved = resolveConnectFailureResponse({
    message: error.message,
    error
  });

  assert.equal(resolved.failureKind, "AUTH_REQUIRED");
  assert.equal(resolved.failureType, "AUTH_REQUIRED");
  assert.equal(resolved.httpStatus, 401);
  assert.equal(resolved.platformStatus, "NOT_CONNECTED");
});

test("resolveConnectFailureResponse keeps timeout mapping at 504", () => {
  const error = new Error("CONNECT_LINKEDIN timed out after 25000ms");

  const resolved = resolveConnectFailureResponse({
    message: error.message,
    error
  });

  assert.equal(resolved.failureType, "CONNECT_TIMEOUT");
  assert.equal(resolved.httpStatus, 504);
  assert.equal(resolved.platformStatus, "ERROR");
});

test("resolveAdapterFailureKind falls back to thread fetch classification by message", () => {
  const error = new Error("Failed to fetch LinkedIn thread messages for Nnenna Nwabuisi");

  assert.equal(resolveAdapterFailureKind(error), "THREAD_FETCH_FAILED");
});

test("shouldStopScanForFailureKind only stops scans for AUTH_REQUIRED", () => {
  assert.equal(shouldStopScanForFailureKind("AUTH_REQUIRED"), true);
  assert.equal(shouldStopScanForFailureKind("THREAD_FETCH_FAILED"), false);
  assert.equal(shouldStopScanForFailureKind(undefined), false);
});

test("buildAdaptiveProbeIndices limits probing to first 8 thread candidates", () => {
  assert.deepEqual(buildAdaptiveProbeIndices(0), []);
  assert.deepEqual(buildAdaptiveProbeIndices(3), [0, 1, 2]);
  assert.deepEqual(buildAdaptiveProbeIndices(12), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("findFirstPassingProbeIndex tries later threads when first one is not reply-capable", async () => {
  const probed = [];
  const matchIndex = await findFirstPassingProbeIndex([0, 1, 2, 3], async (index) => {
    probed.push(index);
    return index === 2;
  });

  assert.equal(matchIndex, 2);
  assert.deepEqual(probed, [0, 1, 2]);
});
