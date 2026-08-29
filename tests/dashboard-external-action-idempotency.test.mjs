import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExternalActionAttemptStore } from "../apps/dashboard/lib/external-action-attempts.ts";

const source = await readFile(
  new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
  "utf8"
);
const focusSource = await readFile(
  new URL("../apps/dashboard/lib/use-focus-window.ts", import.meta.url),
  "utf8"
);

test("message mutations keep one client action id across an uncertain retry", () => {
  assert.match(source, /createExternalActionAttemptStore\(\)/);
  for (const action of ["send-poll", "dictation-send", "schedule-send", "reaction", "poll-vote", "edit"]) {
    assert.match(source, new RegExp("attemptKey = `" + action + ":"));
  }
  assert.equal((source.match(/externalActionAttempts\.getOrCreate\(attemptKey, uuid\)/g) ?? []).length, 5);
  assert.match(source, /externalActionAttempts\.getOrCreateValue\(attemptKey/);
  assert.equal((source.match(/\{ clientActionId,/g) ?? []).length >= 3, true);
  assert.equal((source.match(/externalActionAttempts\.completeIfReconciled\(/g) ?? []).length, 4);
});

test("focus acknowledgements keep one send id until the runner confirms persistence", () => {
  assert.match(focusSource, /attemptKey = `focus-ack:/);
  assert.match(focusSource, /focusAcknowledgementAttempts\.getOrCreate\(attemptKey, newWindowId\)/);
  assert.ok(
    focusSource.indexOf("focusAcknowledgementAttempts.complete(attemptKey)") >
      focusSource.indexOf("await apiPost")
  );
});

test("a pending poll response preserves the form and attempt identity", () => {
  const pendingGuard = source.indexOf('if (output.status === "pending")');
  const completion = source.indexOf("externalActionAttempts.completeIfReconciled", pendingGuard);
  const clearForm = source.indexOf('setWhatsAppPollQuestion("")', pendingGuard);
  assert.notEqual(pendingGuard, -1);
  assert.ok(pendingGuard < completion);
  assert.ok(pendingGuard < clearForm);
  assert.match(source.slice(pendingGuard, completion), /return;/);
});

test("an unresolved client action id survives a complete component remount", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  let created = 0;
  const createId = () => `attempt-${++created}`;
  const key = "reaction:thread-1:message-1:heart";

  const firstMount = createExternalActionAttemptStore(storage);
  assert.equal(firstMount.getOrCreate(key, createId), "attempt-1");

  const remounted = createExternalActionAttemptStore(storage);
  assert.equal(remounted.getOrCreate(key, createId), "attempt-1");
  assert.equal(created, 1);

  remounted.completeIfReconciled(key, true);
  const afterPendingProjection = createExternalActionAttemptStore(storage);
  assert.equal(afterPendingProjection.getOrCreate(key, createId), "attempt-1");

  remounted.completeIfReconciled(key, false);
  const afterCompletion = createExternalActionAttemptStore(storage);
  assert.equal(afterCompletion.getOrCreate(key, createId), "attempt-2");
});

test("a scheduled-send retry preserves both its id and exact scheduled time", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const key = "schedule-send:thread-1:hello";
  const first = createExternalActionAttemptStore(storage).getOrCreateValue(key, () => ({
    clientSendId: "attempt-1",
    scheduledFor: "2026-08-30T09:00:00.000Z"
  }));
  const retry = createExternalActionAttemptStore(storage).getOrCreateValue(key, () => ({
    clientSendId: "attempt-2",
    scheduledFor: "2026-08-30T09:00:01.000Z"
  }));
  assert.deepEqual(retry, first);
});
