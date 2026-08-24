import type { NormalizedMessage, PlatformName } from "@inbox-os/core";

export interface MessageIdentityReconciliationResult {
  blockedMessageKeys: string[];
  quarantinedMessageKeys: string[];
}

export const MESSAGE_IDENTITY_FRESHNESS_ERROR =
  "Platform freshness is incomplete because historical message identity could not be reconciled safely.";
export const PLATFORM_SCAN_THREAD_FAILURE_ERROR =
  "Platform freshness is incomplete because one or more conversations could not be checked.";
export const PLATFORM_SCAN_CANDIDATE_CAP_ERROR =
  "Platform freshness is incomplete because the scan stopped before every candidate was checked.";
export const PLATFORM_SCAN_IN_PROGRESS_ERROR =
  "Platform freshness is still being checked.";

export function resolveMessageIdentityFreshness(quarantinedMessages: number): {
  freshnessComplete: boolean;
  status: "CONNECTED" | "DEGRADED";
  lastError: string | null;
  advanceLastScanAt: boolean;
} {
  if (quarantinedMessages > 0) {
    return {
      freshnessComplete: false,
      status: "DEGRADED",
      lastError: MESSAGE_IDENTITY_FRESHNESS_ERROR,
      advanceLastScanAt: false
    };
  }
  return {
    freshnessComplete: true,
    status: "CONNECTED",
    lastError: null,
    advanceLastScanAt: true
  };
}

export function resolvePlatformScanFreshness(input: {
  quarantinedMessages: number;
  threadFailures: number;
  candidateCapBroke: boolean;
}): {
  freshnessComplete: boolean;
  status: "CONNECTED" | "DEGRADED";
  lastError: string | null;
  advanceLastScanAt: boolean;
  stopReason: "scan_complete" | "message_identity_quarantine" | "thread_sync_failed" | "candidate_cap_reached";
} {
  if (input.quarantinedMessages > 0) {
    return {
      freshnessComplete: false,
      status: "DEGRADED",
      lastError: MESSAGE_IDENTITY_FRESHNESS_ERROR,
      advanceLastScanAt: false,
      stopReason: "message_identity_quarantine"
    };
  }
  if (input.threadFailures > 0) {
    return {
      freshnessComplete: false,
      status: "DEGRADED",
      lastError: PLATFORM_SCAN_THREAD_FAILURE_ERROR,
      advanceLastScanAt: false,
      stopReason: "thread_sync_failed"
    };
  }
  if (input.candidateCapBroke) {
    return {
      freshnessComplete: false,
      status: "DEGRADED",
      lastError: PLATFORM_SCAN_CANDIDATE_CAP_ERROR,
      advanceLastScanAt: false,
      stopReason: "candidate_cap_reached"
    };
  }
  return {
    freshnessComplete: true,
    status: "CONNECTED",
    lastError: null,
    advanceLastScanAt: true,
    stopReason: "scan_complete"
  };
}

export function resolvePlatformScanStartFreshness(input: {
  outstandingIdentityQuarantines: number;
  previousStatus?: "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
  previousLastError?: string | null;
}): {
  status: "CONNECTED" | "DEGRADED";
  lastError: string | null;
} {
  const identityIncomplete =
    input.outstandingIdentityQuarantines > 0 ||
    input.previousLastError === MESSAGE_IDENTITY_FRESHNESS_ERROR;
  if (identityIncomplete) {
    return { status: "DEGRADED", lastError: MESSAGE_IDENTITY_FRESHNESS_ERROR };
  }
  if (input.previousStatus === "CONNECTED") {
    return { status: "CONNECTED", lastError: null };
  }
  if (input.previousStatus === "DEGRADED" && input.previousLastError) {
    return { status: "DEGRADED", lastError: input.previousLastError };
  }
  return { status: "DEGRADED", lastError: PLATFORM_SCAN_IN_PROGRESS_ERROR };
}

export interface MessageIdentityReconciler {
  (input: {
    threadId: string;
    currentMessages: NormalizedMessage[];
  }): Promise<MessageIdentityReconciliationResult>;
  getOutstandingQuarantineCount?: () => Promise<number>;
}

export async function reconcilePlatformMessageIdentity(input: {
  reconcilers: Partial<Record<PlatformName, MessageIdentityReconciler>>;
  platform: PlatformName;
  threadId: string;
  currentMessages: NormalizedMessage[];
}): Promise<MessageIdentityReconciliationResult> {
  const reconciler = input.reconcilers[input.platform];
  if (!reconciler) {
    return { blockedMessageKeys: [], quarantinedMessageKeys: [] };
  }
  return reconciler({
    threadId: input.threadId,
    currentMessages: input.currentMessages
  });
}
