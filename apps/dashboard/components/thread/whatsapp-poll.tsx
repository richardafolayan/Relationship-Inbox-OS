"use client";

import { useMemo, useState } from "react";
import { BarChart2, Check, Loader2 } from "lucide-react";
import type { ThreadMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  aggregatePollVotes,
  getWhatsAppPoll,
  type PollOptionTally,
  type PollVoteRecord
} from "@/lib/whatsapp-poll";

export { getWhatsAppPoll };

interface WhatsAppPollProps {
  message: ThreadMessage;
  disabled?: boolean;
  onVote: (messageId: string, selectedOptions: string[]) => Promise<void>;
  /**
   * Fetches the live vote records for this poll (R-0100 / #818). Absent
   * (e.g. non-WhatsApp render contexts) the "View votes" affordance is
   * hidden entirely.
   */
  onFetchVotes?: (messageId: string) => Promise<PollVoteRecord[]>;
}

export function WhatsAppPoll({ message, disabled = false, onVote, onFetchVotes }: WhatsAppPollProps) {
  const poll = getWhatsAppPoll(message);
  const options = useMemo(
    () => (poll?.options ?? []).map((option) => (option.name ?? "").trim()).filter(Boolean),
    [poll]
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "voting" | "voted">("idle");
  const [error, setError] = useState<string | null>(null);
  const [votesStatus, setVotesStatus] = useState<"hidden" | "loading" | "shown">("hidden");
  const [tallies, setTallies] = useState<PollOptionTally[] | null>(null);
  const [votesError, setVotesError] = useState<string | null>(null);

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

  const loadVotes = async () => {
    if (!onFetchVotes || votesStatus === "loading") return;
    setVotesStatus("loading");
    setVotesError(null);
    try {
      const votes = await onFetchVotes(message.id);
      setTallies(aggregatePollVotes(options, votes));
      setVotesStatus("shown");
    } catch (fetchError) {
      setVotesStatus(tallies ? "shown" : "hidden");
      setVotesError(
        fetchError instanceof Error ? fetchError.message : "Could not load votes"
      );
    }
  };

  return (
    <div className="flex min-w-[min(72vw,300px)] flex-col gap-2 rounded-[12px] border border-hairline bg-transparent p-3 text-ink">
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
                  ? "border-ink bg-paper-2/60 text-ink"
                  : "border-hairline bg-transparent text-ink hover:border-hairline-strong hover:bg-paper-2/50"
              )}
              aria-pressed={checked}
            >
              <span
                className={cn(
                  "flex h-[16px] w-[16px] shrink-0 items-center justify-center border border-hairline-strong",
                  poll.allowMultipleAnswers ? "rounded-[4px]" : "rounded-full",
                  checked ? "bg-ink text-paper" : "bg-transparent"
                )}
              >
                {checked ? <Check className="h-[11px] w-[11px]" strokeWidth={2} /> : null}
              </span>
              <span>{name}</span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
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
        {onFetchVotes && !disabled ? (
          <button
            type="button"
            disabled={votesStatus === "loading"}
            onClick={() => void loadVotes()}
            className="inline-flex items-center gap-1 text-[11px] text-ink-3 transition-colors duration-calm hover:text-ink disabled:cursor-not-allowed"
          >
            {votesStatus === "loading" ? (
              <Loader2 className="h-[11px] w-[11px] animate-spin" strokeWidth={1.8} />
            ) : (
              <BarChart2 className="h-[11px] w-[11px]" strokeWidth={1.8} />
            )}
            {votesStatus === "shown" ? "Refresh votes" : "View votes"}
          </button>
        ) : null}
      </div>
      {votesStatus === "shown" && tallies ? (
        <div data-testid="poll-vote-tallies" className="flex flex-col gap-1 border-t border-hairline pt-2">
          {tallies.map((tally) => (
            <div key={tally.name} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="min-w-0 truncate text-ink">{tally.name}</span>
              <span className="shrink-0 text-right text-ink-3">
                {tally.count}
                {tally.voters.length > 0 ? ` · ${tally.voters.join(", ")}` : ""}
              </span>
            </div>
          ))}
          {tallies.every((tally) => tally.count === 0) ? (
            <span className="text-[11px] text-ink-3">No votes yet</span>
          ) : null}
        </div>
      ) : null}
      {votesError ? <span className="text-[11px] text-ink-2">{votesError}</span> : null}
      {error ? <span className="text-[11px] text-ink-2">{error}</span> : null}
    </div>
  );
}
