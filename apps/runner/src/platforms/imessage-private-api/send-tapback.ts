import { sendHelperRequest, type HelperBridgeOptions } from "./helper-bridge";
import type { SendTapbackParams, SendTapbackResult } from "./protocol";

/**
 * Ask the helper to add or remove a real native tapback on a message.
 *
 * Throws PrivateApiError on failure. Notably the helper may reject a `kind`
 * it cannot service on the current macOS / Messages.app build with the
 * `unsupported_kind` code (e.g. iOS 18+ expanded-emoji tapbacks that even
 * the private API can't fully drive yet) — callers should treat that as a
 * clean degrade to the dashboard-only path, not a hard error.
 */
export function sendTapback(
  bridge: HelperBridgeOptions,
  params: SendTapbackParams
): Promise<SendTapbackResult> {
  return sendHelperRequest(bridge, "sendTapback", params);
}
