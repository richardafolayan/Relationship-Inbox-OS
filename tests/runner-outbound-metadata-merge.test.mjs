import test from "node:test";
import assert from "node:assert/strict";
import { decideOutboundMetadataMerge } from "../apps/runner/dist/services/scan-queue.js";

// When the cross-sibling outbound dedup collapses a sibling-thread row onto a
// surviving row in the current thread, the sibling was almost always the
// send-side persistence — it carries sentVia=automation and the
// replyToMessageId linkage that the chat.db scan row lacks. decideOutboundMetadataMerge
// is the pure rule for which of those to copy onto the survivor.
//
// Regression: previously the call site only ran this copy when a *canonical*
// row already existed. When the canonical was absent but a same-thread twin
// existed (the send-side row whose key differs from the scan key), the
// cross-sibling twin was deleted and its automation tag / reply linkage were
// silently dropped — the surviving twin lost "sent via automation". These
// cases pin the rule so both survivors (canonical and same-thread twin) inherit
// the metadata.

test("survivor with no metadata inherits automation tag and reply linkage", () => {
  const updates = decideOutboundMetadataMerge({
    survivorSentVia: null,
    survivorReplyToMessageId: null,
    hasAutomationTwin: true,
    twinReplyToMessageId: "msg-parent-123"
  });
  assert.deepEqual(updates, {
    sentVia: "automation",
    replyToMessageId: "msg-parent-123"
  });
});

test("regression: same-thread-twin survivor (no canonical) still gets the automation tag", () => {
  // The exact dropped-metadata case: canonical absent, a same-thread twin is
  // the survivor, and the deleted cross-sibling carried sentVia=automation.
  const updates = decideOutboundMetadataMerge({
    survivorSentVia: null,
    survivorReplyToMessageId: null,
    hasAutomationTwin: true,
    twinReplyToMessageId: null
  });
  assert.deepEqual(updates, { sentVia: "automation" });
});

test("survivor already tagged automation: no redundant sentVia update", () => {
  const updates = decideOutboundMetadataMerge({
    survivorSentVia: "automation",
    survivorReplyToMessageId: null,
    hasAutomationTwin: true,
    twinReplyToMessageId: "msg-parent-123"
  });
  assert.deepEqual(updates, { replyToMessageId: "msg-parent-123" });
});

test("survivor already has reply linkage: never clobber it", () => {
  const updates = decideOutboundMetadataMerge({
    survivorSentVia: "automation",
    survivorReplyToMessageId: "msg-existing-parent",
    hasAutomationTwin: true,
    twinReplyToMessageId: "msg-other-parent"
  });
  assert.deepEqual(updates, {});
});

test("no automation twin and no reply linkage: nothing to copy", () => {
  const updates = decideOutboundMetadataMerge({
    survivorSentVia: null,
    survivorReplyToMessageId: null,
    hasAutomationTwin: false,
    twinReplyToMessageId: null
  });
  assert.deepEqual(updates, {});
});

test("only reply linkage to copy (no automation twin)", () => {
  const updates = decideOutboundMetadataMerge({
    survivorSentVia: "manual",
    survivorReplyToMessageId: null,
    hasAutomationTwin: false,
    twinReplyToMessageId: "msg-parent-123"
  });
  assert.deepEqual(updates, { replyToMessageId: "msg-parent-123" });
});

test("empty-string reply id is treated as no linkage to copy", () => {
  const updates = decideOutboundMetadataMerge({
    survivorSentVia: null,
    survivorReplyToMessageId: null,
    hasAutomationTwin: false,
    twinReplyToMessageId: ""
  });
  assert.deepEqual(updates, {});
});
