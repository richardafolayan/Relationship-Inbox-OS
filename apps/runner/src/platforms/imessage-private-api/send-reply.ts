import { sendHelperRequest, type HelperBridgeOptions } from "./helper-bridge";
import type { SendThreadedReplyParams, SendThreadedReplyResult } from "./protocol";

/**
 * Ask the helper to send a real native threaded reply: the contact sees the
 * quoted parent + the reply in their Messages.app, not a plain bubble.
 *
 * Throws PrivateApiError on any failure (transport or helper-reported) so the
 * routing layer can fall back to the existing plain-text send.
 */
export function sendThreadedReply(
  bridge: HelperBridgeOptions,
  params: SendThreadedReplyParams
): Promise<SendThreadedReplyResult> {
  return sendHelperRequest(bridge, "sendThreadedReply", params);
}
