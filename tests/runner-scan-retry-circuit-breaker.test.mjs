import test from "node:test";
import assert from "node:assert/strict";
import {
  ScanRetryController,
  resolveScanBackoffSeconds
} from "../apps/runner/dist/services/scan-retry-controller.js";

test("scan retry controller applies 30s -> 60s -> 120s cooldown progression", () => {
  let nowMs = 1_000;
  const controller = new ScanRetryController(() => nowMs);

  const first = controller.markFailure("LINKEDIN");
  const second = controller.markFailure("LINKEDIN");
  const third = controller.markFailure("LINKEDIN");

  assert.equal(first.retryAfterSeconds, 30);
  assert.equal(second.retryAfterSeconds, 60);
  assert.equal(third.retryAfterSeconds, 120);
  assert.equal(resolveScanBackoffSeconds(1), 30);
  assert.equal(resolveScanBackoffSeconds(2), 60);
  assert.equal(resolveScanBackoffSeconds(3), 120);

  const cooldown = controller.getCooldown("LINKEDIN");
  assert.equal(cooldown.blocked, true);
  assert.equal(cooldown.retryAfterSeconds > 0, true);

  nowMs += 130_000;
  assert.equal(controller.getCooldown("LINKEDIN").blocked, false);
});

test("scan retry controller blocks repeated reload attempts in a rolling window", () => {
  let nowMs = 10_000;
  const controller = new ScanRetryController(() => nowMs, 300_000, 3);

  assert.equal(controller.registerReloadAttempt("LINKEDIN", 1).blocked, false);
  assert.equal(controller.registerReloadAttempt("LINKEDIN", 1).blocked, false);
  assert.equal(controller.registerReloadAttempt("LINKEDIN", 1).blocked, false);
  const blocked = controller.registerReloadAttempt("LINKEDIN", 1);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.retryAfterSeconds > 0, true);

  nowMs += 301_000;
  const unblocked = controller.registerReloadAttempt("LINKEDIN", 1);
  assert.equal(unblocked.blocked, false);
});
