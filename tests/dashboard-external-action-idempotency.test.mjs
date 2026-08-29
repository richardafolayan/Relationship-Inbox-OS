import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createExternalActionAttemptStore,
  ExternalActionAttemptConflictError,
  ExternalActionAttemptStorageError
} from "../apps/dashboard/lib/external-action-attempts.ts";

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
    assert.match(source, new RegExp("scope = `" + action + ":"));
  }
  assert.equal((source.match(/externalActionAttempts\.getOrCreateScopedValue\(/g) ?? []).length, 6);
  assert.equal((source.match(/\{ clientActionId,/g) ?? []).length >= 3, true);
  assert.equal((source.match(/externalActionAttempts\.completeScopedValue/g) ?? []).length, 6);
});

test("focus acknowledgements keep one send id through delivery and atomic focus completion", () => {
  assert.match(focusSource, /scope = `focus-ack:/);
  assert.match(focusSource, /focusAcknowledgementAttempts\.getOrCreateScopedValue\(/);
  const delivery = focusSource.indexOf("await waitForFocusAcknowledgementDelivery(clientSendId)");
  const acknowledgement = focusSource.indexOf("/focus-ack/complete");
  const completion = focusSource.indexOf("focusAcknowledgementAttempts.completeScopedValue");
  assert.ok(delivery > focusSource.indexOf("source: \"focus_ack\""));
  assert.ok(acknowledgement > delivery);
  assert.ok(
    completion > acknowledgement
  );
});

test("a pending poll response preserves the form and attempt identity", () => {
  const pendingGuard = source.indexOf('if (output.status === "pending")');
  const completion = source.indexOf("externalActionAttempts.completeScopedValue", pendingGuard);
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
  const createValue = () => ({ clientActionId: `attempt-${++created}` });
  const scope = "remount-reaction-thread-1-message-1";
  const intent = { emoji: "heart" };

  const firstMount = createExternalActionAttemptStore(storage);
  assert.equal(
    firstMount.getOrCreateScopedValue(scope, intent, createValue).clientActionId,
    "attempt-1"
  );

  const remounted = createExternalActionAttemptStore(storage);
  assert.equal(
    remounted.getOrCreateScopedValue(scope, intent, createValue).clientActionId,
    "attempt-1"
  );
  assert.equal(created, 1);

  const afterPendingProjection = createExternalActionAttemptStore(storage);
  assert.equal(
    afterPendingProjection.getOrCreateScopedValue(scope, intent, createValue).clientActionId,
    "attempt-1"
  );

  remounted.completeScopedValue(scope, (value) => value.clientActionId === "attempt-1");
  const afterCompletion = createExternalActionAttemptStore(storage);
  assert.equal(
    afterCompletion.getOrCreateScopedValue(scope, intent, createValue).clientActionId,
    "attempt-2"
  );
});

test("a scoped attempt reuses its id only for the same canonical intent", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const scope = "canonical-intent-thread-1";
  let created = 0;
  const first = createExternalActionAttemptStore(storage).getOrCreateScopedValue(
    scope,
    { text: "hello", scheduledFor: "2026-08-30T09:00:00.000Z" },
    () => ({ clientSendId: `attempt-${++created}` })
  );
  const retry = createExternalActionAttemptStore(storage).getOrCreateScopedValue(
    scope,
    { scheduledFor: "2026-08-30T09:00:00.000Z", text: "hello" },
    () => ({ clientSendId: `attempt-${++created}` })
  );
  assert.deepEqual(retry, first);
  assert.equal(created, 1);
});

test("changing a scheduled time while its attempt is unresolved fails closed", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const store = createExternalActionAttemptStore(storage);
  const scope = "schedule-time-conflict-thread-1";
  store.getOrCreateScopedValue(
    scope,
    { text: "hello", scheduledFor: "2026-08-30T09:00:00.000Z" },
    () => ({ clientSendId: "attempt-1" })
  );
  assert.throws(
    () => store.getOrCreateScopedValue(
      scope,
      { text: "hello", scheduledFor: "2026-08-30T09:05:00.000Z" },
      () => ({ clientSendId: "attempt-2" })
    ),
    ExternalActionAttemptConflictError
  );
});

test("corrupt scoped storage fails closed instead of inventing another id", () => {
  const values = new Map([
    ["rios.external-action-attempt.v1:value:scoped:corrupt-thread-1", "not-json"]
  ]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  assert.throws(
    () => createExternalActionAttemptStore(storage).getOrCreateScopedValue(
      "corrupt-thread-1",
      { text: "hello" },
      () => ({ clientSendId: "attempt-new" })
    ),
    ExternalActionAttemptStorageError
  );
});

test("scoped completion cannot remove a newer attempt", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const scope = "completion-race-thread-1";
  const key = `rios.external-action-attempt.v1:value:scoped:${scope}`;
  const store = createExternalActionAttemptStore(storage);
  store.getOrCreateScopedValue(scope, { text: "first" }, () => ({ clientSendId: "attempt-1" }));

  const completed = store.completeScopedValue(scope, (value) => {
    values.set(key, JSON.stringify({
      version: 1,
      intent: { text: "second" },
      value: { clientSendId: "attempt-2" }
    }));
    return value.clientSendId === "attempt-1";
  });
  assert.equal(completed, false);
  assert.match(values.get(key), /attempt-2/);
});
