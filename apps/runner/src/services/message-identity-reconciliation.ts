import type { NormalizedMessage, PlatformName } from "@inbox-os/core";

export interface MessageIdentityReconciliationResult {
  blockedMessageKeys: string[];
  quarantinedMessageKeys: string[];
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
