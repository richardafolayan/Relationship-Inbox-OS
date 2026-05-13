import test from "node:test";
import assert from "node:assert/strict";
import { buildMessageUpsertPayload } from "../apps/runner/dist/services/message-upsert-payload.js";

const baseInput = {
  threadId: "t-1",
  platformMessageKey: "k-1",
  direction: "IN",
  safeTimestamp: new Date("2026-04-01T10:00:00.000Z"),
  text: "hello",
  senderName: null,
  attachmentsJson: null,
  rawJson: null
};

test("adapter-reported timestamp is written on update so corrective re-scrapes work", () => {
  const payload = buildMessageUpsertPayload({
    ...baseInput,
    adapterReportedTimestamp: true
  });
  assert.equal(payload.update.timestamp instanceof Date, true);
  assert.equal(payload.update.timestamp.toISOString(), "2026-04-01T10:00:00.000Z");
});

test("missing adapter timestamp omits the field on update so existing rows keep their first-seen time", () => {
  const payload = buildMessageUpsertPayload({
    ...baseInput,
    adapterReportedTimestamp: false
  });
  assert.equal("timestamp" in payload.update, false, "update payload must not carry timestamp");
  // Create still stamps the row — first-seen wins.
  assert.equal(payload.create.timestamp.toISOString(), "2026-04-01T10:00:00.000Z");
});

test("create payload always carries timestamp regardless of adapter-reported flag", () => {
  const withTs = buildMessageUpsertPayload({ ...baseInput, adapterReportedTimestamp: true });
  const withoutTs = buildMessageUpsertPayload({ ...baseInput, adapterReportedTimestamp: false });
  assert.equal(withTs.create.timestamp.toISOString(), "2026-04-01T10:00:00.000Z");
  assert.equal(withoutTs.create.timestamp.toISOString(), "2026-04-01T10:00:00.000Z");
});

test("non-timestamp fields are mirrored verbatim in update + create", () => {
  const payload = buildMessageUpsertPayload({
    ...baseInput,
    adapterReportedTimestamp: true,
    text: "body text",
    senderName: "Ada",
    attachmentsJson: "[]",
    rawJson: '{"x":1}'
  });
  assert.equal(payload.update.text, "body text");
  assert.equal(payload.update.senderName, "Ada");
  assert.equal(payload.update.attachmentsJson, "[]");
  assert.equal(payload.update.rawJson, '{"x":1}');
  assert.equal(payload.create.text, "body text");
  assert.equal(payload.create.senderName, "Ada");
});
