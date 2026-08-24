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
export const PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR =
  "Platform freshness is incomplete because the scan could not prove it reached the end of the inbox.";
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
  collectionIncomplete?: boolean;
}): {
  freshnessComplete: boolean;
  status: "CONNECTED" | "DEGRADED";
  lastError: string | null;
  advanceLastScanAt: boolean;
  stopReason:
    | "scan_complete"
    | "message_identity_quarantine"
    | "thread_sync_failed"
    | "candidate_cap_reached"
    | "collection_incomplete";
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
  if (input.collectionIncomplete) {
    return {
      freshnessComplete: false,
      status: "DEGRADED",
      lastError: PLATFORM_SCAN_COLLECTION_INCOMPLETE_ERROR,
      advanceLastScanAt: false,
      stopReason: "collection_incomplete"
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

export function resolveCollectionBoundaryFreshness(
  completeness: unknown,
  failures: unknown = 0
): {
  candidateCapBroke: boolean;
  collectionIncomplete: boolean;
  collectionFailures: number;
} {
  const collectionFailures =
    typeof failures === "number" && Number.isFinite(failures) && failures > 0
      ? Math.floor(failures)
      : 0;
  if (completeness === "candidate_cap") {
    return { candidateCapBroke: true, collectionIncomplete: false, collectionFailures };
  }
  if (completeness === "incomplete") {
    return { candidateCapBroke: false, collectionIncomplete: true, collectionFailures };
  }
  if (completeness === "complete") {
    return { candidateCapBroke: false, collectionIncomplete: false, collectionFailures };
  }
  return { candidateCapBroke: false, collectionIncomplete: true, collectionFailures };
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
  preserveUntrackedQuarantine?: () => Promise<void>;
}

export async function preparePlatformScanIdentityFreshness(input: {
  reconciler?: Pick<
    MessageIdentityReconciler,
    "getOutstandingQuarantineCount" | "preserveUntrackedQuarantine"
  >;
  previousStatus?: "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
  previousLastError?: string | null;
}): Promise<{
  outstandingIdentityQuarantines: number;
  untrackedIdentityQuarantineFloor: number;
  status: "CONNECTED" | "DEGRADED";
  lastError: string | null;
}> {
  let outstandingIdentityQuarantines = 0;
  let quarantineStorageUnavailable = false;
  try {
    outstandingIdentityQuarantines =
      await input.reconciler?.getOutstandingQuarantineCount?.() ?? 0;
  } catch {
    quarantineStorageUnavailable = true;
  }
  const untrackedIdentityQuarantineFloor =
    quarantineStorageUnavailable ||
    (outstandingIdentityQuarantines === 0 &&
      input.previousLastError === MESSAGE_IDENTITY_FRESHNESS_ERROR)
      ? 1
      : 0;

  if (untrackedIdentityQuarantineFloor > 0) {
    try {
      await input.reconciler?.preserveUntrackedQuarantine?.();
    } catch {
      quarantineStorageUnavailable = true;
    }
    if (!quarantineStorageUnavailable) {
      try {
        outstandingIdentityQuarantines =
          await input.reconciler?.getOutstandingQuarantineCount?.() ?? 0;
      } catch {
        quarantineStorageUnavailable = true;
      }
    }
    outstandingIdentityQuarantines = Math.max(
      untrackedIdentityQuarantineFloor,
      outstandingIdentityQuarantines
    );
  }

  return {
    outstandingIdentityQuarantines,
    untrackedIdentityQuarantineFloor,
    ...resolvePlatformScanStartFreshness({
      outstandingIdentityQuarantines,
      previousStatus: input.previousStatus,
      previousLastError: input.previousLastError
    })
  };
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
