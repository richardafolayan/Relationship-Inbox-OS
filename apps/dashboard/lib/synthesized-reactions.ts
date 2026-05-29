/**
 * iMessage falls back to a plain text bubble for arbitrary-emoji
 * reactions when either party is on iOS < 18 or an SMS bridge —
 * e.g. "Reacted 😭 to "U need to open ur mouth😂😂😂"". Without
 * special handling these show up as standalone messages in the
 * thread (pilot R-0048 / #422). This helper detects the pattern,
 * matches the quoted text to the parent bubble in the same thread,
 * and lets the renderer collapse the synthesised message into a
 * reaction sticker on the parent.
 *
 * The chat.db `associated_message_guid` isn't reliably set for these
 * (iMessage routes them through the text path for backward compat),
 * so we recover the link from the quoted text. Only collapse when
 * the match is unambiguous — falling back to "leave it visible" is
 * less bad than attaching the reaction to the wrong parent.
 */

/** Mirrors the runner-side `ParsedReaction` shape the renderer expects. */
export interface SynthesizedReaction {
  emoji: string;
  kind: "love" | "like" | "dislike" | "laugh" | "emphasis" | "question";
  direction: "IN" | "OUT";
}

export interface SynthesizedReactionMessage {
  id: string;
  direction: "IN" | "OUT";
  text: string;
}

export interface ParsedSynthesizedReaction {
  emoji: string;
  /** The literal quoted text Apple wrote after "Reacted EMOJI to "..."" */
  quotedParentText: string;
}

const SYNTHESIZED_REACTION_RE =
  /^(?:Reacted|Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)\s+(\S+)?\s*(?:to\s+)?["“”'‘’](.+)["“”'‘’]$/u;

const APPLE_TAPBACK_VERB_TO_EMOJI: Record<string, string> = {
  loved: "❤",
  liked: "👍",
  disliked: "👎",
  "laughed at": "😂",
  emphasized: "‼",
  questioned: "❓"
};

/**
 * Parse a single message's text and return the synthesised-reaction
 * payload if it matches Apple's text-bridge format. Returns null for
 * normal messages so callers can pass anything through.
 */
export function parseSynthesizedReactionText(text: string): ParsedSynthesizedReaction | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = trimmed.match(SYNTHESIZED_REACTION_RE);
  if (!m) return null;
  // The verb-only patterns (e.g. "Loved "Hi"") have no emoji capture
  // and fall back to the kind's canonical Apple emoji.
  const verb = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const explicitEmoji = m[1] && !/^to$/i.test(m[1]) ? m[1] : undefined;
  const fallbackEmoji =
    APPLE_TAPBACK_VERB_TO_EMOJI[verb] ??
    APPLE_TAPBACK_VERB_TO_EMOJI[trimmed.match(/^(\w+\s\w+)/)?.[1]?.toLowerCase() ?? ""];
  const emoji = explicitEmoji ?? fallbackEmoji;
  if (!emoji) return null;
  const quoted = m[2]?.trim() ?? "";
  if (!quoted) return null;
  return { emoji, quotedParentText: quoted };
}

function normaliseQuoteText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Below this length a quote is too short to safely match by prefix, so the
 * truncation fallback requires an exact match instead. Guards against a
 * stray short quote attaching to an unrelated longer bubble.
 */
const MIN_TRUNCATION_PREFIX = 4;

export interface FoldOutput {
  /** Reactions folded onto each parent message (by message id). */
  synthesizedByParentId: Map<string, SynthesizedReaction[]>;
  /** Message ids of synthesised "Reacted X to Y" rows we collapsed. */
  hiddenMessageIds: Set<string>;
}

/**
 * Walk the thread's messages in chronological order, fold every
 * synthesised-reaction text bubble onto the most-recent prior
 * message it quotes, and return:
 *   - parentId → folded reactions array
 *   - messageIds the renderer should hide
 *
 * The match is "first-prior bubble whose text, after quote
 * normalisation, equals (or starts with) the quoted parent text".
 * If no plausible parent is found, the synthesised message is left
 * visible — the operator will see slightly noisier UI instead of a
 * misattributed reaction.
 */
export function foldSynthesizedReactions(
  messagesInChronologicalOrder: SynthesizedReactionMessage[]
): FoldOutput {
  const synthesizedByParentId = new Map<string, SynthesizedReaction[]>();
  const hiddenMessageIds = new Set<string>();

  for (let i = 0; i < messagesInChronologicalOrder.length; i += 1) {
    const candidate = messagesInChronologicalOrder[i]!;
    const parsed = parseSynthesizedReactionText(candidate.text);
    if (!parsed) continue;

    const want = normaliseQuoteText(parsed.quotedParentText);
    let parentId: string | null = null;
    // Pass 1: an exact (normalised) match is unambiguous. Prefer the
    // most-recent prior non-hidden bubble whose text equals the quote.
    // Hidden rows are skipped so a chain of reactions doesn't attribute
    // later ones to earlier ones.
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidateParent = messagesInChronologicalOrder[j]!;
      if (hiddenMessageIds.has(candidateParent.id)) continue;
      const parentText = normaliseQuoteText(candidateParent.text);
      if (!parentText) continue;
      if (parentText === want) {
        parentId = candidateParent.id;
        break;
      }
    }
    // Pass 2: Apple truncates long quotes with a trailing ellipsis. Only
    // when there was no exact match AND the quote is genuinely truncated,
    // strip the ellipsis and accept a prefix match — but solely when it is
    // unique, so a short quote that prefixes several bubbles is never
    // misattributed.
    if (!parentId) {
      const stripped = want.replace(/(?:…|\.\.\.)\s*$/u, "").trim();
      if (stripped !== want && stripped.length >= MIN_TRUNCATION_PREFIX) {
        let uniqueParentId: string | null = null;
        let matchCount = 0;
        for (let j = i - 1; j >= 0; j -= 1) {
          const candidateParent = messagesInChronologicalOrder[j]!;
          if (hiddenMessageIds.has(candidateParent.id)) continue;
          const parentText = normaliseQuoteText(candidateParent.text);
          if (!parentText) continue;
          if (parentText.startsWith(stripped)) {
            if (matchCount === 0) uniqueParentId = candidateParent.id;
            matchCount += 1;
          }
        }
        if (matchCount === 1) parentId = uniqueParentId;
      }
    }
    if (!parentId) continue;

    const existing = synthesizedByParentId.get(parentId) ?? [];
    existing.push({
      emoji: parsed.emoji,
      kind: "love", // ParsedReaction's kind enum doesn't have "custom" — use "love" as a generic stand-in; UI displays the emoji directly
      direction: candidate.direction
    });
    synthesizedByParentId.set(parentId, existing);
    hiddenMessageIds.add(candidate.id);
  }

  return { synthesizedByParentId, hiddenMessageIds };
}
