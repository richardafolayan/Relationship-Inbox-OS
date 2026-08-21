"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Combine,
  Copy,
  GripVertical,
  Loader2,
  Scissors,
  Send,
  Trash2,
  X
} from "lucide-react";
import { v4 as uuid } from "uuid";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import {
  formattedMessagesClipboardText,
  mergeFormattedMessages,
  splitFormattedMessage,
  type DictationFormattingResult,
  type FormattedDictationMessage
} from "@/lib/dictation-messages";

interface DictationMessageReviewProps {
  threadId: string;
  transcript: string;
  onKeepTranscript: (transcript: string) => void;
  onDone: () => void;
  onMessageSent: () => void;
  onSendMessage: (text: string) => Promise<void>;
}

type View = "choice" | "formatting" | "review" | "error" | "sending";

export function DictationMessageReview({
  threadId,
  transcript,
  onKeepTranscript,
  onDone,
  onMessageSent,
  onSendMessage
}: DictationMessageReviewProps) {
  const [view, setView] = useState<View>("choice");
  const [rawTranscript, setRawTranscript] = useState(transcript);
  const [result, setResult] = useState<DictationFormattingResult | null>(null);
  const [messages, setMessages] = useState<FormattedDictationMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendingMessageIds, setSendingMessageIds] = useState<Set<string>>(() => new Set());
  const [sentMessageIds, setSentMessageIds] = useState<Set<string>>(() => new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && view !== "formatting" && view !== "sending") {
        event.preventDefault();
        onKeepTranscript(rawTranscript);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [onKeepTranscript, rawTranscript, view]);

  const format = async () => {
    setView("formatting");
    setError(null);
    try {
      const formatted = await apiPost<DictationFormattingResult>(
        `/runner/control/thread/${threadId}/format-dictation-messages`,
        { transcript: rawTranscript }
      );
      if (!formatted.messages.length) throw new Error("No messages were returned.");
      setResult(formatted);
      setMessages(formatted.messages);
      setView("review");
    } catch (formatError) {
      setError(formatError instanceof Error ? formatError.message : "Could not format this transcript.");
      setView("error");
    }
  };

  const updateMessage = (id: string, text: string) => {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, text } : message)));
  };

  const deleteMessage = (id: string) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  };

  const splitMessage = (index: number) => {
    const message = messages[index];
    if (!message) return;
    const textarea = textareaRefs.current[message.id];
    const split = splitFormattedMessage(message.text, textarea?.selectionStart ?? message.text.length);
    if (!split) {
      setError("Put the cursor between two parts of the message, then try split again.");
      return;
    }
    setError(null);
    setMessages((current) => [
      ...current.slice(0, index),
      { ...message, text: split[0] },
      { id: uuid(), text: split[1] },
      ...current.slice(index + 1)
    ]);
  };

  const mergeWithPrevious = (index: number) => {
    if (index < 1) return;
    setMessages((current) => {
      const before = current[index - 1];
      const after = current[index];
      if (!before || !after) return current;
      return [
        ...current.slice(0, index - 1),
        { ...before, text: mergeFormattedMessages(before.text, after.text) },
        ...current.slice(index + 1)
      ];
    });
  };

  const moveMessage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= messages.length) return;
    setMessages((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const sendMessages = async () => {
    const ready = messages.filter((message) => !sentMessageIds.has(message.id) && message.text.trim());
    if (!ready.length) return;
    setView("sending");
    setError(null);
    const sentTexts: string[] = [];
    for (let index = 0; index < ready.length; index += 1) {
      try {
        const message = ready[index]!;
        const text = message.text.trim();
        await onSendMessage(text);
        sentTexts.push(text);
        setSentMessageIds((current) => new Set(current).add(message.id));
      } catch (sendError) {
        if (sentTexts.length) {
          void apiPost(`/runner/control/thread/${threadId}/dictation-message-example`, {
            messages: sentTexts
          }).catch(() => undefined);
        }
        const remaining = ready.length - index;
        setError(
          `${sendError instanceof Error ? sendError.message : "Sending stopped."} ${remaining} ${remaining === 1 ? "message is" : "messages are"} still here.`
        );
        setView("review");
        return;
      }
    }
    void apiPost(`/runner/control/thread/${threadId}/dictation-message-example`, {
      messages: sentTexts
    }).catch(() => undefined);
    onDone();
  };

  const sendOneMessage = async (message: FormattedDictationMessage) => {
    const text = message.text.trim();
    if (!text || sendingMessageIds.has(message.id) || sentMessageIds.has(message.id) || view === "sending") return;
    setSendingMessageIds((current) => new Set(current).add(message.id));
    setError(null);
    try {
      await onSendMessage(text);
      setSentMessageIds((current) => new Set(current).add(message.id));
      onMessageSent();
      void apiPost(`/runner/control/thread/${threadId}/dictation-message-example`, {
        messages: [text]
      }).catch(() => undefined);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "This message was not sent. Try again.");
    } finally {
      setSendingMessageIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
    }
  };

  const copyOneMessage = async (message: FormattedDictationMessage) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedMessageId(message.id);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedMessageId(null), 1200);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Could not copy this message.");
    }
  };

  const reviewVisible = view === "review" || view === "sending";

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] backdrop-blur-sm sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dictation-review-title"
    >
      <section className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-[24px] border border-hairline bg-paper shadow-card sm:max-h-[min(760px,calc(100dvh-40px))] sm:max-w-[680px] sm:rounded-card">
        <header className="flex items-start gap-3 border-b border-hairline px-4 pb-3 pt-[max(16px,env(safe-area-inset-top))] sm:px-6 sm:pb-4 sm:pt-5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Voice note</p>
            <h2 id="dictation-review-title" className="mt-1 text-[18px] font-semibold tracking-[-0.02em] text-ink">
              {reviewVisible ? "Review your messages" : "What should happen next?"}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
              {reviewVisible
                ? "Edit anything you want. Nothing sends until you choose Send messages."
                : "Keep the exact transcript, or turn it into natural messages that preserve your final meaning and voice."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onKeepTranscript(rawTranscript)}
            disabled={view === "formatting" || view === "sending"}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink disabled:opacity-40"
            aria-label="Keep transcript and close"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
          {view === "choice" ? (
            <div className="space-y-4">
              <textarea
                value={rawTranscript}
                onChange={(event) => setRawTranscript(event.target.value)}
                rows={Math.max(5, Math.min(12, Math.ceil(rawTranscript.length / 42)))}
                className="w-full resize-y rounded-[16px] border border-hairline bg-paper-2 px-4 py-3 text-[15px] leading-relaxed text-ink outline-none transition-colors duration-calm focus:border-accent-ink/60 focus:ring-2 focus:ring-accent-ink/10"
                aria-label="Raw transcript"
              />
              <p className="text-[12px] leading-relaxed text-ink-3">
                Edit any words Tovi misheard before keeping or formatting this transcript.
              </p>
            </div>
          ) : null}

          {view === "formatting" ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center" aria-live="polite">
              <Loader2 className="h-6 w-6 animate-spin text-ink-2" strokeWidth={1.6} />
              <p className="mt-4 text-[15px] font-medium text-ink">Turning this into messages…</p>
              <p className="mt-1 max-w-[340px] text-[13px] leading-relaxed text-ink-3">
                Working out your final meaning and keeping it in your voice.
              </p>
            </div>
          ) : null}

          {view === "error" ? (
            <div className="space-y-4" aria-live="polite">
              <div className="rounded-[16px] border border-accent-ink/30 bg-accent-soft px-4 py-3 text-[13px] leading-relaxed text-ink-2">
                <p className="font-medium text-ink">The formatter did not finish</p>
                <p className="mt-1">{error}</p>
              </div>
              <details className="rounded-[16px] border border-hairline bg-paper-2 px-4 py-3 text-[13px] text-ink-2">
                <summary className="cursor-pointer font-medium text-ink">Original transcript</summary>
                <p className="mt-3 whitespace-pre-wrap leading-relaxed">{rawTranscript}</p>
              </details>
            </div>
          ) : null}

          {reviewVisible ? (
            <div className="space-y-3">
              {result?.source ? (
                <p className="text-[11px] leading-relaxed text-ink-3">
                  Formatted with {result.source.providerDisplayName}, model {result.source.model}
                </p>
              ) : null}
              {messages.map((message, index) => {
                const messageSending = sendingMessageIds.has(message.id);
                const messageSent = sentMessageIds.has(message.id);
                const messageBusy = view === "sending" || messageSending || messageSent;
                return (
                  <article
                    key={message.id}
                    className={`rounded-[18px] border border-hairline bg-paper-2 p-3 transition-opacity duration-calm sm:p-4 ${messageSent ? "opacity-60" : ""}`}
                  >
                  <div className="flex items-center gap-2 text-[11px] text-ink-3">
                    <GripVertical className="h-4 w-4" strokeWidth={1.6} />
                    <span className="font-mono uppercase tracking-[0.06em]">Message {index + 1}</span>
                  </div>
                  <textarea
                    ref={(element) => {
                      textareaRefs.current[message.id] = element;
                    }}
                    value={message.text}
                    onChange={(event) => updateMessage(message.id, event.target.value)}
                    disabled={messageBusy}
                    rows={Math.max(2, Math.min(5, Math.ceil(message.text.length / 52)))}
                    className="mt-2 w-full resize-none rounded-[13px] border border-hairline bg-paper px-3 py-2.5 text-[15px] leading-relaxed text-ink outline-none transition-colors duration-calm focus:border-accent-ink/60 focus:ring-2 focus:ring-accent-ink/10 disabled:opacity-60"
                    aria-label={`Message ${index + 1}`}
                  />
                  <div className="mt-2 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveMessage(index, -1)}
                      disabled={index === 0 || messageBusy}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-30"
                      aria-label={`Move message ${index + 1} up`}
                    >
                      <ArrowUp className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveMessage(index, 1)}
                      disabled={index === messages.length - 1 || messageBusy}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-30"
                      aria-label={`Move message ${index + 1} down`}
                    >
                      <ArrowDown className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      onClick={() => splitMessage(index)}
                      disabled={messageBusy}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-30"
                      aria-label={`Split message ${index + 1} at cursor`}
                    >
                      <Scissors className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      onClick={() => mergeWithPrevious(index)}
                      disabled={index === 0 || messageBusy}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-30"
                      aria-label={`Merge message ${index + 1} with previous`}
                    >
                      <Combine className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyOneMessage(message)}
                      disabled={messageBusy}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-paper hover:text-ink disabled:opacity-30"
                      aria-label={copiedMessageId === message.id ? `Copied message ${index + 1}` : `Copy message ${index + 1}`}
                    >
                      {copiedMessageId === message.id ? (
                        <Check className="h-4 w-4" strokeWidth={2} />
                      ) : (
                        <Copy className="h-4 w-4" strokeWidth={1.8} />
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      className="h-9 shrink-0 px-2 text-[11px]"
                      onClick={() => void sendOneMessage(message)}
                      disabled={!message.text.trim() || view === "sending" || messageSending || messageSent}
                    >
                      {messageSending ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
                          Sending…
                        </>
                      ) : messageSent ? (
                        <>
                          <Check className="h-4 w-4" strokeWidth={2} />
                          Sent
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4" strokeWidth={1.8} />
                          Send
                        </>
                      )}
                    </Button>
                    <button
                      type="button"
                      onClick={() => deleteMessage(message.id)}
                      disabled={messageBusy}
                      className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-accent-soft hover:text-accent-ink disabled:opacity-30"
                      aria-label={`Delete message ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                  </div>
                  </article>
                );
              })}

              {messages.length === 0 ? (
                <div className="rounded-[16px] border border-hairline bg-paper-2 px-4 py-5 text-center text-[13px] leading-relaxed text-ink-2">
                  All message bubbles were removed. Keep the original transcript or try formatting it again.
                </div>
              ) : null}

              {result?.warnings.length ? (
                <details className="rounded-[16px] border border-hairline px-4 py-3 text-[12px] leading-relaxed text-ink-2">
                  <summary className="cursor-pointer font-medium text-ink">
                    {result.warnings.length} uncertain {result.warnings.length === 1 ? "phrase" : "phrases"}
                  </summary>
                  <ul className="mt-3 space-y-2">
                    {result.warnings.map((warning, index) => (
                      <li key={`${warning.originalText}-${index}`}>
                        <span className="font-medium text-ink">“{warning.originalText}”</span> {warning.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <details className="rounded-[16px] border border-hairline px-4 py-3 text-[12px] text-ink-2">
                <summary className="cursor-pointer font-medium text-ink">Original transcript</summary>
                <p className="mt-3 whitespace-pre-wrap leading-relaxed">{rawTranscript}</p>
              </details>

              {error ? (
                <p className="rounded-[14px] border border-accent-ink/30 bg-accent-soft px-3 py-2 text-[12px] leading-relaxed text-ink-2" aria-live="polite">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="border-t border-hairline bg-paper px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-5 sm:pt-4">
          {view === "choice" ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="quiet" className="min-h-11 w-full sm:w-auto" onClick={() => onKeepTranscript(rawTranscript)}>
                Keep as transcript
              </Button>
              <Button variant="primary" className="min-h-11 w-full sm:w-auto" onClick={() => void format()}>
                Turn into messages
              </Button>
            </div>
          ) : null}
          {view === "error" ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="quiet" className="min-h-11 w-full sm:w-auto" onClick={() => onKeepTranscript(rawTranscript)}>
                Keep as transcript
              </Button>
              <Button variant="primary" className="min-h-11 w-full sm:w-auto" onClick={() => void format()}>
                Try again
              </Button>
            </div>
          ) : null}
          {reviewVisible ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <ActionButton
                variant="quiet"
                className="min-h-11 w-full sm:w-auto"
                runningLabel="Copying…"
                doneLabel="Copied all"
                action={() => navigator.clipboard.writeText(formattedMessagesClipboardText(messages))}
                disabled={!messages.length || view === "sending"}
              >
                <Copy className="h-4 w-4" strokeWidth={1.8} />
                Copy all
              </ActionButton>
              <Button
                variant="quiet"
                className="min-h-11 w-full sm:ml-auto sm:w-auto"
                onClick={() => onKeepTranscript(rawTranscript)}
                disabled={view === "sending" || sendingMessageIds.size > 0}
              >
                Keep transcript
              </Button>
              <Button
                variant="primary"
                className="min-h-11 w-full sm:w-auto"
                onClick={() => void sendMessages()}
                disabled={
                  !messages.some((message) => !sentMessageIds.has(message.id) && message.text.trim()) ||
                  view === "sending" ||
                  sendingMessageIds.size > 0
                }
              >
                {view === "sending" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
                    Sending…
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" strokeWidth={1.8} />
                    Send messages
                  </>
                )}
              </Button>
            </div>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
