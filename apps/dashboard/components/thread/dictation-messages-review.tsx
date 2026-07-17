"use client";

import { useCallback, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Merge,
  Scissors,
  Trash2,
  X
} from "lucide-react";
import {
  deleteMessage,
  joinMessagesForCopy,
  mergeWithNext,
  moveMessage,
  sequentialSendProgressLabel,
  splitMessage,
  textsReadyToSend,
  updateMessageText,
  type DictationMessageBubble,
  type DictationMessagesWarning
} from "@/lib/dictation-messages";

export interface DictationMessagesReviewProps {
  originalTranscript: string;
  messages: DictationMessageBubble[];
  warnings: DictationMessagesWarning[];
  formatting: boolean;
  formatError: string | null;
  onMessagesChange: (messages: DictationMessageBubble[]) => void;
  onUseInComposer: (text: string) => void;
  onKeepOriginal: () => void;
  onRetryFormat: () => void;
  onDismiss: () => void;
  /** Abort in-flight format request (timeout path still surfaces Retry). */
  onCancelFormat?: () => void;
  /**
   * When set, show "Send as separate messages". Caller walks bubbles through
   * the existing send path; must never auto-fire without this click.
   */
  onSendSequentially?: (
    messages: DictationMessageBubble[],
    opts: { onProgress: (current: number, total: number) => void }
  ) => Promise<void>;
  /** Disable sequential send while the thread composer is already sending. */
  sendBusy?: boolean;
}

/**
 * #880 review surface after "Turn into messages". Editable bubbles with
 * delete / split / merge / reorder / copy. Sequential send is user-triggered
 * only. Original transcript stays available via Keep original.
 */
