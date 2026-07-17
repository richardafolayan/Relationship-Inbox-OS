// #880: client helpers for voice-preserving "Turn into messages" after
// dictation. Pure bubble operations (edit/delete/split/merge/reorder/copy)
// live here so the review UI stays thin and the rules are unit-tested.

export interface DictationMessageBubble {
  id: string;
  text: string;
}

export interface DictationMessagesWarning {
  originalText: string;
  reason: string;
}

export interface FormatDictationMessagesResponse {
  ok?: boolean;
  cleanedTranscript?: string;
  messages?: DictationMessageBubble[];
  warnings?: DictationMessagesWarning[];
  error?: string;
}

export type FormatDictationOutcome =
  | {
      kind: "ok";
      cleanedTranscript: string;
      messages: DictationMessageBubble[];
      warnings: DictationMessagesWarning[];
    }
  | { kind: "error"; message: string };

export const FORMAT_DICTATION_GENERIC_ERROR =
  "Could not turn the transcript into messages. Your original transcript is still here.";

/**
 * Validate the runner response before the UI trusts it. On any invalid
 * shape, return error so the page keeps the original transcript.
 */
export function classifyFormatDictationResponse(
  input: { ok: boolean; status: number; data: FormatDictationMessagesResponse }
): FormatDictationOutcome {
  const { ok, data } = input;
  if (!ok || data.ok === false) {
    const msg =
      typeof data.error === "string" && data.error.trim()
        ? data.error.trim()
        : FORMAT_DICTATION_GENERIC_ERROR;
    return { kind: "error", message: msg };
  }

  const rawMessages = Array.isArray(data.messages) ? data.messages : null;
  if (!rawMessages || rawMessages.length === 0) {
    return { kind: "error", message: FORMAT_DICTATION_GENERIC_ERROR };
  }

  const messages: DictationMessageBubble[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const item = rawMessages[i];
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    messages.push({
      id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `message-${messages.length + 1}`,
      text
    });
  }

  if (messages.length === 0) {
    return { kind: "error", message: FORMAT_DICTATION_GENERIC_ERROR };
  }

  const cleanedTranscript =
    typeof data.cleanedTranscript === "string" && data.cleanedTranscript.trim()
      ? data.cleanedTranscript.trim()
      : "";

  const warnings: DictationMessagesWarning[] = [];
  if (Array.isArray(data.warnings)) {
    for (const w of data.warnings) {
      if (!w || typeof w !== "object") continue;
      const originalText = typeof w.originalText === "string" ? w.originalText.trim() : "";
      const reason = typeof w.reason === "string" ? w.reason.trim() : "";
      if (!originalText && !reason) continue;
      warnings.push({
        originalText: originalText || "(unclear)",
        reason: reason || "The intended wording could not be confirmed"
      });
    }
  }

  return {
    kind: "ok",
    cleanedTranscript,
    messages,
    warnings
  };
}

function renumber(messages: DictationMessageBubble[]): DictationMessageBubble[] {
  return messages.map((m, i) => ({ ...m, id: `message-${i + 1}` }));
}

export function updateMessageText(
  messages: DictationMessageBubble[],
  id: string,
  text: string
): DictationMessageBubble[] {
  return messages.map((m) => (m.id === id ? { ...m, text } : m));
}

export function deleteMessage(
  messages: DictationMessageBubble[],
  id: string
): DictationMessageBubble[] {
  return renumber(messages.filter((m) => m.id !== id));
}

/**
 * Split one message into two at a character offset. The caret offset is
 * clamped; empty halves are dropped.
 */
export function splitMessage(
  messages: DictationMessageBubble[],
  id: string,
  offset: number
): DictationMessageBubble[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return messages;
  const current = messages[idx];
  if (!current) return messages;
  const cut = Math.max(0, Math.min(offset, current.text.length));
  const left = current.text.slice(0, cut).trim();
  const right = current.text.slice(cut).trim();
  if (!left && !right) return messages;
  if (!left) return updateMessageText(messages, id, right);
  if (!right) return updateMessageText(messages, id, left);
  const next = [...messages];
  next.splice(idx, 1, { id: current.id, text: left }, { id: `${current.id}-b`, text: right });
  return renumber(next);
}

/** Merge message at `id` with the next adjacent message. */
export function mergeWithNext(
  messages: DictationMessageBubble[],
  id: string
): DictationMessageBubble[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0 || idx >= messages.length - 1) return messages;
  const a = messages[idx];
  const b = messages[idx + 1];
  if (!a || !b) return messages;
  const joined = [a.text.trim(), b.text.trim()].filter(Boolean).join(" ");
  const next = [...messages];
  next.splice(idx, 2, { id: a.id, text: joined });
  return renumber(next);
}

export function moveMessage(
  messages: DictationMessageBubble[],
  id: string,
  direction: "up" | "down"
): DictationMessageBubble[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return messages;
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= messages.length) return messages;
  const next = [...messages];
  const current = next[idx];
  const swap = next[target];
  if (!current || !swap) return messages;
  next[idx] = swap;
  next[target] = current;
  return renumber(next);
}

/** Join bubbles for "copy all" / put-in-composer. One blank line between. */
export function joinMessagesForCopy(messages: DictationMessageBubble[]): string {
  return messages
    .map((m) => m.text.trim())
    .filter(Boolean)
    .join("\n\n");
}
