import type { ThreadMessage } from "./types";

export type WhatsAppPollPayload = {
  question?: string;
  options?: Array<{ name?: string }>;
  allowMultipleAnswers?: boolean;
};

/** One voter's current selection, as returned by the runner's poll-votes
 *  endpoint (R-0100 / #818). Mirrors @inbox-os/core's PollVoteRecord. */
export type PollVoteRecord = {
  voterId: string;
  voterName: string | null;
  isMe: boolean;
  selectedOptions: string[];
  votedAt: string | null;
};

export type PollOptionTally = {
  name: string;
  count: number;
  /** Voter display labels ("You" for the operator, name or JID otherwise). */
  voters: string[];
};

/**
 * Fold raw vote records into a per-option tally in the poll's own option
 * order. A voter with an empty selection (retracted vote) counts nowhere.
 * Votes for options the poll no longer lists are ignored rather than
 * invented as new rows — the poll definition is the source of truth.
 */
export function aggregatePollVotes(
  optionNames: string[],
  votes: PollVoteRecord[]
): PollOptionTally[] {
  const tallies = optionNames.map((name) => ({ name, count: 0, voters: [] as string[] }));
  const byName = new Map(tallies.map((tally) => [tally.name, tally]));
  for (const vote of votes) {
    const label = vote.isMe ? "You" : vote.voterName ?? vote.voterId;
    for (const selected of vote.selectedOptions) {
      const tally = byName.get(selected);
      if (!tally) continue;
      tally.count += 1;
      tally.voters.push(label);
    }
  }
  return tallies;
}

export function getWhatsAppPoll(message: ThreadMessage): WhatsAppPollPayload | null {
  const poll = (message.raw as { whatsapp?: { poll?: WhatsAppPollPayload } } | null | undefined)?.whatsapp?.poll;
  if (poll?.options?.some((option) => (option.name ?? "").trim().length > 0)) return poll;

  if (!(message.attachments ?? []).some((attachment) => attachment.kind === "poll")) return null;
  const lines = message.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const question = first.replace(/^📊\s*Poll(?:\s*\(multi-select\))?:?\s*/u, "").trim();
  const options = lines
    .slice(1)
    .map((line) => ({ name: line.replace(/^•\s*/u, "").trim() }))
    .filter((option) => option.name.length > 0);
  if (options.length === 0) return null;
  return {
    question,
    options,
    allowMultipleAnswers: /\(multi-select\)/i.test(first)
  };
}
