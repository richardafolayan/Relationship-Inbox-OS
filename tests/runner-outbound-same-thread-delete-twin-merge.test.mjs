import test from "node:test";
import assert from "node:assert/strict";
import { decideSameThreadTwinDeleteMerge } from "../apps/runner/dist/services/scan-queue.js";

// Same-thread outbound dedup: when a canonical (scan-side) row already holds
// the scan key, decideOutboundDedup returns `delete_twin` for the send-side
// row. That send-side row is the ONLY one carrying sentVia=automation +
// replyToMessageId (send.ts sets both; the scan upsert sets neither). Before
// #548's fix was extended here, the call site deleted that twin without merging
// its metadata onto the surviving canonical, so the dashboard bubble silently
// lost its automation badge (sentVia) and reply nesting (replyToMessageId).
//
// decideSameThreadTwinDeleteMerge is the pure rule the call site uses to decide
// what to copy onto the canonical before the delete. These cases pin the
// field mapping (twin.sentVia === "automation", twin.replyToMessageId) so the
// regression can't come back silently.

test("send-side twin's automation tag + reply linkage are copied onto a bare canonical", () => {
  // The exact bug: scan-side canonical has no metadata, the send-side twin
  // being deleted carries both. Both must transfer to the survivor.
  const twin = { sentVia: "automation", replyToMessageId: "msg-parent-123" };
  const survivor = { sentVia: null, replyToMessageId: null };
  const updates = decideSameThreadTwinDeleteMerge(twin, survivor);
  assert.deepEqual(updates, {
    sentVia: "automation",
    replyToMessageId: "msg-parent-123"
  });
});

test("canonical already tagged automation: only the missing reply linkage is copied", () => {
  const twin = { sentVia: "automation", replyToMessageId: "msg-parent-123" };
  const survivor = { sentVia: "automation", replyToMessageId: null };
  const updates = decideSameThreadTwinDeleteMerge(twin, survivor);
  assert.deepEqual(updates, { replyToMessageId: "msg-parent-123" });
});

test("canonical already has reply linkage: never clobber it", () => {
  const twin = { sentVia: "automation", replyToMessageId: "msg-other-parent" };
  const survivor = { sentVia: "automation", replyToMessageId: "msg-existing-parent" };
  const updates = decideSameThreadTwinDeleteMerge(twin, survivor);
  assert.deepEqual(updates, {});
});

test("twin is not automation-tagged and has no reply linkage: nothing to copy", () => {
  const twin = { sentVia: null, replyToMessageId: null };
  const survivor = { sentVia: null, replyToMessageId: null };
  const updates = decideSameThreadTwinDeleteMerge(twin, survivor);
  assert.deepEqual(updates, {});
});

test("only the automation tag transfers when the twin has no reply linkage", () => {
  const twin = { sentVia: "automation", replyToMessageId: null };
  const survivor = { sentVia: null, replyToMessageId: null };
  const updates = decideSameThreadTwinDeleteMerge(twin, survivor);
  assert.deepEqual(updates, { sentVia: "automation" });
});

test("only the reply linkage transfers when the twin is not automation-tagged", () => {
  // A manually-sent reply persisted by send.ts still carries replyToMessageId.
  const twin = { sentVia: null, replyToMessageId: "msg-parent-123" };
  const survivor = { sentVia: null, replyToMessageId: null };
  const updates = decideSameThreadTwinDeleteMerge(twin, survivor);
  assert.deepEqual(updates, { replyToMessageId: "msg-parent-123" });
});
