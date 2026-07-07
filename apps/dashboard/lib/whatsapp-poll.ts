import type { ThreadMessage } from "./types";

export type WhatsAppPollPayload = {
  question?: string;
  options?: Array<{ name?: string }>;
  allowMultipleAnswers?: boolean;
};

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
