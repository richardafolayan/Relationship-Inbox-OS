import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingSendReconcileKey,
  reconcilePendingSendsAgainstThread
} from "../apps/dashboard/lib/pending-send-reconciliation.ts";

const sentAt = "2026-08-30T09:00:00.000Z";

function pending(overrides = {}) {
  return {
    clientSendId: "send-a",
    failed: false,
    sentAt,
    text: "Thanks",
    threadId: "thread-a",
    uncertain: false,
    ...overrides
  };
}

test("loading B cannot remove A's identical pending or uncertain send", () => {
  const rows = [
    pending(),
    pending({ clientSendId: "send-uncertain", uncertain: true })
  ];
  const reconciled = reconcilePendingSendsAgainstThread(rows, {
    id: "thread-b",
    siblingIds: ["thread-b"],
    messages: [{ direction: "OUT", text: "Thanks", timestamp: sentAt }]
  });
  assert.deepEqual(reconciled, rows);
});

test("text fallback removes only a non-uncertain pending row in the fetched cohort", () => {
  const ordinary = pending();
  const uncertain = pending({ clientSendId: "send-uncertain", uncertain: true });
  assert.deepEqual(
    reconcilePendingSendsAgainstThread([ordinary, uncertain], {
      id: "thread-a",
      siblingIds: ["thread-a"],
      messages: [{ direction: "OUT", text: "Thanks", timestamp: sentAt }]
    }),
    [uncertain]
  );
});

test("attachment-only pending rows do not ghost-match empty text", () => {
  const attachmentOnly = pending({ text: "" });
  assert.deepEqual(
    reconcilePendingSendsAgainstThread([attachmentOnly], {
      id: "thread-a",
      siblingIds: ["thread-a"],
      messages: [{ direction: "OUT", text: "", timestamp: sentAt }]
    }),
    [attachmentOnly]
  );
});

test("durable composer attempts reconcile only by clientSendId status", () => {
  const durable = pending({ sessionRevision: 4 });
  assert.deepEqual(
    reconcilePendingSendsAgainstThread([durable], {
      id: "thread-a",
      siblingIds: ["thread-a"],
      messages: [{ direction: "OUT", text: "Thanks", timestamp: sentAt }]
    }),
    [durable]
  );
});

test("retry state changes the polling generation even when array length does not", () => {
  assert.notEqual(
    pendingSendReconcileKey([pending({ failed: true })]),
    pendingSendReconcileKey([pending({ failed: false })])
  );
});
