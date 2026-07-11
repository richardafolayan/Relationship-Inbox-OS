"use client";

import { useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { ThreadMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getWhatsAppPoll } from "@/lib/whatsapp-poll";

export { getWhatsAppPoll };

interface WhatsAppPollProps {
  message: ThreadMessage;
  disabled?: boolean;
  onVote: (messageId: string, selectedOptions: string[]) => Promise<void>;
}

export function WhatsAppPoll({ message, disabled = false, onVote }: WhatsAppPollProps) {
  const poll = getWhatsAppPoll(message);
  const options = useMemo(
    () => (poll?.options ?? []).map((option) => (option.name ?? "").trim()).filter(Boolean),
    [poll]
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "voting" | "voted">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!poll || options.length === 0) return null;

  const toggle = (name: string) => {
    setError(null);
    setStatus("idle");
    setSelected((current) => {
      if (poll.allowMultipleAnswers) {
        return current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
      }
      return current.includes(name) ? [] : [name];
    });
  };

  const submit = async () => {
    if (selected.length === 0 || status === "voting") return;
    setStatus("voting");
    setError(null);
    try {
      await onVote(message.id, selected);
      setStatus("voted");
    } catch (voteError) {
      setStatus("idle");
      setError(voteError instanceof Error ? voteError.message : "Poll vote failed");
    }
  };

  return (
    <div className="flex min-w-[min(72vw,300px)] flex-col gap-2">
      <div className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-3">
        WhatsApp poll
      </div>
      {poll.question ? (
        <div className="text-[14px] font-medium leading-snug text-ink">{poll.question}</div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {options.map((name) => {
          const checked = selected.includes(name);
          return (
            <button
              key={name}
              type="button"
              disabled={disabled || status === "voting"}
              onClick={() => toggle(name)}
              className={cn(
                "flex w-full items-center gap-2 rounded-[8px] border px-3 py-2 text-left text-[13px] transition-colors duration-calm disabled:cursor-not-allowed disabled:opacity-60",
                checked
                  ? "border-ink bg-paper text-ink"
                  : "border-hairline bg-paper/60 text-ink hover:border-hairline-strong"
              )}
            >
              <span
                className={cn(
                  "flex h-[16px] w-[16px] shrink-0 items-center justify-center border border-hairline-strong",
                  poll.allowMultipleAnswers ? "rounded-[4px]" : "rounded-full",
                  checked ? "bg-ink text-paper" : "bg-paper"
                )}
              >
                {checked ? <Check className="h-[11px] w-[11px]" strokeWidth={2} /> : null}
              </span>
              <span>{name}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        disabled={disabled || selected.length === 0 || status === "voting" || status === "voted"}
        onClick={() => void submit()}
        className="inline-flex h-[30px] w-fit items-center gap-1.5 rounded-[6px] bg-ink px-3 text-[12px] font-medium text-paper transition-colors duration-calm hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "voting" ? <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} /> : null}
        {status === "voted" ? <Check className="h-[13px] w-[13px]" strokeWidth={1.8} /> : null}
        {status === "voting" ? "Voting" : status === "voted" ? "Voted" : "Vote"}
      </button>
      {error ? <span className="text-[11px] text-ink-2">{error}</span> : null}
    </div>
  );
}
