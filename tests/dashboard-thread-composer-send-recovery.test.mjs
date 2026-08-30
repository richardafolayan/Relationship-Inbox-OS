import assert from "node:assert/strict";
import test from "node:test";

import {
  composerSendRecoveryDisposition,
  missingThreadComposerAttachments,
  normalizeThreadComposerSendAttempt,
  shouldHideComposerSessionForAttempt,
  threadComposerSendScope
} from "../apps/dashboard/lib/thread-composer-send-recovery.ts";

const attachment = {
  id: "attachment-1",
  kind: "pdf",
  lastModified: 123,
  name: "pilot-notes.pdf",
  size: 42,
  type: "application/pdf"
};

const composerIntent = {
  attachments: [attachment],
  customScheduleValue: "2026-09-01T09:00",
  replyToMessageId: "message-parent",
  source: "user",
  text: "Reply for A"
};

const attempt = {
  intent: {
    composerIntent,
    draftRevision: {
      text: "Saved draft",
      updatedAt: "2026-08-30T09:00:00.000Z"
    },
    kind: "immediate",
    scheduledFor: null,
    threadId: "thread-a"
  },
  value: {
    clientSendId: "44c44306-517c-484b-9076-9915fa21163e",
    requestedAt: "2026-08-30T09:01:00.000Z",
    sessionRevision: 3
  }
};

test("composer send attempts preserve one identity and the complete intent", () => {
  assert.equal(threadComposerSendScope("thread/a"), "composer-send:thread/a");
  assert.deepEqual(normalizeThreadComposerSendAttempt(attempt), attempt);
});

test("malformed or cross-thread attempt state fails closed", () => {
  assert.equal(normalizeThreadComposerSendAttempt({ ...attempt, value: {} }), null);
  assert.equal(
    normalizeThreadComposerSendAttempt({
      ...attempt,
      intent: { ...attempt.intent, kind: "unknown" }
    }),
    null
  );
});

test("only the exact captured composer revision is hidden while delivery is unresolved", () => {
  assert.equal(
    shouldHideComposerSessionForAttempt({ ...composerIntent, revision: 3 }, attempt),
    true
  );
  assert.equal(
    shouldHideComposerSessionForAttempt({ ...composerIntent, revision: 4, text: "New reply" }, attempt),
    false
  );
});

test("failed recovery keeps descriptors for attachment files that could not be restored", () => {
  assert.deepEqual(
    missingThreadComposerAttachments(
      {
        ...composerIntent,
        attachments: [attachment, { ...attachment, id: "attachment-2", name: "photo.jpg" }]
      },
      ["attachment-1"]
    ),
    [{ ...attachment, id: "attachment-2", name: "photo.jpg" }]
  );
});

test("delivery recovery retains ambiguity, replays missing status with the same id, and cleans only sent", () => {
  assert.equal(composerSendRecoveryDisposition({ status: "PENDING" }), "retain");
  assert.equal(composerSendRecoveryDisposition({ status: "SCHEDULED" }), "scheduled");
  assert.equal(composerSendRecoveryDisposition({ status: "NOT_FOUND" }), "replay_same_id");
  assert.equal(composerSendRecoveryDisposition({ status: "SENT" }), "cleanup");
  assert.equal(
    composerSendRecoveryDisposition({
      status: "FAILED",
      deliveryUncertain: true,
      errorKind: "DELIVERY_UNCERTAIN"
    }),
    "retain_uncertain"
  );
  assert.equal(composerSendRecoveryDisposition({ status: "FAILED" }), "restore");
  assert.equal(composerSendRecoveryDisposition({ status: "CANCELLED" }), "restore");
});
