import test from "node:test";
import assert from "node:assert/strict";

const { parseSynthesizedReactionText, foldSynthesizedReactions } = await import(
  "../apps/dashboard/lib/synthesized-reactions.ts"
);

// Issue #422 / pilot R-0048. iMessage falls back to a plain text
// bubble for arbitrary-emoji reactions when either party is on
// iOS < 18 or an SMS bridge. These tests cover the text-pattern
// parser and the fold-to-parent walker.

test("parses arbitrary-emoji reaction text", () => {
  const out = parseSynthesizedReactionText('Reacted 😭 to "U need to open ur mouth😂😂😂"');
  assert.equal(out?.emoji, "😭");
  assert.equal(out?.quotedParentText, "U need to open ur mouth😂😂😂");
});

test("parses curly-quote reaction text", () => {
  const out = parseSynthesizedReactionText("Reacted 😭 to “U need to open ur mouth😂😂😂”");
  assert.equal(out?.emoji, "😭");
  assert.equal(out?.quotedParentText, "U need to open ur mouth😂😂😂");
});

test("parses pre-iOS-18 verb-only patterns (Loved)", () => {
  const out = parseSynthesizedReactionText('Loved "Ok Yhh I’m down"');
  assert.equal(out?.emoji, "❤");
  assert.equal(out?.quotedParentText, "Ok Yhh I’m down");
});

test("parses pre-iOS-18 'Laughed at' phrase", () => {
  const out = parseSynthesizedReactionText('Laughed at "the joke"');
  assert.equal(out?.emoji, "😂");
});

test("returns null for normal messages", () => {
  assert.equal(parseSynthesizedReactionText("Hey wanna get lunch?"), null);
  assert.equal(parseSynthesizedReactionText(""), null);
  assert.equal(parseSynthesizedReactionText("Reacted with thoughts"), null);
});

test("foldSynthesizedReactions: folds onto exact parent match", () => {
  const messages = [
    { id: "m1", direction: "IN", text: "U need to open ur mouth😂😂😂" },
    { id: "m2", direction: "OUT", text: 'Reacted 😭 to "U need to open ur mouth😂😂😂"' }
  ];
  const { synthesizedByParentId, hiddenMessageIds } = foldSynthesizedReactions(messages);
  assert.equal(hiddenMessageIds.has("m2"), true);
  assert.equal(hiddenMessageIds.has("m1"), false);
  const folded = synthesizedByParentId.get("m1");
  assert.equal(folded?.length, 1);
  assert.equal(folded?.[0]?.emoji, "😭");
  assert.equal(folded?.[0]?.direction, "OUT");
});

test("foldSynthesizedReactions: matches the most recent prior bubble (not earlier match)", () => {
  const messages = [
    { id: "m1", direction: "IN", text: "Same text" },
    { id: "m2", direction: "OUT", text: "Some unrelated reply" },
    { id: "m3", direction: "IN", text: "Same text" },
    { id: "m4", direction: "OUT", text: 'Reacted 👍 to "Same text"' }
  ];
  const { synthesizedByParentId, hiddenMessageIds } = foldSynthesizedReactions(messages);
  assert.equal(hiddenMessageIds.has("m4"), true);
  // Should attach to m3 (the most recent prior match), not m1.
  assert.equal(synthesizedByParentId.get("m3")?.length, 1);
  assert.equal(synthesizedByParentId.get("m1"), undefined);
});

test("foldSynthesizedReactions: leaves message visible when no parent matches", () => {
  const messages = [
    { id: "m1", direction: "IN", text: "Something else entirely" },
    { id: "m2", direction: "OUT", text: 'Reacted 😭 to "Old message I never see"' }
  ];
  const { synthesizedByParentId, hiddenMessageIds } = foldSynthesizedReactions(messages);
  // No parent match — message stays visible so the operator at least
  // sees the bubble, even if it's noisy.
  assert.equal(hiddenMessageIds.has("m2"), false);
  assert.equal(synthesizedByParentId.size, 0);
});

test("foldSynthesizedReactions: handles multiple reactions on the same parent", () => {
  const messages = [
    { id: "m1", direction: "IN", text: "Big news!" },
    { id: "m2", direction: "OUT", text: 'Reacted 🎉 to "Big news!"' },
    { id: "m3", direction: "OUT", text: 'Reacted 😭 to "Big news!"' }
  ];
  const { synthesizedByParentId, hiddenMessageIds } = foldSynthesizedReactions(messages);
  assert.equal(hiddenMessageIds.size, 2);
  const folded = synthesizedByParentId.get("m1");
  assert.equal(folded?.length, 2);
  assert.equal(folded?.[0]?.emoji, "🎉");
  assert.equal(folded?.[1]?.emoji, "😭");
});

test("foldSynthesizedReactions: handles whitespace + smart-quote variants", () => {
  const messages = [
    { id: "m1", direction: "IN", text: "Hey,  let’s  meet  up" },
    { id: "m2", direction: "OUT", text: 'Reacted 👍 to "Hey, let’s meet up"' }
  ];
  const { synthesizedByParentId } = foldSynthesizedReactions(messages);
  assert.equal(synthesizedByParentId.get("m1")?.length, 1);
});

test("foldSynthesizedReactions: chained reaction texts don't attribute to each other", () => {
  const messages = [
    { id: "m1", direction: "IN", text: "Hi" },
    { id: "m2", direction: "OUT", text: 'Reacted 😭 to "Hi"' },
    // This is a synthesised text — the parser would match it if it
    // appears as a parent, but the walker skips hidden bubbles.
    { id: "m3", direction: "OUT", text: 'Reacted 😭 to "Hi"' }
  ];
  const { hiddenMessageIds, synthesizedByParentId } = foldSynthesizedReactions(messages);
  // Both reaction texts collapsed onto m1, neither onto the other.
  assert.equal(hiddenMessageIds.has("m2"), true);
  assert.equal(hiddenMessageIds.has("m3"), true);
  assert.equal(synthesizedByParentId.get("m1")?.length, 2);
});
