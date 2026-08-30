import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);

test("thread navigation snapshots the previous full intent and restores only the new thread", () => {
  const start = source.indexOf("useLayoutEffect(() => {");
  const end = source.indexOf("}, [composerAttachmentStore, threadId]);", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const lifecycle = source.slice(start, end);
  assert.match(
    lifecycle,
    /snapshotThreadComposerSession\(previousThreadId, composerIntentRef\.current\)/
  );
  assert.match(lifecycle, /readThreadComposerSession\(threadId\)/);
  assert.match(lifecycle, /setComposer\(restoredIntent\.text\)/);
  assert.match(lifecycle, /setFocusedThreadParentId\(restoredIntent\.replyToMessageId\)/);
  assert.match(lifecycle, /setCustomScheduleValue\(restoredIntent\.customScheduleValue\)/);
  assert.match(lifecycle, /composerAttachmentStore[\s\S]*?\.read\(threadId, restoredIntent\.attachments\)/);
});

test("a scheduled reply carries files and reply context and clears only its captured revision", () => {
  const start = source.indexOf("const scheduleSend = useCallback(");
  const end = source.indexOf("const cancelScheduledSend", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const schedule = source.slice(start, end);
  assert.match(schedule, /snapshotThreadComposerSession\(startThreadId, capturedIntent\)/);
  assert.match(schedule, /buildScheduledSendRequest\(\{/);
  assert.match(schedule, /attachments: composerAttachments/);
  assert.match(schedule, /replyToMessageId: capturedIntent\.replyToMessageId \?\? undefined/);
  assert.match(
    schedule,
    /consumeThreadComposerSession\(startThreadId, capturedSession\.revision\)/
  );
  assert.match(schedule, /sameThreadComposerIntent\(composerIntentRef\.current, capturedIntent\)/);
});

test("an immediate send preserves its full intent until the exact attempt is resolved", () => {
  const start = source.indexOf("const onSend = useCallback(");
  const end = source.indexOf("const addFiles = useCallback", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const send = source.slice(start, end);
  assert.match(send, /composerIntent: capturedIntent/);
  assert.match(send, /replyToMessageId = capturedIntent\.replyToMessageId \?\? undefined/);
  assert.match(send, /consumeThreadComposerSession\(startThreadId, capturedSession\.revision\)/);
  assert.match(send, /sameThreadComposerIntent\(composerIntentRef\.current, clearedIntent\)/);
  assert.match(send, /routeThreadIdRef\.current === startThreadId/);
  assert.match(
    send,
    /assertThreadComposerAttachmentsRecoverable\([\s\S]*?startThreadId,[\s\S]*?capturedIntent\.attachments/
  );
  assert.match(send, /safeSendFailureDisposition\(/);
  assert.match(send, /snapshotThreadComposerSession\(ownerThreadId, composerIntentRef\.current\)/);
});

test("late thread fetches cannot inject another conversation's draft", () => {
  assert.match(
    source,
    /if \(!shouldApplyThreadScopedResult\(fresh\.id, routeThreadIdRef\.current\)\) return;/
  );
});

test("navigating away cannot clear the reply parent before recovery captures it", () => {
  assert.match(
    source,
    /const navigation = target\.closest\('a\[href\], \[data-preserve-composer-intent="true"\]'\)/
  );
  assert.match(source, /if \(focusedBubble \|\| composer \|\| pill \|\| focusSwap \|\| navigation\) return/);
  assert.match(source, /data-preserve-composer-intent="true"[\s\S]*?aria-label="Back to today"/);
});

test("a still-pending send retains attachment bytes for a later definite failure", () => {
  const start = source.indexOf('if (outcome.kind === "waiting")');
  const end = source.indexOf('if (outcome.kind === "not_sent")', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const waiting = source.slice(start, end);
  assert.doesNotMatch(waiting, /composerAttachmentStore[\s\S]*?\.remove/);
  assert.doesNotMatch(waiting, /attachments:\s*\[\]/);
});

test("partial attachment recovery stays visible and blocks an incomplete send", () => {
  assert.match(
    source,
    /const missingAttachments = restoredIntent\.attachments\.filter/
  );
  assert.match(source, /setMissingComposerAttachments\(missingAttachments\)/);
  assert.match(source, /missingComposerAttachments\.map/);
  assert.match(source, /could not be restored[\s\S]*?Add it again/);
});
