import test from "node:test";
import assert from "node:assert/strict";

const { foldSynthesizedReactions } = await import(
  "../apps/dashboard/lib/synthesized-reactions.ts"
);

// Q16 regression. iMessage stores arbitrary-emoji reactions as a
// "Reacted X to 'Y'" text bubble (pilot R-0048 / #422). foldSynthesized-
// Reactions used a single backward pass that stopped on the first
// `parentText === want || parentText.startsWith(want)`, so an unrelated
// *later* bubble that merely shared a prefix with the reacted text could
// swallow the reaction before the exact bubble was reached. The fix is a
// two-pass match: nearest exact equality first, then nearest strictly-
// longer prefix.

test("Q16: exact match beats a more-recent shared-prefix bubble", () => {
  const messages = [
    { id: "exact", direction: "IN", text: "Lunch?" },
    { id: "prefix", direction: "IN", text: "Lunch? Or dinner, whatever works for you" },
    { id: "rx", direction: "OUT", text: 'Reacted 👍 to "Lunch?"' }
  ];
  const { synthesizedByParentId, hiddenMessageIds } = foldSynthesizedReactions(messages);
  assert.equal(hiddenMessageIds.has("rx"), true);
  // Must fold onto the bubble that says exactly "Lunch?", not the later
  // "Lunch? Or dinner…" bubble that only shares the prefix.
  assert.equal(synthesizedByParentId.get("exact")?.length, 1);
  assert.equal(synthesizedByParentId.get("prefix"), undefined);
});

test("Q16: still falls back to a strictly-longer prefix when no exact match", () => {
  const messages = [
    { id: "full", direction: "IN", text: "Are we still on for the thing tomorrow afternoon" },
    { id: "rx", direction: "OUT", text: 'Reacted 😂 to "Are we still on for the thing"' }
  ];
  const { synthesizedByParentId, hiddenMessageIds } = foldSynthesizedReactions(messages);
  // Apple ellipsis-truncated the quote — the real parent is a strictly
  // longer prefix, so the fallback pass should still collapse it.
  assert.equal(hiddenMessageIds.has("rx"), true);
  assert.equal(synthesizedByParentId.get("full")?.length, 1);
});

test("Q16: prefix pass picks the most-recent strictly-longer prefix", () => {
  const messages = [
    { id: "older", direction: "IN", text: "Hello there friend" },
    { id: "newer", direction: "IN", text: "Hello there pal" },
    { id: "rx", direction: "OUT", text: 'Reacted ❤ to "Hello there"' }
  ];
  const { synthesizedByParentId } = foldSynthesizedReactions(messages);
  // No exact "Hello there" bubble — fall back to the nearest strictly-
  // longer prefix, which is the most recent ("newer").
  assert.equal(synthesizedByParentId.get("newer")?.length, 1);
  assert.equal(synthesizedByParentId.get("older"), undefined);
});
