export interface FormattedDictationMessage {
  id: string;
  text: string;
}

export interface DictationFormattingResult {
  cleanedTranscript: string;
  messages: FormattedDictationMessage[];
  warnings: Array<{ originalText: string; reason: string }>;
  source?: {
    providerId: "openai" | "glm" | "gemini";
    providerDisplayName: string;
    model: string;
  };
}

function nearestSplitPoint(text: string, requestedIndex: number): number | null {
  const index = Math.max(0, Math.min(text.length, requestedIndex));
  if (index > 0 && index < text.length) return index;
  const midpoint = Math.floor(text.length / 2);
  const after = text.slice(midpoint).search(/\s/u);
  if (after >= 0 && midpoint + after > 0 && midpoint + after < text.length) {
    return midpoint + after;
  }
  const before = text.slice(0, midpoint).lastIndexOf(" ");
  return before > 0 ? before : null;
}

export function splitFormattedMessage(text: string, requestedIndex: number): [string, string] | null {
  const splitAt = nearestSplitPoint(text, requestedIndex);
  if (splitAt === null) return null;
  const before = text.slice(0, splitAt).trim();
  const after = text.slice(splitAt).trim();
  return before && after ? [before, after] : null;
}

export function mergeFormattedMessages(before: string, after: string): string {
  return `${before.trim()} ${after.trim()}`.trim();
}

export function formattedMessagesClipboardText(messages: FormattedDictationMessage[]): string {
  return messages.map((message) => message.text.trim()).filter(Boolean).join("\n\n");
}
