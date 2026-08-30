import assert from "node:assert/strict";
import test from "node:test";

const {
  attachDraftRevisionToThreadComposerSession,
  consumeThreadComposerSession,
  readThreadComposerSession,
  restoreThreadComposerSession,
  rotateThreadComposerSession,
  safeSendFailureDisposition,
  snapshotThreadComposerSessionAfterAcceptedAction,
  snapshotThreadComposerSession,
  __test
} = await import("../apps/dashboard/lib/thread-composer-session.ts");

function makeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  };
}

const attachment = {
  id: "attachment-1",
  kind: "pdf",
  lastModified: 123,
  name: "pilot-notes.pdf",
  size: 42,
  type: "application/pdf"
};

test("composer sessions preserve the complete per-thread send intent", () => {
  const storage = makeStorage();
  const saved = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [attachment],
      customScheduleValue: "2026-09-01T09:00",
      replyToMessageId: "message-parent",
      source: "user",
      text: "Reply for A"
    },
    storage
  );

  assert.deepEqual(readThreadComposerSession("thread-a", storage), saved);
  assert.deepEqual(saved, {
    attachments: [attachment],
    customScheduleValue: "2026-09-01T09:00",
    replyToMessageId: "message-parent",
    revision: 1,
    revisionId: saved.revisionId,
    source: "user",
    text: "Reply for A"
  });
  assert.match(saved.revisionId, /^[0-9a-f-]{36}$/i);
});

test("composer sessions preserve the exact saved draft revision they originated from", () => {
  const storage = makeStorage();
  const draftRevision = {
    text: "Saved draft A",
    updatedAt: "2026-08-30T09:00:00.000Z"
  };
  const intent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "draft",
    text: "Edited reply B"
  };

  const saved = snapshotThreadComposerSession(
    "thread-a",
    intent,
    storage,
    draftRevision
  );
  assert.deepEqual(saved.draftRevision, draftRevision);
  assert.deepEqual(readThreadComposerSession("thread-a", storage)?.draftRevision, draftRevision);

  const editedAgain = snapshotThreadComposerSession(
    "thread-a",
    { ...intent, text: "Edited reply C" },
    storage
  );
  assert.deepEqual(editedAgain.draftRevision, draftRevision);
});

test("a late save attaches its revision only to the exact originating session", () => {
  const storage = makeStorage();
  const intent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "user",
    text: "Save this reply"
  };
  const original = snapshotThreadComposerSession("thread-a", intent, storage);
  const savedRevision = {
    text: intent.text,
    updatedAt: "2026-08-30T09:05:00.000Z"
  };

  assert.deepEqual(
    attachDraftRevisionToThreadComposerSession(
      "thread-a",
      original.revision,
      original.revisionId,
      savedRevision,
      storage
    )?.draftRevision,
    savedRevision
  );
  assert.deepEqual(readThreadComposerSession("thread-a", storage)?.draftRevision, savedRevision);

  const newer = snapshotThreadComposerSession(
    "thread-a",
    { ...intent, text: "A newer reply" },
    storage
  );
  assert.equal(
    attachDraftRevisionToThreadComposerSession(
      "thread-a",
      original.revision,
      original.revisionId,
      { ...savedRevision, updatedAt: "2026-08-30T09:06:00.000Z" },
      storage
    ),
    null
  );
  assert.deepEqual(readThreadComposerSession("thread-a", storage), newer);
});

test("re-entering identical text after acceptance creates a new generation", () => {
  const storage = makeStorage();
  const intent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "user",
    text: "Send this twice on purpose"
  };
  const first = snapshotThreadComposerSession("thread-a", intent, storage);
  const second = snapshotThreadComposerSessionAfterAcceptedAction(
    "thread-a",
    intent,
    first.revisionId,
    storage
  );

  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal(second.revision, first.revision + 1);
  assert.equal(
    consumeThreadComposerSession(
      "thread-a",
      first.revision,
      first.revisionId,
      storage
    ),
    false
  );
  assert.deepEqual(readThreadComposerSession("thread-a", storage), second);
});

test("unchanged snapshots keep their revision while any intent change advances it", () => {
  const storage = makeStorage();
  const intent = {
    attachments: [attachment],
    customScheduleValue: "",
    replyToMessageId: "message-parent",
    source: "user",
    text: "Reply for A"
  };
  assert.equal(snapshotThreadComposerSession("thread-a", intent, storage)?.revision, 1);
  assert.equal(snapshotThreadComposerSession("thread-a", intent, storage)?.revision, 1);
  assert.equal(
    snapshotThreadComposerSession(
      "thread-a",
      { ...intent, text: "A newer reply" },
      storage
    )?.revision,
    2
  );
});

test("a late completion consumes only the exact captured revision", () => {
  const storage = makeStorage();
  const first = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [attachment],
      customScheduleValue: "",
      replyToMessageId: "message-parent",
      source: "user",
      text: "Schedule this"
    },
    storage
  );
  const newer = snapshotThreadComposerSession(
    "thread-a",
    {
      ...first,
      text: "Do not erase this newer text"
    },
    storage
  );

  assert.equal(
    consumeThreadComposerSession("thread-a", first.revision, first.revisionId, storage),
    false
  );
  assert.deepEqual(readThreadComposerSession("thread-a", storage), newer);
  assert.equal(
    consumeThreadComposerSession("thread-a", newer.revision, newer.revisionId, storage),
    true
  );
  assert.equal(readThreadComposerSession("thread-a", storage), null);
});

