import test from "node:test";
import assert from "node:assert/strict";

const { resolveSendRecovery, waitForTerminalSendStatus } = await import(
  "../apps/dashboard/lib/send-delivery.ts"
);

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

test("terminal delivery polling does not treat queue acceptance as delivery", async () => {
  const statuses = ["PENDING", "SCHEDULED", "SENT"];
  const reads = [];
  const waits = [];
  const result = await waitForTerminalSendStatus(
    "client/one",
    async (path) => {
      reads.push(path);
      const status = statuses.shift();
      return { clientSendId: "client/one", status };
    },
    async (delay) => {
      waits.push(delay);
    }
  );

  assert.equal(result.status, "SENT");
  assert.deepEqual(reads, [
    "/runner/data/send-status/client%2Fone",
    "/runner/data/send-status/client%2Fone",
    "/runner/data/send-status/client%2Fone"
  ]);
  assert.deepEqual(waits, [250, 300]);
});

test("terminal delivery polling surfaces a retry-safe failure without clearing it", async () => {
  const result = await waitForTerminalSendStatus(
    "client-1",
    async () => ({
      clientSendId: "client-1",
      status: "FAILED",
      retrySafe: true,
      errorKind: "TRANSIENT"
    }),
    async () => {
      throw new Error("a terminal failure must not wait");
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.retrySafe, true);
});

test("terminal delivery polling fails closed when the queue never settles", async () => {
  await assert.rejects(
    waitForTerminalSendStatus(
      "client-1",
      async () => ({ clientSendId: "client-1", status: "PENDING" }),
      async () => undefined,
      2
    ),
    /status must be checked before retrying/
  );
});
