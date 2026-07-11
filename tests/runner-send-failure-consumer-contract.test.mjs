import test from "node:test";
import assert from "node:assert/strict";

const {
  classifySendFailureKind,
  consumerSendFailure,
  parsePersistedSendFailure
} = await import("../apps/runner/src/services/send-failure.ts");

test("post-click verification failures are delivery uncertain", () => {
  const kind = classifySendFailureKind({
    message: "Could not confirm the LinkedIn message was delivered, no new outbound bubble appeared"
  });
  const failure = consumerSendFailure(kind);

  assert.equal(kind, "DELIVERY_UNCERTAIN");
  assert.equal(failure.retrySafe, false);
  assert.equal(failure.deliveryUncertain, true);
  assert.match(failure.message, /check the conversation/i);
});

test("interrupted claimed sends stay uncertain after restart", () => {
  const failure = parsePersistedSendFailure(
    JSON.stringify({
      message: "Runner restarted while this send was in progress",
      errorKind: "INTERRUPTED",
      stack: "private diagnostic stack"
    })
  );

  assert.equal(failure.errorKind, "DELIVERY_UNCERTAIN");
  assert.equal(failure.retrySafe, false);
  assert.equal(failure.deliveryUncertain, true);
  assert.doesNotMatch(failure.message, /stack|runner restarted/i);
});

test("definite send failures return safe recovery copy", () => {
  const failure = parsePersistedSendFailure(
    JSON.stringify({
      message: "TimeoutError at Locator.click line 9912",
      errorKind: "TRANSIENT"
    })
  );

  assert.equal(failure.errorKind, "TRANSIENT");
  assert.equal(failure.retrySafe, true);
  assert.equal(failure.deliveryUncertain, false);
  assert.doesNotMatch(failure.message, /Locator|9912|TimeoutError/);
});
