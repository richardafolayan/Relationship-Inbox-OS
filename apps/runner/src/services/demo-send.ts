import { randomUUID } from "node:crypto";
import type { SendReceipt } from "@inbox-os/core";

/**
 * Build a synthetic SendReceipt for a sandbox-mode demo send. The runner's
 * send service calls this INSTEAD of the real platform adapter when
 * `presenterDemoMode === "sandbox"` and the target thread is in the demo
 * manifest. Real iMessage / LinkedIn / Instagram / TikTok adapter code is
 * never reached, so a demo send cannot accidentally hit a real platform.
 *
 * The returned receipt slots into the same downstream flow as an adapter
 * receipt: a Message row is upserted by `processSendRequest`, the
 * MESSAGE_SENT event fires, the dashboard's optimistic bubble clears.
 * The platformMessageKey is prefixed `demo-out-` so tests can assert
 * unambiguously that the send went through the demo path.
 */
export function buildDemoSendReceipt(): SendReceipt {
  return {
    sentAt: new Date().toISOString(),
    verifiedBy: "best_effort",
    platformMessageKey: `demo-out-${randomUUID()}`
  };
}
