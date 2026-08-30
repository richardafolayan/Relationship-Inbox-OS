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
  const end = source.indexOf("}, [composerAttachmentStore, externalActionAttempts, threadId]);", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const lifecycle = source.slice(start, end);
  assert.match(
    lifecycle,
    /snapshotThreadComposerSession\(previousThreadId, currentIntent\)/
  );
  assert.match(lifecycle, /readThreadComposerSession\(threadId\)/);
  assert.match(lifecycle, /setComposer\(restoredIntent\.text\)/);
  assert.match(lifecycle, /setFocusedThreadParentId\(restoredIntent\.replyToMessageId\)/);
  assert.match(lifecycle, /setCustomScheduleValue\(restoredIntent\.customScheduleValue\)/);
  assert.match(lifecycle, /composerAttachmentStore[\s\S]*?\.read\(threadId, restoredIntent\.attachments\)/);
});

test("a scheduled reply carries complete intent under the shared durable composer attempt", () => {
  const start = source.indexOf("const scheduleSend = useCallback(");
  const end = source.indexOf("const cancelScheduledSend", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const schedule = source.slice(start, end);
  assert.match(schedule, /snapshotThreadComposerSession\(startThreadId, capturedIntent\)/);
  assert.match(schedule, /kind: "scheduled"/);
  assert.match(schedule, /threadComposerSendScope\(startThreadId\)/);
  assert.match(
    schedule,
    /dispatchComposerSendAttempt\(\s*attemptIntent,\s*attemptValue,\s*composerAttachments\s*\)/
  );
  assert.match(schedule, /if \(response\.draftConsumed\) consumePendingDraftRevision\(pending\)/);
  assert.match(schedule, /sameThreadComposerIntent\(composerIntentRef\.current, capturedIntent\)/);
});

test("an immediate send preserves its full intent until the exact attempt is resolved", () => {
  const start = source.indexOf("const onSend = useCallback(");
  const end = source.indexOf("const addFiles = useCallback", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const send = source.slice(start, end);
  assert.match(send, /composerIntent: capturedIntent/);
  assert.match(send, /threadComposerSendScope\(startThreadId\)/);
  assert.match(
    send,
    /dispatchComposerSendAttempt\(\s*attemptIntent,\s*attemptValue,\s*attachmentsToSend\s*\)/
  );
  assert.match(send, /if \(response\.draftConsumed\) consumePendingDraftRevision\(pending\)/);
  assert.doesNotMatch(send, /consumeThreadComposerSession\(startThreadId, capturedSession\.revision\)/);
  assert.match(send, /sameThreadComposerIntent\(composerIntentRef\.current, clearedIntent\)/);
  assert.match(send, /routeThreadIdRef\.current === startThreadId/);
  assert.match(
    send,
    /assertThreadComposerAttachmentsRecoverable\([\s\S]*?startThreadId,[\s\S]*?capturedIntent\.attachments/
  );
  assert.doesNotMatch(send, /completeScopedValue/);
  assert.match(send, /checkPendingDelivery\(clientSendId\)/);
  assert.match(send, /snapshotThreadComposerSession\(ownerThreadId, composerIntentRef\.current\)/);
});

test("a failed captured reply stays separate when the operator has typed newer text", () => {
  const start = source.indexOf("const restorePendingComposerSend = useCallback(");
  const end = source.indexOf("const clearCapturedComposerAfterAcceptedAction", start);
  const restore = source.slice(start, end);
  assert.match(restore, /safeSendFailureDisposition\(/);
  assert.match(restore, /recoveryDisposition !== "restore_captured"/);
  assert.match(restore, /Your original reply is still kept above/);
  assert.match(restore, /item\.clientSendId === pending\.clientSendId/);
  assert.match(
    restore,
    /rotateThreadComposerSession\(\s*pending\.threadId,\s*recoveryIntent\s*\)/
  );
});

test("completed composer generations suppress copied-tab duplicate sends", () => {
  assert.match(source, /composerClientSendId\(capturedSession\.revisionId\)/);
  assert.match(source, /sessionRevisionId: capturedSession\.revisionId,[\s\S]*?kind: "immediate"/);
  assert.match(source, /sessionRevisionId: capturedSession\.revisionId,[\s\S]*?kind: "scheduled"/);
  assert.match(source, /readCompletedScopedValues<ThreadComposerSendAttemptValue>/);
  assert.match(source, /value\.sessionRevisionId === storedSession\?\.revisionId/);
  assert.match(source, /value\.sessionRevisionId === capturedSession\.revisionId/);
  assert.match(source, /notFoundRecovery: "blocked"/);
  assert.match(source, /pending\.notFoundRecovery !== "replay"/);
});

test("draft mutations are ordered with sends, schedules, and both delete controls", () => {
  const sendStart = source.indexOf("const onSend = useCallback(");
  const scheduleStart = source.indexOf("const scheduleSend = useCallback(");
  const deleteStart = source.indexOf("const deleteCurrentDraft =");
  const actionStart = source.indexOf("const saveDraftAction", deleteStart);
  assert.match(source.slice(sendStart, scheduleStart), /await draftMutations\.waitForRevision/);
  assert.match(source.slice(scheduleStart, deleteStart), /await draftMutations\.waitForRevision/);
  assert.match(source.slice(deleteStart, actionStart), /draftMutations\.enqueueDelete/);
  assert.equal((source.match(/deleteCurrentDraft\(\)/g) ?? []).length, 2);
  assert.match(source, /draftRevisionForComposerSend\(/);
  assert.match(source, /draftMutations\.consumeRevision/);
  assert.match(source, /draftMutations\.reconcileFetchedRevision/);
});

test("delivery events and status cleanup never infer saved-draft consumption", () => {
  const eventStart = source.indexOf("// SSE reconciliation for sends.");
  const completionStart = source.indexOf("const completePendingComposerSend", eventStart);
  const restoreStart = source.indexOf("const restorePendingComposerSend", completionStart);
  assert.doesNotMatch(
    source.slice(eventStart, completionStart),
    /consumePendingDraftRevision/
  );
  assert.doesNotMatch(
    source.slice(completionStart, restoreStart),
    /consumePendingDraftRevision/
  );
});

test("late send allocation and draft deletion clear only the exact captured composer", () => {
  const sendStart = source.indexOf("const onSend = useCallback(");
  const sendEnd = source.indexOf("const addFiles = useCallback", sendStart);
  const deleteStart = source.indexOf("const deleteCurrentDraft =");
  const actionStart = source.indexOf("const saveDraftAction", deleteStart);
  const send = source.slice(sendStart, sendEnd);
  const deletion = source.slice(deleteStart, actionStart);

  assert.match(send, /clearCapturedComposerAfterAcceptedAction\(pending\)/);
  assert.doesNotMatch(send, /setComposer\(""\)/);
  assert.match(deletion, /shouldClearComposerAfterDraftDelete/);
  assert.match(deletion, /routeThreadIdRef\.current/);
  assert.match(deletion, /composerIntentRef\.current/);
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
  const start = source.indexOf('if (disposition === "retain" || disposition === "scheduled")');
  const end = source.indexOf('if (disposition === "replay_same_id")', start);
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

test("cross-tab attachment recovery migrates ownership before removing the old private copy", () => {
  const start = source.indexOf("if (attachmentNamespace !== composerAttachmentStore.namespace)");
  const end = source.indexOf("const attachments = recovered.map", start);
  const migration = source.slice(start, end);
  assert.match(migration, /composerAttachmentStore\.put/);
  assert.match(migration, /externalActionAttempts\.replaceScopedValue/);
  assert.match(migration, /composerAttachmentStore\s*\.remove/);
  assert.ok(migration.indexOf("replaceScopedValue") < migration.indexOf(".remove("));
});
