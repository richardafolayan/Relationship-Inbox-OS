/**
 * Stable identifier for a piece of audio we may transcribe. Used to dedupe
 * re-scans against the same voice note so we never spend a second OpenAI
 * call on audio we have already seen (success, failure, or skip).
 *
 * Today the runner only transcribes iMessage voice notes, where chat.db
 * gives every attachment a stable guid. The fingerprint folds in the
 * Message row's `platformMessageKey` so a single attachment guid that
 * somehow drifts across two messages doesn't collide. The integer index
 * is a fallback for attachments without a guid; iMessage always supplies
 * one in practice but the typed shape allows null.
 */
export function buildAudioFingerprint(input: {
  messageId: string;
  platformMessageKey: string;
  attachmentGuid: string | null | undefined;
  attachmentIndex: number;
}): string {
  const id = input.attachmentGuid?.trim() || `idx-${input.attachmentIndex}`;
  return `${input.messageId}|${input.platformMessageKey}|${id}`;
}