test("equal numeric revisions from different tabs cannot consume each other", () => {
  const firstTab = makeStorage();
  const secondTab = makeStorage();
  const first = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [],
      customScheduleValue: "",
      replyToMessageId: null,
      source: "user",
      text: "First tab"
    },
    firstTab
  );
  const second = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [],
      customScheduleValue: "",
      replyToMessageId: null,
      source: "user",
      text: "Second tab"
    },
    secondTab
  );

  assert.equal(first.revision, second.revision);
  assert.notEqual(first.revisionId, second.revisionId);
  assert.equal(
    consumeThreadComposerSession("thread-a", first.revision, first.revisionId, secondTab),
    false
  );
  assert.equal(readThreadComposerSession("thread-a", secondTab)?.text, "Second tab");
});

test("thread sessions are isolated and malformed recovery data fails closed", () => {
  const storage = makeStorage();
  snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [],
      customScheduleValue: "",
      replyToMessageId: null,
      source: "user",
      text: "A"
    },
    storage
  );
  snapshotThreadComposerSession(
    "thread-b",
    {
      attachments: [],
      customScheduleValue: "",
      replyToMessageId: null,
      source: "draft",
      text: "B"
    },
    storage
  );
  const threadA = readThreadComposerSession("thread-a", storage);
  consumeThreadComposerSession("thread-a", 1, threadA.revisionId, storage);
  assert.equal(readThreadComposerSession("thread-a", storage), null);
  assert.equal(readThreadComposerSession("thread-b", storage)?.text, "B");

  storage.data.set(__test.keyFor("thread-c"), JSON.stringify({ text: "C", revision: 1 }));
  assert.equal(readThreadComposerSession("thread-c", storage), null);
});

test("an entirely empty intent removes private recovery state", () => {
  const storage = makeStorage();
  snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [],
      customScheduleValue: "",
      replyToMessageId: null,
      source: "user",
      text: "A"
    },
    storage
  );
  assert.equal(
    snapshotThreadComposerSession(
      "thread-a",
      {
        attachments: [],
        customScheduleValue: "",
        replyToMessageId: null,
        source: "empty",
        text: ""
      },
      storage
    ),
    null
  );
  assert.equal(readThreadComposerSession("thread-a", storage), null);
});

test("safe send failure restores only an untouched cleared composer", () => {
  const cleared = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "empty",
    text: ""
  };
  assert.equal(
    safeSendFailureDisposition("thread-a", "thread-a", cleared, cleared),
    "restore_captured"
  );
  assert.equal(
    safeSendFailureDisposition(
      "thread-a",
      "thread-a",
      { ...cleared, source: "user", text: "newer reply" },
      cleared
    ),
    "keep_failed_attempt"
  );
  assert.equal(
    safeSendFailureDisposition("thread-a", "thread-b", cleared, cleared),
    "leave_route_session"
  );
});

test("a definite failed send rotates the recovered intent to a new delivery generation", () => {
  const storage = makeStorage();
  const intent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "user",
    text: "Try this again"
  };
  const failed = snapshotThreadComposerSession("thread-a", intent, storage);
  const recovered = rotateThreadComposerSession("thread-a", intent, storage);

  assert.equal(recovered.text, failed.text);
  assert.equal(recovered.revision, failed.revision + 1);
  assert.notEqual(recovered.revisionId, failed.revisionId);
});

test("separate tabs restore a failed send under the same shared successor generation", () => {
  const firstTab = makeStorage();
  const secondTab = makeStorage();
  const intent = {
    attachments: [attachment],
    customScheduleValue: "2026-12-15T09:30",
    replyToMessageId: "parent-message",
    source: "user",
    text: "Try this once"
  };

  const first = restoreThreadComposerSession(
    "thread-a",
    intent,
    "shared-successor-session",
    firstTab
  );
  const second = restoreThreadComposerSession(
    "thread-a",
    intent,
    "shared-successor-session",
    secondTab
  );

  assert.equal(first.revisionId, "shared-successor-session");
  assert.equal(second.revisionId, "shared-successor-session");
  assert.deepEqual(readThreadComposerSession("thread-a", firstTab), first);
  assert.deepEqual(readThreadComposerSession("thread-a", secondTab), second);
});

test("a definite failed send keeps only the draft revision captured by that attempt", () => {
  const storage = makeStorage();
  const intent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "draft",
    text: "Recovered reply A"
  };
  const capturedDraft = {
    text: "Saved A",
    updatedAt: "2026-08-30T09:00:00.000Z"
  };

  const recovered = rotateThreadComposerSession(
    "thread-a",
    intent,
    storage,
    capturedDraft
  );
  assert.deepEqual(recovered.draftRevision, capturedDraft);
});
