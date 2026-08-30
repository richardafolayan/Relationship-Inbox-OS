import assert from "node:assert/strict";
import test from "node:test";

import {
  composerClientSendId,
  composerDispatchFailureIsAmbiguous,
  composerNotFoundRecoveryAfterDispatchFailure,
  composerReplayPreflight,
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
    attachmentNamespace: "tab-a",
    clientSendId: "44c44306-517c-484b-9076-9915fa21163e",
    notFoundRecovery: "blocked",
    requestedAt: "2026-08-30T09:01:00.000Z",
    sessionRevision: 3,
    sessionRevisionId: "ae5926d5-3ec7-48b0-bb35-047d8eb2a431"
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
    shouldHideComposerSessionForAttempt(
      {
        ...composerIntent,
        revision: 3,
        revisionId: "ae5926d5-3ec7-48b0-bb35-047d8eb2a431"
      },
      attempt
    ),
    true
  );
  assert.equal(
    shouldHideComposerSessionForAttempt(
      {
        ...composerIntent,
        revision: 3,
        revisionId: "9b35961d-a8fc-441d-986f-a2f366bcc9e3",
        text: "New reply"
      },
      attempt
    ),
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

test("NOT_FOUND replay restores expired schedules and incomplete attachment sets", () => {
  assert.deepEqual(
    composerReplayPreflight(
      {
        ...attempt.intent,
        kind: "scheduled",
        scheduledFor: "2026-08-30T09:05:00.000Z"
      },
      1,
      Date.parse("2026-08-30T09:05:00.001Z")
    ),
    {
      ok: false,
      message: "This scheduled time has passed. Your message was not queued, so choose a new time."
    }
  );
  assert.equal(composerReplayPreflight(attempt.intent, 0).ok, false);
  assert.deepEqual(composerReplayPreflight(attempt.intent, 1), { ok: true });
});

test("dispatch failures stay unresolved when the response can follow durable insertion", () => {
  assert.equal(composerDispatchFailureIsAmbiguous({ status: 500 }, false), true);
  assert.equal(composerDispatchFailureIsAmbiguous({ status: 200 }, false), true);
  assert.equal(composerDispatchFailureIsAmbiguous({ status: 400 }, false), false);
  assert.equal(composerDispatchFailureIsAmbiguous(new Error("local preflight"), false), false);
  assert.equal(composerDispatchFailureIsAmbiguous(new Error("network"), true), true);
  assert.equal(
    composerNotFoundRecoveryAfterDispatchFailure({ status: 500 }),
    "replay"
  );
  assert.equal(
    composerNotFoundRecoveryAfterDispatchFailure({ status: 200 }),
    "replay"
  );
  assert.equal(composerNotFoundRecoveryAfterDispatchFailure({ status: 400 }), "restore");
  assert.equal(composerNotFoundRecoveryAfterDispatchFailure({ status: 0 }), "replay");
  assert.equal(composerNotFoundRecoveryAfterDispatchFailure(new Error("network")), "replay");
});

test("a composer revision has one durable send id even after finite completion history expires", () => {
  const first = composerClientSendId("ae5926d5-3ec7-48b0-bb35-047d8eb2a431");
  const copiedTab = composerClientSendId("ae5926d5-3ec7-48b0-bb35-047d8eb2a431");
  const laterRevision = composerClientSendId("9b35961d-a8fc-441d-986f-a2f366bcc9e3");

  assert.equal(copiedTab, first);
  assert.notEqual(laterRevision, first);
  assert.match(first, /^[0-9a-f-]{36}$/i);
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
