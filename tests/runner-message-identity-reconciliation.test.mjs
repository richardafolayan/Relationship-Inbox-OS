import test from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_IDENTITY_FRESHNESS_ERROR,
  resolveMessageIdentityFreshness,
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
