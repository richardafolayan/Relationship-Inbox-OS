import { createHealthProbe } from "./health";
import { sendThreadedReply as bridgeSendThreadedReply } from "./send-reply";
import { sendTapback as bridgeSendTapback } from "./send-tapback";
import { PrivateApiError } from "./protocol";
import type {
  SendTapbackParams,
  SendTapbackResult,
  SendThreadedReplyParams,
  SendThreadedReplyResult
} from "./protocol";
import type { HelperBridgeOptions } from "./helper-bridge";

export {
  PrivateApiError,
  PRIVATE_API_PROTOCOL_VERSION,
  type TapbackKind,
  type TapbackAction,
  type PrivateApiErrorCode
} from "./protocol";

/**
 * Opt-in "opportunistic native send" layer for iMessage (#273).
 *
 * The facade the rest of the runner talks to. It does NOT know how to send a
 * plain-text bubble or write a dashboard-only row — that is the caller's
 * fallback. Its only job is: "is a native helper reachable right now, and if
 * so, drive a native threaded reply / tapback through it." Every method
 * throws PrivateApiError on failure so the caller makes one uniform
 * try-native-then-fall-back decision.
 *
 * The actual helper is an external macOS bundle injected into Messages.app
 * (requires SIP off — see docs/imessage-private-api.md). This module only
 * speaks the socket protocol; it is fully functional against the local mock
 * helper under tools/mock-imessage-helper/ for testing without disabling SIP.
 */
export interface PrivateApiHelperConfig {
  enabled: boolean;
  socketPath: string;
  requestTimeoutMs: number;
  healthCacheMs: number;
  /** Optional structured logger; defaults to a no-op. */
  log?: (event: { level: "info" | "warn"; msg: string; detail?: Record<string, unknown> }) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface PrivateApiHelper {
  /** Whether the layer is configured on at all (independent of reachability). */
  readonly enabled: boolean;
  /** Fast, cached liveness probe. False whenever native send is unavailable. */
  isReachable(): Promise<boolean>;
  sendThreadedReply(params: SendThreadedReplyParams): Promise<SendThreadedReplyResult>;
  sendTapback(params: SendTapbackParams): Promise<SendTapbackResult>;
  /** Human-readable one-liner for boot logs. */
  describe(): string;
}

export function createPrivateApiHelper(config: PrivateApiHelperConfig): PrivateApiHelper {
  const log = config.log ?? (() => {});
  // The health probe gets its own short timeout so a hung helper can never
  // stall a send for the full request budget.
  const probeTimeoutMs = Math.min(config.requestTimeoutMs, 1_000);
  const health = createHealthProbe({
    enabled: config.enabled,
    socketPath: config.socketPath,
    probeTimeoutMs,
    cacheMs: config.healthCacheMs,
    now: config.now
  });

  const bridge: HelperBridgeOptions = {
    socketPath: config.socketPath,
    timeoutMs: config.requestTimeoutMs
  };

  // On a transport failure the helper has likely gone away (Messages.app
  // relaunched, bundle unloaded). Drop the cached liveness so the next
  // isReachable() re-probes instead of optimistically reporting reachable.
  function noteFailure(error: unknown): never {
    if (error instanceof PrivateApiError && error.code === "transport") {
      health.invalidate();
    }
    throw error;
  }

  return {
    enabled: config.enabled,
    isReachable: () => health.isReachable(),
    async sendThreadedReply(params) {
      try {
        const result = await bridgeSendThreadedReply(bridge, params);
        log({ level: "info", msg: "private-api threaded reply sent", detail: { chatGuid: params.chatGuid } });
        return result;
      } catch (error) {
        log({
          level: "warn",
          msg: "private-api threaded reply failed",
          detail: { code: error instanceof PrivateApiError ? error.code : "unknown" }
        });
        return noteFailure(error);
      }
    },
    async sendTapback(params) {
      try {
        const result = await bridgeSendTapback(bridge, params);
        log({ level: "info", msg: "private-api tapback sent", detail: { chatGuid: params.chatGuid, kind: params.kind, action: params.action } });
        return result;
      } catch (error) {
        log({
          level: "warn",
          msg: "private-api tapback failed",
          detail: { code: error instanceof PrivateApiError ? error.code : "unknown", kind: params.kind }
        });
        return noteFailure(error);
      }
    },
    describe() {
      return config.enabled
        ? `iMessage private-API helper: ENABLED (socket=${config.socketPath}, timeout=${config.requestTimeoutMs}ms)`
        : "iMessage private-API helper: disabled";
    }
  };
}
