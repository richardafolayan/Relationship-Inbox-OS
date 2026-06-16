import test from "node:test";
import assert from "node:assert/strict";
import {
  REACTION_SELECTORS,
  messageRowSelector,
  normalizeReactionEmoji,
  appendOutboundReaction
} from "../apps/runner/dist/platforms/linkedin-message-reactions.js";

// #408 Phase 1: pure helpers behind LinkedIn outbound message reactions.
// The DOM driving itself is exercised live; these lock the targeting,
// input-validation, and rawJson persistence contracts.

test("messageRowSelector targets the row by its data-event-urn", () => {
  const key = "urn:li:msg_message:(urn:li:fsd_profile:ABC123,2-xyz==)";
  const sel = messageRowSelector(key);
  assert.equal(sel, `[data-event-urn="${key}"]`);
  assert.match(sel, /^\[data-event-urn=/);
});

test("messageRowSelector rejects an empty key", () => {
  assert.throws(() => messageRowSelector(""), /platformMessageKey is required/);
});

test("messageRowSelector rejects a key containing a double-quote", () => {
  assert.throws(() => messageRowSelector('urn:li:"injected"'), /double-quote/);
});

test("normalizeReactionEmoji trims and returns the glyph", () => {
  assert.equal(normalizeReactionEmoji("  👍 "), "👍");
});

test("normalizeReactionEmoji rejects empty input", () => {
  assert.throws(() => normalizeReactionEmoji("   "), /emoji is required/);
});

test("normalizeReactionEmoji rejects a string too long to be one glyph", () => {
  assert.throws(() => normalizeReactionEmoji("not an emoji at all"), /too long/);
});

test("appendOutboundReaction adds a reaction to empty rawJson", () => {
  const out = appendOutboundReaction(null, "👍");
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.reactions, [{ emoji: "👍", kind: "emoji", direction: "OUT" }]);
});

test("appendOutboundReaction preserves existing rawJson keys", () => {
  const existing = JSON.stringify({ replyToGuid: "abc", reactions: [] });
  const parsed = JSON.parse(appendOutboundReaction(existing, "❤️"));
  assert.equal(parsed.replyToGuid, "abc");
  assert.equal(parsed.reactions.length, 1);
  assert.equal(parsed.reactions[0].emoji, "❤️");
});

test("appendOutboundReaction is idempotent for the same outbound glyph", () => {
  const once = appendOutboundReaction(null, "👍");
  const twice = appendOutboundReaction(once, "👍");
  assert.equal(JSON.parse(twice).reactions.length, 1);
});

test("appendOutboundReaction keeps a distinct inbound reaction of the same glyph", () => {
  const existing = JSON.stringify({
    reactions: [{ emoji: "👍", kind: "like", direction: "IN" }]
  });
  const parsed = JSON.parse(appendOutboundReaction(existing, "👍"));
  // The contact's inbound 👍 and the operator's outbound 👍 coexist.
  assert.equal(parsed.reactions.length, 2);
  assert.ok(parsed.reactions.some((r) => r.direction === "IN"));
  assert.ok(parsed.reactions.some((r) => r.direction === "OUT"));
});

test("appendOutboundReaction treats malformed rawJson as empty rather than throwing", () => {
  const parsed = JSON.parse(appendOutboundReaction("{not valid json", "🎉"));
  assert.deepEqual(parsed.reactions, [{ emoji: "🎉", kind: "emoji", direction: "OUT" }]);
});

test("REACTION_SELECTORS exposes the captured live selectors", () => {
  assert.equal(REACTION_SELECTORS.messageRow, "[data-event-urn]");
  assert.match(REACTION_SELECTORS.reactionEntryPoint, /msg-reactions__entry-point/);
  assert.match(REACTION_SELECTORS.popularReactionItem, /emoji-popular-list__item/);
  assert.match(REACTION_SELECTORS.optionsTrigger, /options-trigger/);
  assert.match(REACTION_SELECTORS.editMenuItem, /menuitem/);
});
