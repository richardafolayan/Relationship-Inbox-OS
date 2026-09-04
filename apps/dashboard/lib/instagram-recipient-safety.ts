export type InstagramRecipientSafety = {
  blocked: boolean;
  blockReason: string | null;
  displayName: string;
  linkedContactName: string | null;
  platformRecipientLabel: string | null;
};

export function normalizeRecipientIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function instagramRecipientSafety(input: {
  platform: string;
  personName: string;
  recipientVerificationLabel?: string | null;
}): InstagramRecipientSafety {
  if (input.platform !== "INSTAGRAM") {
    return {
      blocked: false,
      blockReason: null,
      displayName: input.personName,
      linkedContactName: null,
      platformRecipientLabel: null
    };
  }

  const platformRecipientLabel = input.recipientVerificationLabel?.trim() || null;
  if (!platformRecipientLabel) {
    return {
      blocked: true,
      blockReason:
        "Sending is paused because Tovi could not verify the Instagram recipient. Scan this conversation again before sending.",
      displayName: "Instagram recipient unavailable",
      linkedContactName: input.personName,
      platformRecipientLabel: null
    };
  }

  if (
    normalizeRecipientIdentity(platformRecipientLabel) !==
    normalizeRecipientIdentity(input.personName)
  ) {
    return {
      blocked: false,
      blockReason: null,
      displayName: platformRecipientLabel,
      linkedContactName: input.personName,
      platformRecipientLabel
    };
  }

  return {
    blocked: false,
    blockReason: null,
    displayName: platformRecipientLabel,
    linkedContactName: null,
    platformRecipientLabel
  };
}
