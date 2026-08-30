import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlatformAuthOrSessionError,
  platformScanEligible,
  resolvePlatformPrimaryAction
} from "../apps/dashboard/lib/platform-setup.ts";

const row = (over = {}) => ({
  platform: "LINKEDIN",
  status: "ERROR",
  lastScanAt: null,
  connectedAt: null,
  lastError: null,
  enabled: true,
  profileDir: "/tmp/profile",
  ...over
});

test("CONNECTED and non-auth DEGRADED stay scan-primary", () => {
  assert.equal(resolvePlatformPrimaryAction(row({ status: "CONNECTED" })), "scan");
  assert.equal(resolvePlatformPrimaryAction(row({ status: "DEGRADED" })), "scan");
  assert.equal(platformScanEligible(row({ status: "CONNECTED" })), true);
  assert.equal(platformScanEligible(row({ status: "DEGRADED" })), true);
});

test("DEGRADED + session expired leads with Reconnect, not Scan", () => {
  const degradedSession = row({
    status: "DEGRADED",
    lastError: "session expired on LinkedIn",
    connectedAt: "2026-06-01T10:00:00.000Z",
    lastScanAt: "2026-06-02T10:00:00.000Z"
  });
  assert.equal(isPlatformAuthOrSessionError(degradedSession), true);
  assert.equal(resolvePlatformPrimaryAction(degradedSession), "reconnect");
  assert.equal(platformScanEligible(degradedSession), false);
});

test("DEGRADED + selector mismatch stays scan-primary", () => {
  const degradedSelector = row({
    status: "DEGRADED",
    lastError: "selector mismatch on inbox list",
    connectedAt: "2026-06-01T10:00:00.000Z",
    lastScanAt: "2026-06-02T10:00:00.000Z"
  });
  assert.equal(isPlatformAuthOrSessionError(degradedSelector), false);
  assert.equal(resolvePlatformPrimaryAction(degradedSelector), "scan");
  assert.equal(platformScanEligible(degradedSelector), true);
});

test("NOT_CONNECTED leads with Connect", () => {
  assert.equal(resolvePlatformPrimaryAction(row({ status: "NOT_CONNECTED" })), "connect");
  assert.equal(platformScanEligible(row({ status: "NOT_CONNECTED" })), false);
});

test("an unselected source is setup-primary and never scan-eligible", () => {
  const disabled = row({
    enabled: false,
    status: "CONNECTED",
    connectedAt: "2026-06-01T10:00:00.000Z"
  });
  assert.equal(resolvePlatformPrimaryAction(disabled), "setup");
  assert.equal(platformScanEligible(disabled), false);
});

test("ERROR without auth/session stays scan-eligible", () => {
  const errorRow = row({
    status: "ERROR",
    lastError: "selector mismatch on inbox list"
  });
  assert.equal(isPlatformAuthOrSessionError(errorRow), false);
  assert.equal(resolvePlatformPrimaryAction(errorRow), "scan");
  assert.equal(platformScanEligible(errorRow), true);
});

test("ERROR with auth/session loss leads with Connect or Reconnect", () => {
  const neverConnected = row({
    status: "ERROR",
    lastError: "login required before scan can continue",
    connectedAt: null,
    lastScanAt: null
  });
  assert.equal(isPlatformAuthOrSessionError(neverConnected), true);
  assert.equal(resolvePlatformPrimaryAction(neverConnected), "connect");
  assert.equal(platformScanEligible(neverConnected), false);

  const previouslyConnected = row({
    status: "ERROR",
    lastError: "session expired on LinkedIn",
    connectedAt: "2026-06-01T10:00:00.000Z",
    lastScanAt: "2026-06-02T10:00:00.000Z"
  });
  assert.equal(isPlatformAuthOrSessionError(previouslyConnected), true);
  assert.equal(resolvePlatformPrimaryAction(previouslyConnected), "reconnect");
  assert.equal(platformScanEligible(previouslyConnected), false);
});

test("auth-required and session-closed error text classify as session loss", () => {
  assert.equal(
    isPlatformAuthOrSessionError(row({ lastError: "AUTH_REQUIRED: please sign in" })),
    true
  );
  assert.equal(
    isPlatformAuthOrSessionError(
      row({
        lastError: null,
        lastScanFailure: {
          requestId: "r1",
          stage: "collect_threads",
          reason: "session_closed",
          errorSummary: "session closed while opening inbox",
          timestamp: "2026-06-02T10:00:00.000Z"
        }
      })
    ),
    true
  );
  assert.equal(
    isPlatformAuthOrSessionError(row({ lastError: "credentials missing for provider" })),
    true
  );
});
