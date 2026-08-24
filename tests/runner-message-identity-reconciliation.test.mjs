import test from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_IDENTITY_FRESHNESS_ERROR,
  PLATFORM_SCAN_CANDIDATE_CAP_ERROR,
  PLATFORM_SCAN_IN_PROGRESS_ERROR,
  PLATFORM_SCAN_THREAD_FAILURE_ERROR,
  resolveMessageIdentityFreshness,
  resolvePlatformScanFreshness,
  resolvePlatformScanStartFreshness,
  reconcilePlatformMessageIdentity
} from "../apps/runner/dist/services/message-identity-reconciliation.js";

const currentMessages = [{
  platformMessageKey: "current",
  direction: "IN",
  text: "Hello",
  attachments: []
}];

test("message identity reconciliation routes through the injected platform capability", async () => {
  const calls = [];
  const result = await reconcilePlatformMessageIdentity({
    reconcilers: {
      INSTAGRAM: async (input) => {
        calls.push(input);
        return { blockedMessageKeys: ["current"], quarantinedMessageKeys: ["current"] };
      }
    },
    platform: "INSTAGRAM",
    threadId: "thread-1",
    currentMessages
  });

  assert.deepEqual(calls, [{ threadId: "thread-1", currentMessages }]);
  assert.deepEqual(result, {
    blockedMessageKeys: ["current"],
    quarantinedMessageKeys: ["current"]
  });
});

test("platforms without an identity reconciler use the no-op contract", async () => {
  assert.deepEqual(
    await reconcilePlatformMessageIdentity({
      reconcilers: {},
      platform: "LINKEDIN",
      threadId: "thread-1",
      currentMessages
    }),
    { blockedMessageKeys: [], quarantinedMessageKeys: [] }
  );
});

test("a quarantine degrades platform freshness without advancing scan time", () => {
  assert.deepEqual(resolveMessageIdentityFreshness(1), {
    freshnessComplete: false,
    status: "DEGRADED",
    lastError: MESSAGE_IDENTITY_FRESHNESS_ERROR,
    advanceLastScanAt: false
  });
});

test("a clean reconciliation can advance platform freshness", () => {
  assert.deepEqual(resolveMessageIdentityFreshness(0), {
    freshnessComplete: true,
    status: "CONNECTED",
    lastError: null,
    advanceLastScanAt: true
  });
});

test("a scan with any thread failure stays degraded and retains its scan time", () => {
  assert.deepEqual(
    resolvePlatformScanFreshness({
      quarantinedMessages: 0,
      threadFailures: 1,
      candidateCapBroke: false
    }),
    {
      freshnessComplete: false,
      status: "DEGRADED",
      lastError: PLATFORM_SCAN_THREAD_FAILURE_ERROR,
      advanceLastScanAt: false,
      stopReason: "thread_sync_failed"
    }
  );
});

test("a capped scan cannot publish authoritative freshness", () => {
  assert.deepEqual(
    resolvePlatformScanFreshness({
      quarantinedMessages: 0,
      threadFailures: 0,
      candidateCapBroke: true
    }),
    {
      freshnessComplete: false,
      status: "DEGRADED",
      lastError: PLATFORM_SCAN_CANDIDATE_CAP_ERROR,
      advanceLastScanAt: false,
      stopReason: "candidate_cap_reached"
    }
  );
});

test("identity quarantine remains the primary freshness failure", () => {
  assert.equal(
    resolvePlatformScanFreshness({
      quarantinedMessages: 2,
      threadFailures: 1,
      candidateCapBroke: true
    }).lastError,
    MESSAGE_IDENTITY_FRESHNESS_ERROR
  );
});

test("scan start preserves healthy and unresolved identity state without a false heal", () => {
  assert.deepEqual(resolvePlatformScanStartFreshness({ outstandingIdentityQuarantines: 0 }), {
    status: "DEGRADED",
    lastError: PLATFORM_SCAN_IN_PROGRESS_ERROR
  });
  assert.deepEqual(
    resolvePlatformScanStartFreshness({
      outstandingIdentityQuarantines: 0,
      previousStatus: "CONNECTED"
    }),
    { status: "CONNECTED", lastError: null }
  );
  assert.deepEqual(resolvePlatformScanStartFreshness({ outstandingIdentityQuarantines: 1 }), {
    status: "DEGRADED",
    lastError: MESSAGE_IDENTITY_FRESHNESS_ERROR
  });
});
