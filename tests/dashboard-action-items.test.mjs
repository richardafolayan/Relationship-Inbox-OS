import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import
// below — see test:all in the root package.json.
const {
  hashActionItem,
  parseChecklistState,
  resolveItemText,
  emptyChecklistState,
  actionItemsStorageKey,
  ACTION_ITEMS_STORAGE_PREFIX,
  newManualItemId
} = await import("../apps/dashboard/lib/action-items.ts");

// These pure helpers back the thread "things to address" checklist. They are
// the testable core extracted out of ActionItemsChecklist.tsx, since the
// dashboard has no component-test framework.

test("hashActionItem: deterministic for the same text", () => {
  assert.equal(hashActionItem("Reply about the meeting"), hashActionItem("Reply about the meeting"));
});

test("hashActionItem: ignores surrounding whitespace", () => {
  assert.equal(hashActionItem("  Reply about the meeting  "), hashActionItem("Reply about the meeting"));
});

test("hashActionItem: distinct text yields distinct keys", () => {
  assert.notEqual(hashActionItem("Reply about the meeting"), hashActionItem("Reply about the invoice"));
});

test("parseChecklistState: empty / null / malformed input yields empty state", () => {
  const empty = emptyChecklistState();
  assert.deepEqual(parseChecklistState(null), empty);
  assert.deepEqual(parseChecklistState(undefined), empty);
  assert.deepEqual(parseChecklistState(""), empty);
  assert.deepEqual(parseChecklistState("{not json"), empty);
  assert.deepEqual(parseChecklistState("[1,2,3]"), empty);
});

test("parseChecklistState: a valid payload round-trips", () => {
  const stored = JSON.stringify({
    checked: { ai_abc: true },
    editedText: { ai_abc: "edited text" },
    manualItems: [{ id: "manual_1", text: "call them back", checked: false }]
  });
  const parsed = parseChecklistState(stored);
  assert.equal(parsed.checked.ai_abc, true);
  assert.equal(parsed.editedText.ai_abc, "edited text");
  assert.equal(parsed.manualItems.length, 1);
  assert.equal(parsed.manualItems[0].text, "call them back");
});

test("parseChecklistState: wrongly-typed fields are dropped, not trusted", () => {
  const parsed = parseChecklistState(
    JSON.stringify({
      checked: { ai_abc: "yes" }, // not booleans
      editedText: { ai_abc: 42 }, // not strings
      manualItems: [{ id: "m1" }, { id: "m2", text: "ok", checked: true }]
    })
  );
  assert.deepEqual(parsed.checked, {});
  assert.deepEqual(parsed.editedText, {});
  // Only the well-formed manual item survives.
  assert.equal(parsed.manualItems.length, 1);
  assert.equal(parsed.manualItems[0].id, "m2");
});

test("resolveItemText: returns the original when there is no edit", () => {
  const state = emptyChecklistState();
  assert.equal(resolveItemText(state, "Original loop text"), "Original loop text");
});

test("resolveItemText: an operator edit wins over the original", () => {
  const original = "Original loop text";
  const state = { ...emptyChecklistState(), editedText: { [hashActionItem(original)]: "My clearer wording" } };
  assert.equal(resolveItemText(state, original), "My clearer wording");
});

test("resolveItemText: a blank edit never hides the original", () => {
  const original = "Original loop text";
  const state = { ...emptyChecklistState(), editedText: { [hashActionItem(original)]: "   " } };
  assert.equal(resolveItemText(state, original), original);
});

test("actionItemsStorageKey: namespaced by thread id", () => {
  assert.equal(actionItemsStorageKey("thread_123"), `${ACTION_ITEMS_STORAGE_PREFIX}thread_123`);
  assert.notEqual(actionItemsStorageKey("thread_a"), actionItemsStorageKey("thread_b"));
});

test("newManualItemId: prefixed and unique across calls", () => {
  const a = newManualItemId();
  const b = newManualItemId();
  assert.ok(a.startsWith("manual_"));
  assert.notEqual(a, b);
});
