import test from "node:test";
import assert from "node:assert/strict";
import { IMessageAdapter } from "../apps/runner/dist/platforms/imessage-adapter.js";

// Regression for PH10 / issue #245-style timestamp drift on iMessage.
//
// chat.db rows whose `date` column is NULL / 0 / non-finite map to
// `appleTimeToIso(...) === undefined` in imessage-db. The adapter must
// pass that `undefined` straight through on NormalizedMessage.timestamp
// so scan-queue's `adapterReportedTimestamp: Boolean(message.timestamp)`
// is `false` and `buildMessageUpsertPayload` omits the timestamp from the
// UPDATE branch — preserving the row's first-seen time on every re-scan.
//
// The old code coalesced the missing timestamp to `new Date().toISOString()`,
// which is always truthy → `adapterReportedTimestamp: true` → the guid-keyed
// row gets its timestamp re-stamped to "now" on every scan (drift).

function makeRow(overrides) {
  return {
    guid: "msg-guid-1",
    rowId: 1,
    text: "hello there",
    direction: "IN",
    timestamp: undefined,
    senderHandle: undefined,
    hasAttachments: false,
    attachments: [],
    reactions: [],
    replyToGuid: undefined,
    ...overrides
  };
}

function makeAdapter(rows) {
  // Constructor only loads the (null) contact resolver; it does not touch
  // chat.db. getDb() is lazy and returns this.db when already set, so we
  // inject a fake that supplies exactly the one method fetchThreadMessages
  // calls. dbPath is never read because getDb() short-circuits.
  const adapter = new IMessageAdapter({ dbPath: "/nonexistent/chat.db" });
  adapter.db = {
    fetchMessages() {
      return rows;
    }
  };
  return adapter;
}

test("fetchThreadMessages leaves timestamp undefined when chat.db has no per-message date", async () => {
  const adapter = makeAdapter([makeRow({ timestamp: undefined })]);
  const messages = await adapter.fetchThreadMessages({ platformThreadId: "chat-1" }, 50);

  assert.equal(messages.length, 1);
  // The fix: a dateless row must NOT be re-stamped to a synthetic "now".
  // Before the fix this was a fresh ISO string and this assertion failed.
  assert.equal(
    messages[0].timestamp,
    undefined,
    "dateless iMessage rows must report no timestamp so re-scans don't drift them"
  );
});

test("fetchThreadMessages preserves a real chat.db timestamp unchanged", async () => {
  const realIso = "2026-01-15T09:30:00.000Z";
  const adapter = makeAdapter([makeRow({ timestamp: realIso })]);
  const messages = await adapter.fetchThreadMessages({ platformThreadId: "chat-1" }, 50);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].timestamp, realIso);
});
