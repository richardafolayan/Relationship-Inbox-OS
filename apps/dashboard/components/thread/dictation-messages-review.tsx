"use client";

import { useCallback, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
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
  splitMessage,
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
}

/**
 * #880 review surface after "Turn into messages". Editable bubbles with
 * delete / split / merge / reorder / copy. Never sends. Original transcript
 * stays available via Keep original.
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
  onDismiss
}: DictationMessagesReviewProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [splitHintId, setSplitHintId] = useState<string | null>(null);

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

  if (formatting) {
    return (
      <div className="mb-1.5 rounded-[10px] border border-hairline bg-paper-2 px-3 py-2.5 text-[12px] text-ink-2">
        <p className="m-0 font-medium text-ink">Turning into messages…</p>
        <p className="m-0 mt-1 text-[11px] leading-snug text-ink-3">
          Keeping your wording. Light fixes only.
        </p>
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
          className="shrink-0 text-ink-3 transition-colors duration-calm hover:text-ink"
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
              className="w-full resize-y bg-transparent text-[13px] leading-[1.45] text-ink outline-none placeholder:text-ink-3"
              aria-label={`Message ${index + 1}`}
            />
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <button
                type="button"
                title="Move up"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => onMessagesChange(moveMessage(messages, msg.id, "up"))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <button
                type="button"
                title="Move down"
                aria-label="Move down"
                disabled={index === messages.length - 1}
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
                className="inline-flex h-6 items-center gap-1 rounded-pill px-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
              >
                <Scissors className="h-3 w-3" strokeWidth={2} />
                Split
              </button>
              <button
                type="button"
                title="Merge with next"
                aria-label="Merge with next"
                disabled={index >= messages.length - 1}
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
                onClick={() => void copyText(msg.text, msg.id)}
                className="inline-flex h-6 items-center gap-1 rounded-pill px-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
              >
                <Copy className="h-3 w-3" strokeWidth={2} />
                {copiedId === msg.id ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                title="Delete"
                aria-label="Delete message"
                disabled={messages.length <= 1}
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

      <details className="mt-2 px-0.5">
        <summary className="cursor-pointer font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3">
          Original transcript
        </summary>
        <p className="m-0 mt-1 whitespace-pre-wrap text-[11px] leading-snug text-ink-2">
          {originalTranscript}
        </p>
      </details>

      <div className="mt-2 flex flex-wrap items-center gap-2 px-0.5">
        <button
          type="button"
          onClick={() => onUseInComposer(joinMessagesForCopy(messages))}
          disabled={messages.every((m) => !m.text.trim())}
          className="rounded-pill border border-hairline-strong bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink transition-colors duration-calm hover:bg-paper-2 disabled:opacity-40"
        >
          Use in composer
        </button>
        <button
          type="button"
          onClick={() => void copyText(joinMessagesForCopy(messages), "all")}
          disabled={messages.every((m) => !m.text.trim())}
          className="rounded-pill border border-hairline bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 transition-colors duration-calm hover:text-ink disabled:opacity-40"
        >
          {copiedAll ? "Copied all" : "Copy all"}
        </button>
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
