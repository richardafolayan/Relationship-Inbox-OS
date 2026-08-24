import test from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_IDENTITY_FRESHNESS_ERROR,
  PLATFORM_SCAN_CANDIDATE_CAP_ERROR,
  PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR,
  PLATFORM_SCAN_IN_PROGRESS_ERROR,
  PLATFORM_SCAN_THREAD_FAILURE_ERROR,
  preparePlatformScanIdentityFreshness,
  resolveCollectionBoundaryFreshness,
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

test("a collector-level cap is carried into the platform freshness gate", () => {
  assert.deepEqual(resolveCollectionBoundaryFreshness("max_threads"), {
    candidateCapBroke: true,
    collectionIncomplete: false,
    collectionFailures: 0
  });
  assert.equal(
    resolvePlatformScanFreshness({
      quarantinedMessages: 0,
      threadFailures: 0,
      candidateCapBroke: resolveCollectionBoundaryFreshness("max_threads").candidateCapBroke,
      collectionIncomplete: false
    }).lastError,
    PLATFORM_SCAN_CANDIDATE_CAP_ERROR
  );
});

test("a collector that cannot prove the inbox boundary stays degraded", () => {
  for (const stopReason of ["max_duration", "max_iterations", "no_scroll_container"]) {
    const boundary = resolveCollectionBoundaryFreshness(stopReason);
    assert.deepEqual(boundary, {
      candidateCapBroke: false,
      collectionIncomplete: true,
      collectionFailures: 0
    });
    assert.equal(
      resolvePlatformScanFreshness({
        quarantinedMessages: 0,
        threadFailures: 0,
        candidateCapBroke: false,
        collectionIncomplete: boundary.collectionIncomplete
      }).lastError,
      PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR
    );
  }
  assert.deepEqual(resolveCollectionBoundaryFreshness("deep_scroll_exhausted"), {
    candidateCapBroke: false,
    collectionIncomplete: false,
    collectionFailures: 0
  });
});

test("collector row failures are included in the platform failure gate", () => {
  const boundary = resolveCollectionBoundaryFreshness("deep_scroll_exhausted", 1);
  assert.deepEqual(boundary, {
    candidateCapBroke: false,
    collectionIncomplete: false,
    collectionFailures: 1
  });
  assert.equal(
    resolvePlatformScanFreshness({
      quarantinedMessages: 0,
      threadFailures: boundary.collectionFailures,
      candidateCapBroke: false,
      collectionIncomplete: false
    }).lastError,
    PLATFORM_SCAN_THREAD_FAILURE_ERROR
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

test("a pre-marker identity failure is adopted before scan start", async () => {
  let outstandingIdentityQuarantines = 0;
  let preserveCalls = 0;
  const result = await preparePlatformScanIdentityFreshness({
    reconciler: {
      async getOutstandingQuarantineCount() {
        return outstandingIdentityQuarantines;
      },
      async preserveUntrackedQuarantine() {
        preserveCalls += 1;
        outstandingIdentityQuarantines = 1;
      }
    },
    previousStatus: "DEGRADED",
    previousLastError: MESSAGE_IDENTITY_FRESHNESS_ERROR
  });

  assert.equal(preserveCalls, 1);
  assert.deepEqual(result, {
    outstandingIdentityQuarantines: 1,
    untrackedIdentityQuarantineFloor: 1,
    status: "DEGRADED",
    lastError: MESSAGE_IDENTITY_FRESHNESS_ERROR
  });
});
