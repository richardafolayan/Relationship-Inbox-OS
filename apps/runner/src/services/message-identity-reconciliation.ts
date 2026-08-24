import type { NormalizedMessage, PlatformName } from "@inbox-os/core";

export interface MessageIdentityReconciliationResult {
  blockedMessageKeys: string[];
  quarantinedMessageKeys: string[];
}

export const MESSAGE_IDENTITY_FRESHNESS_ERROR =
  "Platform freshness is incomplete because historical message identity could not be reconciled safely.";

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

export type MessageIdentityReconciler = (input: {
  threadId: string;
  currentMessages: NormalizedMessage[];
}) => Promise<MessageIdentityReconciliationResult>;

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
