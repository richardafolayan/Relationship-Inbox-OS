import test from "node:test";
import assert from "node:assert/strict";
import { buildDemoSendReceipt } from "../apps/runner/dist/services/demo-send.js";

// The demo send adapter is the sandbox's safety boundary for outbound
// messaging — when presenterDemoMode === "sandbox", send.ts branches
// here BEFORE the real platform adapter is selected, so a sandbox send
// can never reach iMessage / LinkedIn / Instagram / TikTok / WhatsApp.
//
// These tests cover the receipt's contract: every field needed
// downstream by processSendRequest is populated, and the
// platformMessageKey is prefixed `demo-out-` so the persisted Message
// row is unambiguously identifiable in logs / tests / debugging.

test("buildDemoSendReceipt returns a valid SendReceipt shape", () => {
  const receipt = buildDemoSendReceipt();
  assert.equal(typeof receipt.sentAt, "string");
  // ISO 8601 — Date.parse round-trips losslessly.
  assert.ok(!Number.isNaN(Date.parse(receipt.sentAt)));
  assert.equal(receipt.verifiedBy, "best_effort");
  assert.equal(typeof receipt.platformMessageKey, "string");
});

test("buildDemoSendReceipt prefixes platformMessageKey with `demo-out-`", () => {
  const receipt = buildDemoSendReceipt();
  assert.ok(receipt.platformMessageKey.startsWith("demo-out-"));
});

test("buildDemoSendReceipt produces unique keys per call", () => {
  const r1 = buildDemoSendReceipt();
  const r2 = buildDemoSendReceipt();
  assert.notEqual(r1.platformMessageKey, r2.platformMessageKey);
});

test("buildDemoSendReceipt sentAt is roughly now", () => {
  const before = Date.now();
  const receipt = buildDemoSendReceipt();
  const at = Date.parse(receipt.sentAt);
  const after = Date.now();
  assert.ok(at >= before - 50);
  assert.ok(at <= after + 50);
});
