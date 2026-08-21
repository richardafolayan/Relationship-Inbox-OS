import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildScheduledSendRequest } from "../apps/dashboard/lib/scheduled-send.ts";

test("text-only scheduled replies preserve their parent message", () => {
  const request = buildScheduledSendRequest({
    attachments: [],
    clientSendId: "send-1",
    replyToMessageId: "parent-1",
    scheduledFor: "2026-08-22T09:00:00.000Z",
    text: "See you tomorrow"
  });

  assert.deepEqual(request, {
    kind: "json",
    body: {
      text: "See you tomorrow",
      clientSendId: "send-1",
      scheduledFor: "2026-08-22T09:00:00.000Z",
      replyToMessageId: "parent-1"
    }
  });
});

test("attachment-only scheduled replies use multipart and preserve the parent", async () => {
  const file = new File(["pilot attachment"], "notes.txt", { type: "text/plain" });
  const request = buildScheduledSendRequest({
    attachments: [{ file }],
    clientSendId: "send-2",
    replyToMessageId: "parent-2",
    scheduledFor: "2026-08-22T10:00:00.000Z",
    text: ""
  });

  assert.equal(request.kind, "multipart");
  assert.equal(request.body.get("text"), "");
  assert.equal(request.body.get("clientSendId"), "send-2");
  assert.equal(request.body.get("scheduledFor"), "2026-08-22T10:00:00.000Z");
  assert.equal(request.body.get("replyToMessageId"), "parent-2");
  const uploaded = request.body.get("attachments");
  assert.ok(uploaded instanceof File);
  assert.equal(uploaded.name, "notes.txt");
  assert.equal(await uploaded.text(), "pilot attachment");
});

test("thread scheduling accepts attachment-only content and clears it only after success", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );
  const schedule = source.slice(
    source.indexOf("const scheduleSend = useCallback"),
    source.indexOf("const cancelScheduledSend", source.indexOf("const scheduleSend = useCallback"))
  );

  assert.match(schedule, /!composer\.trim\(\) && composerAttachments\.length === 0/);
  assert.match(schedule, /buildScheduledSendRequest\(\{/);
  assert.match(schedule, /replyToMessageId/);
  assert.match(schedule, /postFormForActiveThread/);
  assert.match(schedule, /setComposerAttachments\(\[\]\)/);
});
