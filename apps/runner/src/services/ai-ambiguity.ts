import type { MessageForPrompt } from "../types/runtime";

const UNCERTAINTY_PATTERN = /\b(?:not sure|don['’]?t know|doesn['’]?t know|waiting to hear|hear back|let (?:me|us|them) know|unclear|uncertain)\b/iu;
const DOMAIN_PATTERNS = [
  /\binterviews?\b/iu,
  /\bexams?\b/iu,
  /\bapplications?\b/iu,
  /\bjobs?\b/iu,
  /\boffers?\b/iu,
  /\bdiagnos(?:is|es|ed)\b/iu,
  /\bauditions?\b/iu,
  /\btests?\b/iu,
  /\bappointments?\b/iu,
  /\bevents?\b/iu,
  /\brelationships?\b/iu,
  /\bproposals?\b/iu
] as const;
const OUTCOME_PATTERNS = [
  /\b(?:got|landed) (?:it|the role|the job|accepted)\b/iu,
  /\b(?:was|were|got) accepted\b/iu,
  /\bpassed\b/iu,
  /\brejected\b/iu,
  /\bfailed\b/iu,
  /\bdidn['’]?t get\b/iu
] as const;

function latestInboundText(messages: readonly MessageForPrompt[]): string {
  return [...messages].reverse().find((message) => message.direction === "IN")?.text ?? "";
}

export function hasUnspecifiedAmbiguousOutcome(
  messages: readonly MessageForPrompt[]
): boolean {
  const latest = latestInboundText(messages);
  return UNCERTAINTY_PATTERN.test(latest) && !DOMAIN_PATTERNS.some((pattern) => pattern.test(latest));
}

export function containsUnsupportedDomainInference(
  text: string,
  messages: readonly MessageForPrompt[]
): boolean {
  if (!hasUnspecifiedAmbiguousOutcome(messages)) return false;
  const transcript = messages.map((message) => message.text).join("\n");
  return [...DOMAIN_PATTERNS, ...OUTCOME_PATTERNS].some(
    (pattern) => pattern.test(text) && !pattern.test(transcript)
  );
}

export function preserveAmbiguousEvidence(
  text: string,
  messages: readonly MessageForPrompt[],
  safeFallback: string
): string {
  return containsUnsupportedDomainInference(text, messages) ? safeFallback : text;
}
