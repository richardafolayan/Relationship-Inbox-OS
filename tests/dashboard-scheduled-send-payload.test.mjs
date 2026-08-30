import assert from "node:assert/strict";
import test from "node:test";
import { buildScheduledSendRequest } from "../apps/dashboard/lib/scheduled-send.ts";

test("text-only scheduled replies preserve their reply parent", () => {
  assert.deepEqual(
    buildScheduledSendRequest({
      attachments: [],
      clientSendId: "send-1",
      replyToMessageId: "parent-1",
      scheduledFor: "2026-09-01T09:00:00.000Z",
      text: "See you tomorrow"
    }),
    {
      kind: "json",
      body: {
        clientSendId: "send-1",
        replyToMessageId: "parent-1",
        scheduledFor: "2026-09-01T09:00:00.000Z",
        text: "See you tomorrow"
      }
    }
  );
});

test("attachment-only scheduled replies use multipart and preserve the parent", async () => {
  const file = new File(["pilot attachment"], "notes.txt", { type: "text/plain" });
  const request = buildScheduledSendRequest({
    attachments: [{ file }],
    clientSendId: "send-2",
    replyToMessageId: "parent-2",
    scheduledFor: "2026-09-01T10:00:00.000Z",
    text: ""
  });

  assert.equal(request.kind, "multipart");
  assert.equal(request.body.get("clientSendId"), "send-2");
  assert.equal(request.body.get("replyToMessageId"), "parent-2");
  assert.equal(request.body.get("scheduledFor"), "2026-09-01T10:00:00.000Z");
  const uploaded = request.body.get("attachments");
  assert.ok(uploaded instanceof File);
  assert.equal(uploaded.name, "notes.txt");
  assert.equal(await uploaded.text(), "pilot attachment");
});
