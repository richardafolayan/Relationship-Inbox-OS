import test from "node:test";
import assert from "node:assert/strict";
import { resolveRemappedReplyToMessageId } from "../apps/runner/dist/scripts/repair-linkedin-threads.js";

// Bug Q19 (data-loss): the LinkedIn thread-merge repair re-points a duplicate
// thread's messages onto the keeper, then cascade-deletes the duplicate. The
// upsert that re-creates each message gives it a brand-new cuid, so a stored
// `replyToMessageId` (which references a parent Message by cuid) is stale the
// moment the duplicate thread is deleted. Before the fix the apply loop copied
// neither `sentVia` (losing "Sent via automation" provenance) nor a remapped
// `replyToMessageId` — it simply dropped both.
//
// resolveRemappedReplyToMessageId is the pure rule the apply loop's second
// pass now consults to decide what reply linkage a merged-in message keeps.
// These cases pin it so the regression cannot silently return: the link must
// follow the parent to its new cuid, survive when the parent still lives, and
// be dropped (never copied verbatim) when the parent is gone.

test("no original reply link resolves to null", () => {
  const resolved = resolveRemappedReplyToMessageId({
    originalReplyToMessageId: null,
    oldToNewMessageId: new Map(),
    parentSurvivesOutsideMerge: false
  });
  assert.equal(resolved, null);
});

test("parent merged in this batch is remapped to its new keeper cuid", () => {
  const resolved = resolveRemappedReplyToMessageId({
    originalReplyToMessageId: "old-parent",
    oldToNewMessageId: new Map([["old-parent", "new-parent-cuid"]]),
    parentSurvivesOutsideMerge: false
  });
  assert.equal(resolved, "new-parent-cuid");
});

test("the batch remap wins even if the parent would also resolve as surviving", () => {
  // Defensive: a parent in the merge batch must always use its NEW id, never
  // the stale original, regardless of the survives flag.
  const resolved = resolveRemappedReplyToMessageId({
    originalReplyToMessageId: "old-parent",
    oldToNewMessageId: new Map([["old-parent", "new-parent-cuid"]]),
    parentSurvivesOutsideMerge: true
  });
  assert.equal(resolved, "new-parent-cuid");
});

test("parent outside the batch that still resolves to a live message keeps its id", () => {
  // e.g. a cross-thread reply whose parent already lives on the keeper.
  const resolved = resolveRemappedReplyToMessageId({
    originalReplyToMessageId: "keeper-parent",
    oldToNewMessageId: new Map([["some-other-old", "some-other-new"]]),
    parentSurvivesOutsideMerge: true
  });
  assert.equal(resolved, "keeper-parent");
});

test("parent that is gone is dropped, never copied verbatim (no dangling reference)", () => {
  const resolved = resolveRemappedReplyToMessageId({
    originalReplyToMessageId: "vanished-parent",
    oldToNewMessageId: new Map([["some-other-old", "some-other-new"]]),
    parentSurvivesOutsideMerge: false
  });
  assert.equal(resolved, null);
  assert.notEqual(resolved, "vanished-parent");
});
