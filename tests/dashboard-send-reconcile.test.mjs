import test from "node:test";
import assert from "node:assert/strict";
import { nextSendReconcileDelayMs } from "../apps/dashboard/lib/send-reconcile.ts";

test("send reconciliation polls quickly only inside the active window and backs off", () => {
  assert.equal(nextSendReconcileDelayMs(0), 250);
  assert.equal(nextSendReconcileDelayMs(5_000), 750);
  assert.equal(nextSendReconcileDelayMs(15_000), 2_000);
  assert.equal(nextSendReconcileDelayMs(60_000), 5_000);
  assert.equal(nextSendReconcileDelayMs(0, false), 5_000);
});
