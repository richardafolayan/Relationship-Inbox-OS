import assert from "node:assert/strict";
import test from "node:test";

import {
  composerClientSendId,
  composerDispatchFailureIsAmbiguous,
  composerNotFoundRecoveryAfterDispatchFailure,
  composerNotFoundRecoveryOnResume,
  composerIntentForRecovery,
  composerRecoveryResolution,
  composerReplayPreflight,
  composerSendRecoveryDisposition,
  resolvedComposerScheduleInstant,
  recoveredComposerSessionDisposition,
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

test("a future quick-preset schedule restores its exact visible local time", () => {
  const scheduledFor = "2026-12-15T09:30:00.000Z";
  const recovered = composerIntentForRecovery(
    { ...composerIntent, customScheduleValue: "" },
    "scheduled",
    scheduledFor,
    Date.parse("2026-12-15T09:00:00.000Z")
  );
  const date = new Date(scheduledFor);
  const pad = (value) => String(value).padStart(2, "0");
  const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

  assert.equal(recovered.customScheduleValue, expected);
  assert.equal(recovered.recoveredScheduledFor, scheduledFor);
});

test("a recovered schedule preserves the exact instant across a DST overlap", () => {
  const scheduledFor = "2026-10-25T01:30:00.000Z";
  const recovered = composerIntentForRecovery(
    { ...composerIntent, customScheduleValue: "" },
    "scheduled",
    scheduledFor,
    Date.parse("2026-10-25T00:00:00.000Z")
  );

  assert.equal(
    resolvedComposerScheduleInstant(
      recovered.customScheduleValue,
      recovered.recoveredScheduledFor
    ).toISOString(),
    scheduledFor
  );
});

test("a restored predecessor shares one successor generation and is suppressed after it sends", () => {
  const restored = {
    ...attempt.value,
    resolution: "restored",
    restoredSessionRevisionId: "successor-session"
  };
  assert.deepEqual(
    composerRecoveryResolution(attempt.value, [restored]),
    { kind: "restore", sessionRevisionId: "successor-session" }
  );
  assert.deepEqual(
    composerRecoveryResolution(attempt.value, [
      restored,
      {
        ...attempt.value,
        clientSendId: "successor-send",
        resolution: "sent",
        sessionRevisionId: "successor-session"
      }
    ]),
    { kind: "sent", sessionRevisionId: "successor-session" }
  );
  assert.deepEqual(
    composerRecoveryResolution(attempt.value, [
      restored,
      { ...attempt.value, resolution: "sent" }
    ]),
    { kind: "sent", sessionRevisionId: attempt.value.sessionRevisionId }
  );
});

test("restoration resolution follows every successor before deciding it was sent", () => {
  const restoredY = {
    ...attempt.value,
    resolution: "restored",
    restoredSessionRevisionId: "session-y"
  };
  const restoredZ = {
    ...attempt.value,
    clientSendId: "send-y",
    resolution: "restored",
    restoredSessionRevisionId: "session-z",
    sessionRevisionId: "session-y"
  };
  const sentZ = {
    ...attempt.value,
    clientSendId: "send-z",
    resolution: "sent",
    sessionRevisionId: "session-z"
  };

  assert.deepEqual(
    composerRecoveryResolution(attempt.value, [restoredY, restoredZ, sentZ]),
    { kind: "sent", sessionRevisionId: "session-z" }
  );
});

test("malformed or ambiguous restoration lineage fails closed", () => {
  const restoredY = {
    ...attempt.value,
    resolution: "restored",
    restoredSessionRevisionId: "session-y"
  };
  const conflictingY = {
    ...restoredY,
    restoredSessionRevisionId: "session-other"
  };

  assert.equal(
    composerRecoveryResolution(attempt.value, [restoredY, conflictingY]),
    null
  );
});

test("another tab suppresses the exact restored session after immediate or scheduled acceptance", () => {
  const session = {
    ...composerIntent,
    recoveryClientSendId: attempt.value.clientSendId,
    revision: 4,
    revisionId: "session-y"
  };
  const restored = {
    ...attempt.value,
    resolution: "restored",
    restoredSessionRevisionId: "session-y"
  };

  for (const attemptKind of ["immediate", "scheduled"]) {
    const accepted = {
      ...attempt.value,
      attemptKind,
      clientSendId: `accepted-${attemptKind}`,
      resolution: "sent",
      sessionRevisionId: "session-y"
    };
    assert.equal(
      recoveredComposerSessionDisposition(session, [restored, accepted]),
      "sent"
    );
  }
});

test("an edited successor stays active and expired restoration proof fails closed", () => {
  const recovered = {
    ...composerIntent,
    recoveryClientSendId: attempt.value.clientSendId,
    revision: 4,
    revisionId: "session-y"
  };
  const edited = {
    ...composerIntent,
    text: "Edited successor",
    revision: 5,
    revisionId: "session-z"
  };

  assert.equal(recoveredComposerSessionDisposition(recovered, []), "blocked");
  assert.equal(recoveredComposerSessionDisposition(edited, []), "active");
});

test("a session older than truncated completion evidence fails closed", () => {
  const oldSession = {
    ...composerIntent,
    createdAt: 100,
    revision: 1,
    revisionId: "old-session"
  };
  const newSession = {
    ...oldSession,
    createdAt: 300,
    revisionId: "new-session"
  };

  assert.equal(recoveredComposerSessionDisposition(oldSession, [], 200), "blocked");
  assert.equal(recoveredComposerSessionDisposition(newSession, [], 200), "active");
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

test("a persisted pre-dispatch attempt resumes with the same replay-safe id", () => {
  assert.equal(composerNotFoundRecoveryOnResume("replay"), "replay");
  assert.equal(composerNotFoundRecoveryOnResume("restore"), "restore");
  assert.equal(composerNotFoundRecoveryOnResume("blocked"), "replay");
  assert.equal(composerNotFoundRecoveryOnResume(undefined), "replay");
});

test("a composer revision has one durable send id even after finite completion history expires", () => {
  const first = composerClientSendId("ae5926d5-3ec7-48b0-bb35-047d8eb2a431");
  const copiedTab = composerClientSendId("ae5926d5-3ec7-48b0-bb35-047d8eb2a431");
  const laterRevision = composerClientSendId("9b35961d-a8fc-441d-986f-a2f366bcc9e3");
  const scheduled = composerClientSendId(
    "ae5926d5-3ec7-48b0-bb35-047d8eb2a431",
    "scheduled",
    "2026-08-31T09:00:00.000Z"
  );
  const scheduledLater = composerClientSendId(
    "ae5926d5-3ec7-48b0-bb35-047d8eb2a431",
    "scheduled",
    "2026-08-31T10:00:00.000Z"
  );

  assert.equal(copiedTab, first);
  assert.notEqual(laterRevision, first);
  assert.notEqual(scheduled, first);
  assert.notEqual(scheduledLater, scheduled);
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
