import assert from "node:assert/strict";
import test from "node:test";

const {
  attachDraftRevisionToThreadComposerSession,
  compareAndReplaceThreadComposerSession,
  compareAndRestoreThreadComposerSession,
  consumeThreadComposerSession,
  inspectThreadComposerSession,
  mergeThreadComposerAttachmentDescriptors,
  readThreadComposerSession,
  restoreThreadComposerSession,
  rotateThreadComposerSession,
  safeSendFailureDisposition,
  shouldRefreshThreadComposerAttachmentOwnership,
  snapshotThreadComposerSessionAfterAcceptedAction,
  snapshotThreadComposerSession,
  threadComposerMutationIsBlocked,
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
    createdAt: saved.createdAt,
    customScheduleValue: "2026-09-01T09:00",
    replyToMessageId: "message-parent",
    revision: 1,
    revisionId: saved.revisionId,
    source: "user",
    text: "Reply for A"
  });
  assert.equal(Number.isFinite(saved.createdAt), true);
  assert.match(saved.revisionId, /^[0-9a-f-]{36}$/i);
});

test("attachment hydration keeps unresolved originals alongside files added meanwhile", () => {
  const added = { ...attachment, id: "attachment-2", name: "new-file.pdf" };

  assert.deepEqual(
    mergeThreadComposerAttachmentDescriptors([attachment], [added]),
    [attachment, added]
  );
  assert.deepEqual(
    mergeThreadComposerAttachmentDescriptors([attachment], [{ ...attachment, name: "resolved.pdf" }]),
    [{ ...attachment, name: "resolved.pdf" }]
  );
});

test("a crash during attachment hydration recovers edits and both attachment generations", () => {
  const storage = makeStorage();
  const added = { ...attachment, id: "attachment-2", name: "new-file.pdf" };
  const pendingHydrationIntent = {
    attachments: mergeThreadComposerAttachmentDescriptors([attachment], [added]),
    customScheduleValue: "2026-10-01T09:30",
    recoveredScheduledFor: "2026-10-01T08:30:00.000Z",
    replyToMessageId: "new-parent",
    source: "user",
    text: "Edited while the original file was restoring"
  };

  snapshotThreadComposerSession("thread-a", pendingHydrationIntent, storage);
  const recovered = readThreadComposerSession("thread-a", storage);
  assert.ok(recovered);

  assert.deepEqual(recovered, {
    ...pendingHydrationIntent,
    createdAt: recovered.createdAt,
    revision: 1,
    revisionId: recovered.revisionId
  });
});

test("stale cleanup never refreshes ownership for a completed or replaced session", () => {
  const session = {
    attachments: [attachment],
    createdAt: 100,
    customScheduleValue: "",
    replyToMessageId: null,
    revision: 1,
    revisionId: "session-x",
    source: "user",
    text: "Reply"
  };

  assert.equal(
    shouldRefreshThreadComposerAttachmentOwnership(session, "session-x", "active"),
    true
  );
  assert.equal(
    shouldRefreshThreadComposerAttachmentOwnership(session, "session-x", "blocked"),
    true
  );
  assert.equal(
    shouldRefreshThreadComposerAttachmentOwnership(session, "session-x", "sent"),
    false
  );
  assert.equal(
    shouldRefreshThreadComposerAttachmentOwnership(session, "session-y", "active"),
    false
  );
  assert.equal(
    shouldRefreshThreadComposerAttachmentOwnership(session, "session-x", "superseded"),
    false
  );
  assert.equal(
    shouldRefreshThreadComposerAttachmentOwnership(null, "session-x", "active"),
    false
  );
});

