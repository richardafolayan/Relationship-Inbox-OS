import type { MessageForPrompt } from "../types/runtime";

// The trigger must indicate the SENDER lacks an outcome ("they'll let me
// know", "waiting to hear"), never that they want a reply from the operator.
// A bare imperative "let me know" is one of the most common inbound phrases
// in the product and must not arm this guard.
const UNCERTAINTY_PATTERN = /\b(?:not sure|don['’]?t know|doesn['’]?t know|no news yet|waiting to hear|hear back|waiting to find out|won['’]?t know|unclear|uncertain|(?:they|she|he)(?:['’]ll| will) let (?:me|us) know)\b/iu;
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

// Only a RESOLVED outcome the transcript never stated ("passed", "got the
// job") justifies discarding generated text. A domain noun alone ("event",
// "test") is routinely a fair paraphrase, so it stays; the prompt-side
// AMBIGUITY_DISCIPLINE handles domain inference softly.
export function containsUnsupportedOutcomeClaim(
  text: string,
  messages: readonly MessageForPrompt[]
): boolean {
  if (!hasUnspecifiedAmbiguousOutcome(messages)) return false;
  const transcript = messages.map((message) => message.text).join("\n");
  return OUTCOME_PATTERNS.some(
    (pattern) => pattern.test(text) && !pattern.test(transcript)
  );
}

export function preserveAmbiguousEvidence(
  text: string,
  messages: readonly MessageForPrompt[],
  safeFallback: string
): string {
  return containsUnsupportedOutcomeClaim(text, messages) ? safeFallback : text;
}