export function DictationMessagesReview({
  originalTranscript,
  messages,
  warnings,
  formatting,
  formatError,
  onMessagesChange,
  onUseInComposer,
  onKeepOriginal,
  onRetryFormat,
  onDismiss,
  onCancelFormat,
  onSendSequentially,
  sendBusy = false
}: DictationMessagesReviewProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [splitHintId, setSplitHintId] = useState<string | null>(null);
  const [sendProgress, setSendProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendDone, setSendDone] = useState(false);

  const copyText = useCallback(async (text: string, id: string | "all") => {
    try {
      await navigator.clipboard.writeText(text);
      if (id === "all") {
        setCopiedAll(true);
        window.setTimeout(() => setCopiedAll(false), 1500);
      } else {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId(null), 1500);
      }
    } catch {
      /* clipboard may be denied; silent */
    }
  }, []);

  const handleSendSequentially = useCallback(async () => {
    if (!onSendSequentially || sendProgress || sendBusy) return;
    const ready = textsReadyToSend(messages);
    if (ready.length === 0) return;
    setSendError(null);
    setSendDone(false);
    setSendProgress({ current: 0, total: ready.length });
    try {
      await onSendSequentially(messages, {
        onProgress: (current, total) => setSendProgress({ current, total })
      });
      setSendDone(true);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Could not send all messages. Unsent ones are still here.";
      setSendError(message);
    } finally {
      setSendProgress(null);
    }
  }, [messages, onSendSequentially, sendBusy, sendProgress]);

  if (formatting) {
    return (
      <div className="mb-1.5 rounded-[10px] border border-hairline bg-paper-2 px-3 py-2.5 text-[12px] text-ink-2">
        <p className="m-0 font-medium text-ink">Turning into messages…</p>
        <p className="m-0 mt-1 text-[11px] leading-snug text-ink-3">
          Keeping your wording. Light fixes only.
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3">
            Original transcript
          </summary>
          <p className="m-0 mt-1 max-h-[4.5rem] overflow-y-auto whitespace-pre-wrap text-[11px] leading-snug text-ink-2">
            {originalTranscript}
          </p>
        </details>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onCancelFormat ? (
            <button
              type="button"
              onClick={onCancelFormat}
              className="rounded-pill border border-hairline bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 transition-colors duration-calm hover:text-ink"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={onKeepOriginal}
            className="rounded-pill border border-hairline bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 transition-colors duration-calm hover:text-ink"
          >
            Keep as transcript
          </button>
        </div>
      </div>
    );
  }

  if (formatError) {
    return (
      <div className="mb-1.5 rounded-[10px] border border-hairline-strong bg-paper-2 px-3 py-2.5 text-[12px] text-ink-2">
        <p className="m-0 leading-snug">{formatError}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRetryFormat}
            className="rounded-pill border border-hairline-strong bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink transition-colors duration-calm hover:bg-paper-2"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onKeepOriginal}
            className="rounded-pill border border-hairline bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 transition-colors duration-calm hover:text-ink"
          >
            Keep as transcript
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="ml-auto text-ink-3 transition-colors duration-calm hover:text-ink"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
    );
  }

  const readyCount = textsReadyToSend(messages).length;
  const sending = sendProgress !== null;
  const actionsDisabled = sending || sendBusy || readyCount === 0;

  return (
    <div className="mb-1.5 rounded-[10px] border border-hairline bg-paper-2 px-2.5 py-2 text-[12px] text-ink-2">
      <div className="mb-1.5 flex items-start gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[11px] font-medium text-ink">Messages from dictation</p>
          <p className="m-0 mt-0.5 text-[10.5px] leading-snug text-ink-3">
            Edit, reorder, or copy. Nothing is sent until you send it.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          disabled={sending}
          className="shrink-0 text-ink-3 transition-colors duration-calm hover:text-ink disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {messages.map((msg, index) => (
          <li
            key={msg.id}
            className="rounded-[10px] border border-hairline bg-paper px-2 py-1.5 shadow-sm"
          >
            <textarea
              value={msg.text}
              onChange={(e) => onMessagesChange(updateMessageText(messages, msg.id, e.target.value))}
              rows={Math.min(4, Math.max(1, Math.ceil(msg.text.length / 48)))}
              disabled={sending}
              className="w-full resize-y bg-transparent text-[13px] leading-[1.45] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
              aria-label={`Message ${index + 1}`}
            />
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <button
                type="button"
                title="Move up"
                aria-label="Move up"
                disabled={sending || index === 0}
                onClick={() => onMessagesChange(moveMessage(messages, msg.id, "up"))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <button
                type="button"
                title="Move down"
                aria-label="Move down"
                disabled={sending || index === messages.length - 1}
                onClick={() => onMessagesChange(moveMessage(messages, msg.id, "down"))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <button
                type="button"
                title={
                  splitHintId === msg.id
                    ? "Place the caret where you want to split, then click Split again"
                    : "Split at caret"
                }
                aria-label="Split message"
                disabled={sending}
                onClick={(e) => {
                  const ta = (e.currentTarget.closest("li")?.querySelector("textarea") ??
                    null) as HTMLTextAreaElement | null;
                  const caret = ta?.selectionStart ?? Math.floor(msg.text.length / 2);
                  if (splitHintId !== msg.id && ta && ta.selectionStart === ta.selectionEnd && ta.selectionStart === 0) {
                    setSplitHintId(msg.id);
                    window.setTimeout(() => setSplitHintId(null), 2500);
                    return;
                  }
                  setSplitHintId(null);
                  onMessagesChange(splitMessage(messages, msg.id, caret));
                }}
                className="inline-flex h-6 items-center gap-1 rounded-pill px-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              >
                <Scissors className="h-3 w-3" strokeWidth={2} />
                Split
              </button>
              <button
                type="button"
                title="Merge with next"
                aria-label="Merge with next"
                disabled={sending || index >= messages.length - 1}
                onClick={() => onMessagesChange(mergeWithNext(messages, msg.id))}
                className="inline-flex h-6 items-center gap-1 rounded-pill px-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              >
                <Merge className="h-3 w-3" strokeWidth={2} />
                Merge
              </button>
              <button
                type="button"
                title="Copy"
                aria-label="Copy message"
                disabled={sending}
                onClick={() => void copyText(msg.text, msg.id)}
                className="inline-flex h-6 items-center gap-1 rounded-pill px-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              >
                <Copy className="h-3 w-3" strokeWidth={2} />
                {copiedId === msg.id ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                title="Delete"
                aria-label="Delete message"
                disabled={sending || messages.length <= 1}
                onClick={() => onMessagesChange(deleteMessage(messages, msg.id))}
                className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              >
                <Trash2 className="h-3 w-3" strokeWidth={2} />
              </button>
            </div>
            {splitHintId === msg.id ? (
              <p className="m-0 mt-1 text-[10px] text-ink-3">
                Place the caret where you want to split, then click Split.
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {warnings.length > 0 ? (
        <div className="mt-2 rounded-[8px] border border-hairline bg-paper px-2 py-1.5 text-[10.5px] leading-snug text-ink-3">
          <p className="m-0 font-mono text-[9.5px] uppercase tracking-[0.06em]">Unclear parts</p>
          <ul className="m-0 mt-1 list-disc space-y-0.5 pl-4">
            {warnings.map((w, i) => (
              <li key={`${w.originalText}-${i}`}>
                <span className="text-ink-2">{w.originalText}</span>
                {w.reason ? ` (${w.reason})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sendError ? (
        <p className="m-0 mt-2 px-0.5 text-[11px] leading-snug text-risk-overdue">{sendError}</p>
      ) : null}

      <details className="mt-2 px-0.5">
        <summary className="cursor-pointer font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3">
          Original transcript
        </summary>
        <p className="m-0 mt-1 whitespace-pre-wrap text-[11px] leading-snug text-ink-2">
          {originalTranscript}
        </p>
      </details>

      <div className="mt-2 flex flex-wrap items-center gap-2 px-0.5">
        {onSendSequentially ? (
          <button
            type="button"
            onClick={() => void handleSendSequentially()}
            disabled={actionsDisabled}
            className="inline-flex items-center gap-1.5 rounded-pill border border-hairline-strong bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink transition-colors duration-calm hover:bg-paper-2 disabled:opacity-40"
          >
            {sending ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                {sequentialSendProgressLabel(sendProgress.current, sendProgress.total)}
              </>
            ) : sendDone ? (
              "Sent"
            ) : (
              "Send as separate messages"
            )}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onUseInComposer(joinMessagesForCopy(messages))}
          disabled={actionsDisabled}
          className="rounded-pill border border-hairline bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 transition-colors duration-calm hover:text-ink disabled:opacity-40"
        >
          Use in composer
        </button>
        <button
          type="button"
          onClick={() => void copyText(joinMessagesForCopy(messages), "all")}
          disabled={actionsDisabled}
          className="rounded-pill border border-hairline bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 transition-colors duration-calm hover:text-ink disabled:opacity-40"
        >
          {copiedAll ? "Copied all" : "Copy all"}
        </button>
        <button
          type="button"
          onClick={onKeepOriginal}
          disabled={sending}
          className="rounded-pill border border-hairline bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 transition-colors duration-calm hover:text-ink disabled:opacity-40"
        >
          Keep as transcript
        </button>
      </div>
    </div>
  );
}
