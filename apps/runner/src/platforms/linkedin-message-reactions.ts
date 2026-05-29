// LinkedIn message-reaction selectors + pure helpers (issue #408, Phase 1:
// outbound reactions). Selectors were captured live against the real
// LinkedIn messaging DOM on 2026-05-29; see REACTION_SELECTORS notes below.
// Kept side-effect-free so the targeting/availability logic is unit-testable
// without a browser (mirrors imessage-group-name.ts / linkedin-inflight-guard.ts).

/**
 * Live-captured DOM contract for reacting to a LinkedIn message.
 *
 *  - A message row is `li.msg-s-event-listitem` carrying its stable id on
 *    `data-event-urn` (e.g. `urn:li:msg_message:(...)`). The runner already
 *    stores that exact value as `platformMessageKey` (linkedin-adapter.ts
 *    ~1622), so a message is targetable by `[data-event-urn="<key>"]`.
 *  - Hovering the row renders `.msg-s-event-listitem__actions-container`
 *    holding three controls: the reaction entry point
 *    (`button.msg-reactions__entry-point`, aria-label "Open Emoji Keyboard"),
 *    reply (`button[aria-label="Reply to this message"]`), and the overflow
 *    menu (`button.msg-s-event-listitem__options-trigger`, the Edit/Delete
 *    entry reserved for Phase 2).
 *  - Hovering the entry point opens a quick-reaction list whose options are
 *    `div.emoji-popular-list__item[role="menuitem"]`, each carrying both an
 *    `aria-label` ("React with thumbs up") and the emoji glyph as text.
 *    Matching on the glyph text is language-independent, so that is the
 *    primary locator; the full emoji keyboard (search + grid) is the
 *    fallback for glyphs absent from the popular list.
 */
export const REACTION_SELECTORS = {
  messageRow: "li.msg-s-event-listitem",
  actionsContainer: ".msg-s-event-listitem__actions-container",
  reactionEntryPoint: 'button.msg-reactions__entry-point, button[aria-label="Open Emoji Keyboard"]',
  popularReactionItem: '.emoji-popular-list__item[role="menuitem"]',
  optionsTrigger: "button.msg-s-event-listitem__options-trigger"
} as const;

/**
 * Build the CSS selector that targets one message by its stored
 * `platformMessageKey` (= the row's `data-event-urn`). The URN contains
 * parentheses, commas and colons but no double-quote, so a quoted
 * attribute selector is safe; we defensively reject a key that contains a
 * double-quote (which could break out of the attribute and is never present
 * in a real LinkedIn URN).
 */
export function messageRowSelector(platformMessageKey: string): string {
  if (typeof platformMessageKey !== "string" || platformMessageKey.length === 0) {
    throw new Error("platformMessageKey is required to target a message reaction");
  }
  if (platformMessageKey.includes('"')) {
    throw new Error("platformMessageKey contains an unexpected double-quote");
  }
  return `${REACTION_SELECTORS.messageRow}[data-event-urn="${platformMessageKey}"]`;
}

/**
 * Normalise an emoji argument to the exact glyph we will match against a
 * popular-reaction item's text. Trims surrounding whitespace and rejects
 * empty / oversized input (a reaction is a single glyph, optionally with a
 * variation selector or ZWJ sequence — well under 12 code units).
 */
export function normalizeReactionEmoji(emoji: string): string {
  const trimmed = typeof emoji === "string" ? emoji.trim() : "";
  if (!trimmed) {
    throw new Error("emoji is required");
  }
  if ([...trimmed].length > 8) {
    throw new Error("emoji argument is too long to be a single reaction glyph");
  }
  return trimmed;
}

/** A reaction as persisted on Message.rawJson and read by the dashboard. */
export interface PersistedReaction {
  emoji: string;
  kind: string;
  direction: "IN" | "OUT";
}

/**
 * Append an operator-applied (outbound) reaction onto a message's rawJson,
 * returning the new rawJson string. Platform-agnostic: it preserves any
 * existing rawJson keys and the `reactions` array shape the dashboard already
 * renders ({emoji, kind, direction}). Idempotent — re-reacting with the same
 * glyph does not duplicate the entry. Malformed existing rawJson is treated as
 * empty rather than throwing, so a bad row never blocks a reaction.
 */
export function appendOutboundReaction(rawJson: string | null | undefined, emoji: string): string {
  const glyph = normalizeReactionEmoji(emoji);
  let parsed: Record<string, unknown> = {};
  if (rawJson) {
    try {
      const candidate = JSON.parse(rawJson);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  const existing: PersistedReaction[] = Array.isArray(parsed.reactions)
    ? (parsed.reactions as PersistedReaction[])
    : [];
  const already = existing.some((r) => r && r.emoji === glyph && r.direction === "OUT");
  const reactions = already
    ? existing
    : [...existing, { emoji: glyph, kind: "emoji", direction: "OUT" as const }];
  return JSON.stringify({ ...parsed, reactions });
}
