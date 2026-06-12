import test from "node:test";
import assert from "node:assert/strict";

// Pure planner for the iMessage reply-thread backfill. Invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import.
const { buildReplyPointerMap, normalizeOriginatorGuid, planReplyThreadBackfill } =
  await import("../apps/runner/src/scripts/backfill-imessage-reply-threads-plan.ts");

test("normalizeOriginatorGuid strips associated-message prefixes defensively", () => {
  assert.equal(normalizeOriginatorGuid("ABC-123"), "ABC-123");
  assert.equal(normalizeOriginatorGuid("p:0/ABC-123"), "ABC-123");
  assert.equal(normalizeOriginatorGuid("p:12/ABC-123"), "ABC-123");
  assert.equal(normalizeOriginatorGuid("bp:ABC-123"), "ABC-123");
  assert.equal(normalizeOriginatorGuid("  ABC-123  "), "ABC-123");
  assert.equal(normalizeOriginatorGuid(""), null);
  assert.equal(normalizeOriginatorGuid("   "), null);
  assert.equal(normalizeOriginatorGuid(null), null);
  assert.equal(normalizeOriginatorGuid(undefined), null);
});

test("buildReplyPointerMap folds rows and drops self-citing or empty pointers", () => {
  const map = buildReplyPointerMap([
    { guid: "child-1", threadOriginatorGuid: "parent-1" },
    { guid: "child-2", threadOriginatorGuid: "p:0/parent-2" },
    { guid: "loop", threadOriginatorGuid: "loop" },
    { guid: "blank", threadOriginatorGuid: "   " },
    { guid: "", threadOriginatorGuid: "parent-3" }
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get("child-1"), "parent-1");
  assert.equal(map.get("child-2"), "parent-2");
});

test("plan links a reply whose rawJson is null", () => {
  const plan = planReplyThreadBackfill(
    [{ id: "m1", platformMessageKey: "child-1", rawJson: null }],
    new Map([["child-1", "parent-1"]])
  );
  assert.equal(plan.inspected, 1);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].replyToGuid, "parent-1");
  assert.deepEqual(JSON.parse(plan.changes[0].nextRawJson), { replyToGuid: "parent-1" });
});

test("plan merge is additive: every existing rawJson field survives", () => {
  const existing = JSON.stringify({
    reactions: [{ emoji: "❤️", kind: "love", direction: "IN" }],
    senderHandle: "+447700900000"
  });
  const plan = planReplyThreadBackfill(
    [{ id: "m1", platformMessageKey: "child-1", rawJson: existing }],
    new Map([["child-1", "parent-1"]])
  );
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(JSON.parse(plan.changes[0].nextRawJson), {
    reactions: [{ emoji: "❤️", kind: "love", direction: "IN" }],
    senderHandle: "+447700900000",
    replyToGuid: "parent-1"
  });
});

test("plan skips rows already carrying replyToGuid, even a different value", () => {
  const plan = planReplyThreadBackfill(
    [
      { id: "same", platformMessageKey: "child-1", rawJson: JSON.stringify({ replyToGuid: "parent-1" }) },
      { id: "diff", platformMessageKey: "child-2", rawJson: JSON.stringify({ replyToGuid: "other" }) }
    ],
    new Map([
      ["child-1", "parent-1"],
      ["child-2", "parent-2"]
    ])
  );
  assert.equal(plan.alreadyLinked, 2);
  assert.equal(plan.changes.length, 0);
});

test("plan never clobbers malformed or non-object rawJson", () => {
  const plan = planReplyThreadBackfill(
    [
      { id: "broken", platformMessageKey: "child-1", rawJson: "{not json" },
      { id: "array", platformMessageKey: "child-2", rawJson: "[1,2]" },
      { id: "null", platformMessageKey: "child-3", rawJson: "null" }
    ],
    new Map([
      ["child-1", "parent-1"],
      ["child-2", "parent-2"],
      ["child-3", "parent-3"]
    ])
  );
  assert.equal(plan.malformedRawJson, 3);
  assert.equal(plan.changes.length, 0);
});

test("plan ignores rows chat.db does not mark as replies", () => {
  const plan = planReplyThreadBackfill(
    [{ id: "m1", platformMessageKey: "not-a-reply", rawJson: null }],
    new Map([["someone-else", "parent-1"]])
  );
  assert.equal(plan.inspected, 1);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.alreadyLinked, 0);
  assert.equal(plan.malformedRawJson, 0);
});

test("plan treats empty-string rawJson like null", () => {
  const plan = planReplyThreadBackfill(
    [{ id: "m1", platformMessageKey: "child-1", rawJson: "  " }],
    new Map([["child-1", "parent-1"]])
  );
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(JSON.parse(plan.changes[0].nextRawJson), { replyToGuid: "parent-1" });
});
