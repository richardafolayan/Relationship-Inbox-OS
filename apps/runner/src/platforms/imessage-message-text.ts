// Shared placeholder for a message that has no readable body. The dashboard
// renders it as "Sent an attachment" in inbox/Today previews and hides it
// behind inline media in the thread timeline. The LinkedIn adapter already
// emits this; iMessage must too.
export const NON_TEXT_MESSAGE_PLACEHOLDER = "[non-text message]";

// An attachment-only iMessage (photo, voice note, sticker with no caption)
// has empty text in chat.db. Persisting that empty string verbatim leaves a
// blank inbox/Today preview row (and a bare "You: "); the placeholder keeps
// the preview meaningful while staying invisible in the timeline.
export function imessageMessageBodyText(
  text: string | null | undefined,
  attachmentCount: number
): string {
  if ((text ?? "").trim().length === 0 && attachmentCount > 0) {
    return NON_TEXT_MESSAGE_PLACEHOLDER;
  }
  return text ?? "";
}
