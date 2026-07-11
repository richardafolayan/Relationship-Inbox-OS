import test from "node:test";
import assert from "node:assert/strict";

const { resolveSendRecovery } = await import("../apps/dashboard/lib/send-delivery.ts");

test("send status recovery distinguishes waiting, sent, failed, missing and uncertain", () => {
  assert.deepEqual(
    resolveSendRecovery({ clientSendId: "1", status: "PENDING" }),
    { kind: "waiting" }
  );
  assert.deepEqual(
    resolveSendRecovery({ clientSendId: "1", status: "SENT" }),
    { kind: "sent" }
  );
  assert.equal(
    resolveSendRecovery({ clientSendId: "1", status: "NOT_FOUND" }).kind,
    "not_sent"
  );
  assert.equal(
    resolveSendRecovery({
      clientSendId: "1",
      status: "FAILED",
      errorKind: "AUTH_REQUIRED",
      errorMessage: "This account needs reconnecting. The message was not sent."
    }).kind,
    "failed"
  );
  const uncertain = resolveSendRecovery({
    clientSendId: "1",
    status: "FAILED",
    errorKind: "DELIVERY_UNCERTAIN",
    deliveryUncertain: true
  });
  assert.equal(uncertain.kind, "uncertain");
  assert.match(uncertain.message, /check the conversation/i);
});