test("session inspection distinguishes an absent session from unreadable storage", () => {
  const storage = makeStorage();
  assert.deepEqual(inspectThreadComposerSession("thread-a", storage), {
    readable: true,
    session: null
  });

  const unreadableStorage = {
    getItem() {
      throw new Error("blocked");
    },
    removeItem() {},
    setItem() {}
  };
  assert.deepEqual(inspectThreadComposerSession("thread-a", unreadableStorage), {
    readable: false,
    session: null
  });
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

test("an accepted hidden composer survives empty navigation and pagehide snapshots", () => {
  const storage = makeStorage();
  const intent = {
    attachments: [attachment],
    customScheduleValue: "",
    replyToMessageId: "message-1",
    source: "user",
    text: "Pending reply"
  };
  const accepted = snapshotThreadComposerSession("thread-a", intent, storage);
  const emptyIntent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "empty",
    text: ""
  };

  const retained = snapshotThreadComposerSessionAfterAcceptedAction(
    "thread-a",
    emptyIntent,
    accepted.revisionId,
    storage
  );

  assert.deepEqual(retained, accepted);
  assert.deepEqual(readThreadComposerSession("thread-a", storage), accepted);
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

test("an automatic unchanged snapshot cannot make a legacy session look newer than pruned send evidence", () => {
  const storage = makeStorage();
  const legacy = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    revision: 1,
    revisionId: "legacy-session",
    source: "user",
    text: "Review this before sending"
  };
  storage.data.set(__test.keyFor("thread-a"), JSON.stringify(legacy));

  const unchanged = snapshotThreadComposerSession("thread-a", legacy, storage);

  assert.equal(unchanged.revisionId, legacy.revisionId);
  assert.equal(unchanged.createdAt, undefined);
  assert.deepEqual(readThreadComposerSession("thread-a", storage), unchanged);
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

test("a failed recovery write leaves the complete predecessor session intact", () => {
  const storage = makeStorage();
  const predecessorIntent = {
    attachments: [attachment],
    customScheduleValue: "2026-12-15T09:30",
    replyToMessageId: "parent-message",
    source: "user",
    text: "Keep every part of this reply"
  };
  const predecessor = snapshotThreadComposerSession(
    "thread-a",
    predecessorIntent,
    storage
  );
  const originalSetItem = storage.setItem;
  storage.setItem = () => {
    throw new Error("storage unavailable");
  };

  const recovered = restoreThreadComposerSession(
    "thread-a",
    { ...predecessorIntent, text: "Recovered reply" },
    "successor-session",
    storage,
    { text: predecessorIntent.text, updatedAt: "2026-08-30T09:30:00.000Z" },
    "send-attempt"
  );

  storage.setItem = originalSetItem;
  assert.equal(recovered, null);
  assert.deepEqual(readThreadComposerSession("thread-a", storage), predecessor);
});

test("a held recovery barrier prevents passive persistence from replacing its successor", async () => {
  const storage = makeStorage();
  const predecessor = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [attachment],
      customScheduleValue: "2026-12-15T09:30",
      replyToMessageId: "parent-message",
      source: "user",
      text: "Original failed reply"
    },
    storage
  );
  let finishRelease;
  const releaseHeld = new Promise((resolve) => {
    finishRelease = resolve;
  });
  let recoveryThreadId = "thread-a";
  const recovery = (async () => {
    const successor = compareAndRestoreThreadComposerSession(
      "thread-a",
      predecessor,
      predecessor,
      "recovered-session",
      storage,
      predecessor.draftRevision,
      "send-attempt"
    );
    assert.ok(successor);
    await releaseHeld;
    recoveryThreadId = null;
    return successor;
  })();

  await Promise.resolve();
  if (!threadComposerMutationIsBlocked(recoveryThreadId, "thread-a")) {
    snapshotThreadComposerSession(
      "thread-a",
      {
        attachments: [],
        customScheduleValue: "",
        replyToMessageId: null,
        source: "draft",
        text: "Late server draft"
      },
      storage
    );
  }
  assert.equal(readThreadComposerSession("thread-a", storage)?.revisionId, "recovered-session");

  finishRelease();
  const successor = await recovery;
  assert.deepEqual(readThreadComposerSession("thread-a", storage), successor);
});

test("recovery compare-and-set cannot overwrite a newer composer generation", () => {
  const storage = makeStorage();
  const original = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [attachment],
      customScheduleValue: "",
      replyToMessageId: "message-1",
      source: "user",
      text: "Original pending reply"
    },
    storage
  );
  const newer = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [],
      customScheduleValue: "",
      replyToMessageId: null,
      source: "user",
      text: "Newer reply"
    },
    storage
  );

  const recovered = compareAndRestoreThreadComposerSession(
    "thread-a",
    original,
    original,
    "recovered-session",
    storage,
    original.draftRevision,
    "send-attempt"
  );

  assert.equal(recovered, null);
  assert.deepEqual(readThreadComposerSession("thread-a", storage), newer);
});

test("an exact recovery rollback restores the predecessor byte-for-byte", () => {
  const storage = makeStorage();
  const predecessor = snapshotThreadComposerSession(
    "thread-a",
    {
      attachments: [attachment],
      customScheduleValue: "2026-12-15T09:30",
      replyToMessageId: "parent-message",
      source: "user",
      text: "Original pending reply"
    },
    storage,
    { text: "Original pending reply", updatedAt: "2026-08-30T09:30:00.000Z" }
  );
  const prepared = compareAndRestoreThreadComposerSession(
    "thread-a",
    predecessor,
    predecessor,
    "recovered-session",
    storage,
    predecessor.draftRevision,
    "send-attempt"
  );

  assert.ok(prepared);
  assert.equal(
    compareAndReplaceThreadComposerSession(
      "thread-a",
      prepared,
      predecessor,
      storage
    ),
    true
  );
  assert.deepEqual(readThreadComposerSession("thread-a", storage), predecessor);
});

test("a recovered session keeps its predecessor identity until the user changes intent", () => {
  const storage = makeStorage();
  const intent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "user",
    text: "Recovered reply"
  };
  const restored = restoreThreadComposerSession(
    "thread-a",
    intent,
    "session-y",
    storage,
    null,
    "send-x"
  );

  assert.equal(restored?.recoveryClientSendId, "send-x");
  assert.equal(readThreadComposerSession("thread-a", storage)?.recoveryClientSendId, "send-x");

  const edited = snapshotThreadComposerSession(
    "thread-a",
    { ...intent, text: "A meaningfully edited reply" },
    storage
  );
  assert.notEqual(edited?.revisionId, restored?.revisionId);
  assert.equal(edited?.recoveryClientSendId, undefined);
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
