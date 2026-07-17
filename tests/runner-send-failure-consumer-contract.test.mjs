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

test("a missing WhatsApp send result blocks blind retry", () => {
  const kind = classifySendFailureKind({
    message: "WhatsApp delivery could not be confirmed because the send returned no message result"
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

test("a disconnected adapter asks the operator to reconnect, not retry a blip", () => {
  // Regression: "ensureConnected" contains "eConn", which matched the ECONN
  // network-errno token and mislabelled a dropped WhatsApp session as
  // TRANSIENT ("connection stopped, retry") with no reconnect action.
  const kind = classifySendFailureKind({
    message: "WhatsApp adapter not connected — call ensureConnected() first"
  });
  const failure = consumerSendFailure(kind);

  assert.equal(kind, "AUTH_REQUIRED");
  assert.match(failure.message, /reconnect/i);
  assert.doesNotMatch(failure.message, /connection stopped/i);
});

test("real ECONN network errno still classifies as transient", () => {
  const kind = classifySendFailureKind({
    message: "Error: connect ECONNREFUSED 127.0.0.1:443"
  });
  assert.equal(kind, "TRANSIENT");
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
