import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);
const attachmentStoreSource = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/lib/thread-composer-attachments.ts", import.meta.url)),
  "utf8"
);

test("thread navigation snapshots the previous full intent and restores only the new thread", () => {
  const start = source.indexOf("useLayoutEffect(() => {");
  const end = source.indexOf("useEffect(() => {", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const lifecycle = source.slice(start, end);
  assert.match(
    lifecycle,
    /persistComposerSession\([\s\S]*?previousThreadId,[\s\S]*?currentIntent,[\s\S]*?composerDraftRevisionRef\.current/
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
  assert.match(
    schedule,
    /persistComposerSession\([\s\S]*?startThreadId,[\s\S]*?capturedIntent,[\s\S]*?capturedDraftRevision/
  );
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
  assert.match(
    send,
    /persistComposerSession\([\s\S]*?ownerThreadId,[\s\S]*?composerIntentRef\.current,[\s\S]*?composerDraftRevisionRef\.current/
  );
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
    /restoreThreadComposerSession\([\s\S]*?pending\.threadId,[\s\S]*?recoveryIntent,[\s\S]*?recoverySessionRevisionId,[\s\S]*?pending\.draftRevision/
  );
  assert.match(restore, /resolution: "restored"/);
  assert.match(restore, /composerRecoveryResolution\(/);
  assert.match(restore, /composerIntentForRecovery\(/);
});

test("completed composer generations suppress copied-tab duplicate sends", () => {
  assert.match(source, /composerClientSendId\([\s\S]*?capturedSession\.revisionId,[\s\S]*?attemptIntent\.kind,[\s\S]*?attemptIntent\.scheduledFor/);
  assert.match(source, /sessionRevisionId: capturedSession\.revisionId,[\s\S]*?kind: "immediate"/);
  assert.match(source, /sessionRevisionId: capturedSession\.revisionId,[\s\S]*?kind: "scheduled"/);
  assert.match(source, /readCompletedScopedValues<ThreadComposerSendAttemptValue>/);
  assert.match(source, /const restoredPredecessor = completedValues\.find/);
  assert.match(source, /const recoveryClientSendId =/);
  assert.match(source, /composerRecoveryResolution\(\s*\{ clientSendId: recoveryClientSendId \}/);
  assert.match(source, /externalActionCompletedStorageKey/);
  assert.match(source, /composerSessionDisposition\(startThreadId, capturedSession\)/);
  assert.match(
    source,
    /const reconcileCompletedSession = \(\) => \{[\s\S]*?reconcileCompletedSession\(\);[\s\S]*?window\.addEventListener\("storage", onStorage\)/
  );
  assert.match(source, /restoreThreadComposerSession\(/);
  assert.match(source, /value\.sessionRevisionId === storedSession\?\.revisionId/);
  assert.match(source, /value\.sessionRevisionId === capturedSession\.revisionId/);
  assert.match(source, /notFoundRecovery: "replay"/);
  assert.match(source, /attemptKind: "immediate"/);
  assert.match(source, /attemptKind: "scheduled"/);
  assert.match(source, /value\.attemptKind === attemptIntent\.kind/);
  assert.match(source, /value\.scheduledFor === attemptIntent\.scheduledFor/);
  assert.match(source, /composerNotFoundRecoveryOnResume/);
  assert.match(source, /pending\.notFoundRecovery !== "replay"/);
});

test("attachment restoration blocks send and schedule until every intended file is resolved", () => {
  const sendStart = source.indexOf("const onSend = useCallback");
  const scheduleStart = source.indexOf("const scheduleSend = useCallback");
  const send = source.slice(sendStart, scheduleStart);
  const schedule = source.slice(scheduleStart, source.indexOf("const cancelScheduledSend", scheduleStart));

  assert.match(source, /composerAttachmentsRestoringRef\.current = restoredIntent\.attachments\.length > 0/);
  assert.match(source, /setComposerAttachmentsRestoring\(restoredIntent\.attachments\.length > 0\)/);
  assert.match(send, /composerAttachmentsRestoringRef\.current/);
  assert.match(schedule, /composerAttachmentsRestoringRef\.current/);
  assert.match(send, /await awaitComposerAttachmentOwnership\(startThreadId, capturedSession\)/);
  assert.match(schedule, /await awaitComposerAttachmentOwnership\(startThreadId, capturedSession\)/);
  assert.match(source, /disabled=\{[\s\S]*?composerAttachmentsRestoring/);
});

test("navigation and pagehide preserve durable attachment descriptors while bytes are restoring", () => {
  const intentRefStart = source.indexOf("const restoringComposerAttachments =");
  const intentRefEnd = source.indexOf("const composerSessionDisposition", intentRefStart);
  const intentRefUpdate = source.slice(intentRefStart, intentRefEnd);

  assert.match(intentRefUpdate, /composerAttachmentsRestoringRef\.current/);
  assert.match(intentRefUpdate, /composerRestoreRef\.current\.intent\.attachments/);
  assert.match(intentRefUpdate, /mergeThreadComposerAttachmentDescriptors/);
  assert.match(intentRefUpdate, /composerOwnerThreadIdRef\.current/);
  assert.match(source, /pagehide[\s\S]*?composerIntentRef\.current/);
  const persistStart = source.indexOf("const restoring = composerRestoreRef.current;");
  const persistEnd = source.indexOf("const saved = persistComposerSession", persistStart);
  const restoreGate = source.slice(persistStart, persistEnd);
  assert.match(restoreGate, /composerAttachmentsRestoringRef\.current/);
  assert.ok(
    restoreGate.indexOf("composerAttachmentsRestoringRef.current") <
      restoreGate.indexOf("composerRestoreRef.current = null")
  );
  assert.doesNotMatch(restoreGate, /composerAttachmentsRestoringRef\.current\) return/);
});

test("attachment quarantine is swept again while a thread stays open", () => {
  assert.match(source, /composerAttachmentStore\.purgeStale\(\)/);
  assert.match(source, /window\.setInterval\([\s\S]*?purgeStaleAttachments/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /window\.addEventListener\("focus", purgeStaleAttachments\)/);
  assert.match(source, /reconcileThreadComposerAttachmentOwnership\(/);
  assert.match(source, /inspectThreadComposerSession\(ownerThreadId\)/);
  assert.match(source, /attachmentOwnershipRef\.current\.delete\(ownerThreadId\)/);
  assert.match(source, /result === "released"/);
});

test("startup refreshes restored leases before the first stale purge", () => {
  assert.doesNotMatch(attachmentStoreSource, /void purgeStale\(\)\.catch/);
  const persistence = source.indexOf("const saved = persistComposerSession(", 0);
  const sweep = source.indexOf("const purgeStaleAttachments = () =>");
  assert.notEqual(persistence, -1);
  assert.notEqual(sweep, -1);
  assert.ok(persistence < sweep);
  const lifecycleStart = source.indexOf("useLayoutEffect(() => {");
  const lifecycleEnd = source.indexOf("useEffect(() => {", lifecycleStart);
  const lifecycle = source.slice(lifecycleStart, lifecycleEnd);
  const lease = lifecycle.indexOf("attachmentOwnershipRef.current.set(threadId");
  const hydration = lifecycle.indexOf("composerAttachmentStore\n        .read(threadId");
  assert.ok(lease !== -1 && lease < hydration);
  assert.match(lifecycle, /pendingAttempt\?\.value\.attachmentNamespace/);
});

test("failed-send recovery claims the successor lease before publishing its tombstone", () => {
  const start = source.indexOf("const restorePendingComposerSend = useCallback(");
  const end = source.indexOf("const clearCapturedComposerAfterAcceptedAction", start);
  const restore = source.slice(start, end);
  const prepare = restore.indexOf("prepareThreadComposerAttachmentOwnershipHandoff(");
  const publish = restore.indexOf("compareAndCompleteScopedValue<ThreadComposerSendAttemptValue>");
  const commit = restore.indexOf("ownershipHandoff.commit()");
  assert.ok(prepare !== -1 && prepare < publish);
  assert.ok(commit > publish);
  assert.doesNotMatch(restore, /compareAndCompleteScopedValue<[\s\S]*?\.catch\(\(\) => false\)/);
  assert.match(restore, /if \(!releaseStateUnknown && !resolutionStateUnknown\)/);
});

test("editing an unverifiable recovery clears its matching block notice", () => {
  const persistStart = source.indexOf("const persistComposerSession = useCallback");
  const persistEnd = source.indexOf("const awaitComposerAttachmentOwnership", persistStart);
  const persist = source.slice(persistStart, persistEnd);

  assert.match(persist, /composerSessionDisposition\(ownerThreadId, saved\)/);
  assert.match(persist, /clearComposerRecoveryBlock\(\)/);
  assert.match(source, /current === recoveryNotice \? null : current/);
  assert.doesNotMatch(source, /review or edit it/i);
  assert.match(source, /blocked until you edit it/);
});

test("unverifiable recovery quarantines content and a live successor is restored instead of erased", () => {
  const blockStart = source.indexOf("const blockComposerSession = useCallback");
  const blockEnd = source.indexOf("const suppressComposerSession = useCallback", blockStart);
  const block = source.slice(blockStart, blockEnd);
  const reconcileStart = source.indexOf("const reconcileCompletedSession = () =>");
  const reconcileEnd = source.indexOf("const onStorage", reconcileStart);
  const reconcile = source.slice(reconcileStart, reconcileEnd);

  assert.notEqual(blockStart, -1);
  assert.doesNotMatch(block, /consumeThreadComposerSession/);
  assert.match(reconcile, /restoreSupersededComposerSession/);
  assert.match(reconcile, /blockComposerSession/);
  assert.match(reconcile, /suppressComposerSession/);
  assert.match(source, /const ownerId = saved\.revisionId/);
  assert.doesNotMatch(source, /attachmentOwnerIdRef/);
});

test("NOT_FOUND replay requires an authoritative shared-generation transition", () => {
  const statusStart = source.indexOf("const checkPendingDelivery = useCallback(");
  const statusEnd = source.indexOf("checkPendingDeliveryRef.current = checkPendingDelivery", statusStart);
  const status = source.slice(statusStart, statusEnd);
  assert.match(status, /compareAndReplaceScopedValue/);
  assert.match(status, /value\.notFoundRecovery === "replay"/);
  assert.match(status, /notFoundRecovery: "blocked"/);
});

test("a blocked NOT_FOUND recovery observes release, restoration, and successor completion", () => {
  const statusStart = source.indexOf("const checkPendingDelivery = useCallback(");
  const statusEnd = source.indexOf("checkPendingDeliveryRef.current = checkPendingDelivery", statusStart);
  const status = source.slice(statusStart, statusEnd);
  const blockedStart = status.indexOf('pending.notFoundRecovery !== "replay"');
  const blockedEnd = status.indexOf("if (", blockedStart + 40);
  const blocked = status.slice(blockedStart, blockedEnd === -1 ? undefined : blockedEnd);
  assert.match(status.slice(blockedStart), /externalActionAttempts\.readScopedAttempt\(scope\)/);
  assert.match(status.slice(blockedStart), /composerRecoveryResolution\(/);
  assert.doesNotMatch(source, /completeReleasedScopedValue/);
  assert.match(status.slice(blockedStart), /recordAlreadyReleased: true/);
  assert.notEqual(blockedStart, -1);
  assert.notEqual(blocked, "");
});

test("route entry invalidates an earlier visit before publishing the active route", () => {
  const lifecycleStart = source.indexOf("// This dynamic route stays mounted");
  const lifecycleEnd = source.indexOf("useEffect(() => {", lifecycleStart);
  const lifecycle = source.slice(lifecycleStart, lifecycleEnd);
  const invalidation = lifecycle.indexOf("threadRequestGate.next(threadId)");
  const routePublication = lifecycle.indexOf("routeThreadIdRef.current = threadId");

  assert.notEqual(invalidation, -1);
  assert.notEqual(routePublication, -1);
  assert.ok(invalidation < routePublication);
});

test("authoritative thread refreshes apply only the latest started request", () => {
  const start = source.indexOf("const refreshThread = useCallback");
  const end = source.indexOf("const refreshSiblings", start);
  const refresh = source.slice(start, end);
  assert.match(refresh, /threadRequestGate\.next\(threadId\)/);
  assert.match(refresh, /threadRequestGate\.isLatest\(threadId, requestToken\)/);
  assert.ok(
    refresh.indexOf("threadRequestGate.isLatest(threadId, requestToken)") < refresh.indexOf("applyThread(fresh")
  );
});

test("late draft mutations CAS the originating session and never write feedback into another route", () => {
  const saveStart = source.indexOf("const saveCurrentDraft =");
  const actionStart = source.indexOf("const saveDraftAction", saveStart);
  const draftActions = source.slice(saveStart, actionStart);
  assert.match(draftActions, /attachDraftRevisionToThreadComposerSession/);
  assert.match(draftActions, /consumeThreadComposerSession/);
  assert.match(draftActions, /routeThreadIdRef\.current === targetThreadId/);
  const feedback = source.slice(actionStart, source.indexOf("const snoozeOverflowAction", actionStart));
  assert.match(feedback, /setThreadActionError/);
  assert.doesNotMatch(feedback, /setError,/);
});

test("accepted composer generations rotate before identical text can be sent again", () => {
  assert.match(source, /snapshotThreadComposerSessionAfterAcceptedAction/);
  assert.match(source, /acceptedComposerSessionIdsRef/);
  const clearStart = source.indexOf("const clearCapturedComposerAfterAcceptedAction");
  const clearEnd = source.indexOf("// Send-queue polling fallback", clearStart);
  const clear = source.slice(clearStart, clearEnd);
  assert.match(clear, /currentSession\.revisionId !== pending\.sessionRevisionId/);
  assert.match(clear, /generationWasAlreadyAccepted/);
});

test("late composer failures are scoped to the thread that started them", () => {
  const sendStart = source.indexOf("const onSend = useCallback(");
  const sendEnd = source.indexOf("const addFiles = useCallback", sendStart);
  const send = source.slice(sendStart, sendEnd);
  assert.match(send, /if \(routeThreadIdRef\.current === startThreadId\) setError\(/);
  const addFiles = source.slice(sendEnd, source.indexOf("const removeAttachment", sendEnd));
  assert.match(addFiles, /routeThreadIdRef\.current === ownerThreadId/);
});

test("send status and terminal events apply durable draft consumption before authoritative refresh", () => {
  assert.match(
    source,
    /if \(response\.draftConsumed\) consumePendingDraftRevision\(pending\)/
  );
  assert.match(
    source,
    /detail\.draftConsumed[\s\S]*?consumePendingDraftRevision\(pending\)/
  );
  assert.match(source, /refreshThread\(\{ authoritative: true \}\)/);
});

test("scheduled acceptance clears only its captured composer and status failures keep reconciling", () => {
  const scheduleStart = source.indexOf("const scheduleSend = useCallback(");
  const scheduleEnd = source.indexOf("const cancelScheduledSend", scheduleStart);
  const schedule = source.slice(scheduleStart, scheduleEnd);
  const statusStart = source.indexOf("const checkPendingDelivery = useCallback(");
  const statusEnd = source.indexOf("checkPendingDeliveryRef.current = checkPendingDelivery", statusStart);
  const status = source.slice(statusStart, statusEnd);

  assert.match(schedule, /clearCapturedComposerAfterAcceptedAction\(pending\)/);
  assert.match(
    status,
    /catch \{[\s\S]*?setTimeout\([\s\S]*?checkPendingDeliveryRef\.current\(pending\.clientSendId\)/
  );
});

test("late delivery reconciliation cannot write thread A errors into thread B", () => {
  const restoreStart = source.indexOf("const restorePendingComposerSend = useCallback(");
  const restoreEnd = source.indexOf("const clearCapturedComposerAfterAcceptedAction", restoreStart);
  const statusStart = source.indexOf("const checkPendingDelivery = useCallback(");
  const statusEnd = source.indexOf("checkPendingDeliveryRef.current = checkPendingDelivery", statusStart);
  assert.match(
    source.slice(restoreStart, restoreEnd),
    /routeThreadIdRef\.current === pending\.threadId/
  );
  assert.match(
    source.slice(statusStart, statusEnd),
    /routeThreadIdRef\.current === pending\.threadId/
  );
});

test("draft mutations are ordered with sends, schedules, and both delete controls", () => {
  const sendStart = source.indexOf("const onSend = useCallback(");
  const scheduleStart = source.indexOf("const scheduleSend = useCallback(");
  const deleteStart = source.indexOf("const deleteCurrentDraft =");
  const actionStart = source.indexOf("const saveDraftAction", deleteStart);
  assert.match(source.slice(sendStart, scheduleStart), /await draftMutations\.acquireAction/);
  assert.match(source.slice(sendStart, scheduleStart), /releaseDraftAction\?\.\(\)/);
  assert.match(source.slice(scheduleStart, deleteStart), /await draftMutations\.acquireAction/);
  assert.match(source.slice(scheduleStart, deleteStart), /releaseDraftAction\?\.\(\)/);
  assert.match(source.slice(deleteStart, actionStart), /draftMutations\.enqueueDelete/);
  assert.equal(
    (source.slice(source.indexOf("const saveCurrentDraft"), actionStart)
      .match(/composerActionRef\.current\?\.threadId === targetThreadId/g) ?? []).length,
    2
  );
  assert.equal((source.match(/disabled=\{sending \|\| scheduling\}/g) ?? []).length, 2);
  assert.match(source.slice(actionStart), /label: "Save draft",\s*disabled: sending \|\| scheduling/);
  assert.match(source.slice(actionStart), /label: "Delete draft",[\s\S]*?disabled: sending \|\| scheduling/);
  assert.equal((source.match(/deleteCurrentDraft\(\)/g) ?? []).length, 2);
  assert.match(source, /draftRevisionForComposerSend\(/);
  assert.match(source, /draftMutations\.consumeRevision/);
  assert.match(source, /draftMutations\.reconcileFetchedRevision/);
});

test("delivery events and status cleanup consume drafts only from authoritative flags", () => {
  const eventStart = source.indexOf("// SSE reconciliation for sends.");
  const completionStart = source.indexOf("const completePendingComposerSend", eventStart);
  const restoreStart = source.indexOf("const restorePendingComposerSend", completionStart);
  assert.match(
    source.slice(eventStart, completionStart),
    /if \(detail\.draftConsumed\) consumePendingDraftRevision\(pending\)/
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

test("terminal cleanup preserves attachment ids owned by a newer composer generation", () => {
  assert.equal(
    (source.match(/removableThreadComposerAttachmentIds\(/g) ?? []).length >= 2,
    true
  );
  assert.match(source, /composerIntentRef\.current\.attachments/);
  assert.match(source, /activeAttachmentIds\.has\(attachment\.id\)/);
  assert.match(source, /removeUnowned/);
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
  assert.match(migration, /externalActionAttempts\.compareAndReplaceScopedValue/);
  assert.match(migration, /composerAttachmentStore\s*\.removeUnowned/);
  assert.ok(
    migration.indexOf("compareAndReplaceScopedValue") < migration.indexOf(".removeUnowned(")
  );
});
