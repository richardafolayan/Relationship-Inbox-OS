// Issue #287 phase 2: many threads in the active inbox are not waiting on
// the operator at all — the conversation already wrapped up on a "thanks!"
// or a "talk soon" and there is no reply owed. These look identical to
// genuinely open threads in the runner's needs-reply heuristic, so they
// crowd Today and the Inbox.
//
// This helper is a conservative client-side classifier: a thread is
// "likely closed" only when (a) the last message came from the other
// party and (b) that message looks like an acknowledgement or farewell
// with no question or ask attached. Ambiguous cases stay open. The intent
// is "set the obvious ones aside"; an AI pass for the ambiguous middle
// will follow in a later phase.

import { normalizePreview } from "./preview";

/**
 * Lower-cased trimmed previews that read as a closing beat — short
 * acknowledgements, brief thanks, farewells, or emoji reactions. Each
 * pattern is anchored so substrings inside a longer sentence don't
 * accidentally close an otherwise open message.
 */
const CLOSED_PATTERNS: RegExp[] = [
  // Bare acknowledgements / thanks (allow trailing punctuation + emoji)
  /^(thanks|thank you|thank you so much|thanks so much|thanks a lot|thx|ty|ta|cheers|cool|nice|great|perfect|amazing|awesome|good stuff|sounds good|noted|got it|gotcha|understood)[!.\s🙏👍❤️✨🔥]*$/i,
  // Brief affirmatives
  /^(ok|okay|kk|k|sure|yes|yeah|yep|yup|alright|right|will do|sweet)[!.\s🙏👍]*$/i,
  // Farewells
  /^(talk soon|speak soon|chat soon|catch up soon|see you|see ya|tty[sl]|night|goodnight|take care|have a (good|great|nice) (one|day|night|week|weekend|evening))[!.\s🙏👍❤️]*$/i,
  // Pure emoji reactions (a small handful of acknowledging glyphs)
  /^[\s]*[👍❤️🙏✨🔥💯🎉🙌👏😂😄😊]+[\s]*$/u,
  // LinkedIn-style "X liked your message" placeholders
  /^liked( your message)?$/i
];

/**
 * Phrases that read as a live ask or question; their presence overrides
 * any closing token in the same message. Keep this list permissive — a
 * false negative (leaving an arguably-closed thread visible) is fine, a
 * false positive (hiding a thread that needs a reply) is not.
 */
const OPEN_TOKENS: RegExp[] = [
  /\?/, // any question mark
  /\b(can|could|would|will|do|did|are|is|when|where|how|what|why|who|which)\s+(you|i|we|they|she|he|it)\b/i,
  /\b(let me know|lmk|pls|please|any chance|any update|any thoughts)\b/i,
  /\b(what(?:'s| is)|how(?:'s| is)|when(?:'s| is)|where(?:'s| is)|who(?:'s| is)|why(?:'s| is))\b/i
];

export interface ClosedCandidate {
  /** "OUT" if the operator was last to speak, else "IN" or null. */
  lastMessageDirection?: "IN" | "OUT" | null;
  /** Raw preview string from the inbox row. */
  preview?: string | null;
}

/**
 * Whether the thread reads as a closed conversation under the heuristic
 * above. Returns false (i.e. "leave it visible") whenever direction or
 * preview signals are missing, so we never hide an unclear case.
 */
export function isLikelyClosed(row: ClosedCandidate): boolean {
  // Only the inbound side can close a conversation from our perspective.
  // When the operator was last to speak, the thread is "waiting on them"
  // and should stay active.
  if (row.lastMessageDirection !== "IN") return false;

  const cleaned = normalizePreview(row.preview ?? "");
  if (!cleaned) return false;
  const text = cleaned.toLowerCase().trim();
  if (!text) return false;

  // An explicit ask or question always wins, even if a closing token is
  // present ("thanks, can you also send me the link?").
  if (OPEN_TOKENS.some((re) => re.test(text))) return false;

  return CLOSED_PATTERNS.some((re) => re.test(text));
}
