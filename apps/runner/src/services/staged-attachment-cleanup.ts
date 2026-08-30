export type StagedAttachmentOwnership = "owned" | "unowned" | "unknown";

export function shouldDiscardStagedAttachments(input: {
  handled: boolean;
  ownership: StagedAttachmentOwnership;
  persistenceAttempted: boolean;
}): boolean {
  if (input.handled) return false;
  if (!input.persistenceAttempted) return true;
  return input.ownership === "unowned";
}
