import assert from "node:assert/strict";
import test from "node:test";
import { shouldDiscardStagedAttachments } from "../apps/runner/dist/services/staged-attachment-cleanup.js";

test("invalid bodies and digest failures discard files before persistence", () => {
  assert.equal(
    shouldDiscardStagedAttachments({
      handled: false,
      ownership: "unknown",
      persistenceAttempted: false
    }),
    true
  );
});

test("confirmed unowned files are discarded after a rejected enqueue", () => {
  assert.equal(
    shouldDiscardStagedAttachments({
      handled: false,
      ownership: "unowned",
      persistenceAttempted: true
    }),
    true
  );
});

test("durably owned or unreadable ownership preserves accepted attachment bytes", () => {
  for (const ownership of ["owned", "unknown"]) {
    assert.equal(
      shouldDiscardStagedAttachments({
        handled: false,
        ownership,
        persistenceAttempted: true
      }),
      false
    );
  }
});

test("already handled attachments are never discarded again", () => {
  assert.equal(
    shouldDiscardStagedAttachments({
      handled: true,
      ownership: "unowned",
      persistenceAttempted: true
    }),
    false
  );
});
