import assert from "node:assert/strict";
import test from "node:test";

const {
  consumeThreadComposerSession,
  readThreadComposerSession,
  safeSendFailureDisposition,
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
    source: "user",
    text: "Reply for A"
  });
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

  assert.equal(consumeThreadComposerSession("thread-a", first.revision, storage), false);
  assert.deepEqual(readThreadComposerSession("thread-a", storage), newer);
  assert.equal(consumeThreadComposerSession("thread-a", newer.revision, storage), true);
  assert.equal(readThreadComposerSession("thread-a", storage), null);
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
  consumeThreadComposerSession("thread-a", 1, storage);
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
