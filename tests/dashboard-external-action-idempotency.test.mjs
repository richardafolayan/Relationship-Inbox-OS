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
  const dictation = source.slice(
    source.indexOf("const sendDictationMessage"),
    source.indexOf("// Cmd/Ctrl-Enter sends.")
  );
  assert.ok(
    dictation.indexOf("waitForTerminalSendStatus") <
      dictation.indexOf("externalActionAttempts.completeScopedValue")
  );
  assert.match(dictation, /status\.status === "FAILED" && status\.retrySafe/);
  assert.match(dictation, /if \(recovery\.kind !== "sent"\) throw/);
});

test("focus acknowledgements keep one send id through delivery and atomic focus completion", () => {
  assert.match(focusSource, /scope = `focus-ack:/);
  assert.match(focusSource, /focusAcknowledgementAttempts\.getOrCreateScopedValue\(/);
  assert.match(focusSource, /canReplaceFocusAcknowledgementAttempt/);
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

test("poll options are deduplicated before validation, identity, and dispatch", () => {
  const poll = source.slice(
    source.indexOf("const sendWhatsAppPoll"),
    source.indexOf("const composerAttachmentsRef", source.indexOf("const sendWhatsAppPoll"))
  );
  const dedupe = poll.indexOf("...new Set(");
  assert.notEqual(dedupe, -1);
  assert.ok(dedupe < poll.indexOf("if (options.length < 2)"));
  assert.ok(dedupe < poll.indexOf("const intent ="));
  assert.match(poll, /question,\s*options,\s*allowMultipleAnswers/);
});

test("an unresolved client action id survives a complete component remount", async () => {
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
    (await firstMount.getOrCreateScopedValue(scope, intent, createValue)).clientActionId,
    "attempt-1"
  );

  const remounted = createExternalActionAttemptStore(storage);
  assert.equal(
    (await remounted.getOrCreateScopedValue(scope, intent, createValue)).clientActionId,
    "attempt-1"
  );
  assert.equal(created, 1);

  const afterPendingProjection = createExternalActionAttemptStore(storage);
  assert.equal(
    (await afterPendingProjection.getOrCreateScopedValue(scope, intent, createValue)).clientActionId,
    "attempt-1"
  );

  await remounted.completeScopedValue(scope, (value) => value.clientActionId === "attempt-1");
  const afterCompletion = createExternalActionAttemptStore(storage);
  assert.equal(
    (await afterCompletion.getOrCreateScopedValue(scope, intent, createValue)).clientActionId,
    "attempt-1"
  );
  assert.equal(created, 1);
});

test("a scoped attempt reuses its id only for the same canonical intent", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const scope = "canonical-intent-thread-1";
  let created = 0;
  const first = await createExternalActionAttemptStore(storage).getOrCreateScopedValue(
    scope,
    { text: "hello", scheduledFor: "2026-08-30T09:00:00.000Z" },
    () => ({ clientSendId: `attempt-${++created}` })
  );
  const retry = await createExternalActionAttemptStore(storage).getOrCreateScopedValue(
    scope,
    { scheduledFor: "2026-08-30T09:00:00.000Z", text: "hello" },
    () => ({ clientSendId: `attempt-${++created}` })
  );
  assert.deepEqual(retry, first);
  assert.equal(created, 1);
});

test("changing a scheduled time while its attempt is unresolved fails closed", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const store = createExternalActionAttemptStore(storage);
  const scope = "schedule-time-conflict-thread-1";
  await store.getOrCreateScopedValue(
    scope,
    { text: "hello", scheduledFor: "2026-08-30T09:00:00.000Z" },
    () => ({ clientSendId: "attempt-1" })
  );
  await assert.rejects(
    store.getOrCreateScopedValue(
      scope,
      { text: "hello", scheduledFor: "2026-08-30T09:05:00.000Z" },
      () => ({ clientSendId: "attempt-2" })
    ),
    ExternalActionAttemptConflictError
  );
});

test("corrupt scoped storage fails closed instead of inventing another id", async () => {
  const values = new Map([
    ["rios.external-action-attempt.v1:value:scoped:corrupt-thread-1", "not-json"]
  ]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  await assert.rejects(
    createExternalActionAttemptStore(storage).getOrCreateScopedValue(
      "corrupt-thread-1",
      { text: "hello" },
      () => ({ clientSendId: "attempt-new" })
    ),
    ExternalActionAttemptStorageError
  );
});

test("scoped operations serialize allocation and completion across stores", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const scope = "completion-race-thread-1";
  const key = `rios.external-action-attempt.v1:value:scoped:${scope}`;
  const firstStore = createExternalActionAttemptStore(storage);
  const secondStore = createExternalActionAttemptStore(storage);
  await firstStore.getOrCreateScopedValue(
    scope,
    { text: "first" },
    () => ({ clientSendId: "attempt-1" })
  );

  const completion = firstStore.completeScopedValue(
    scope,
    (value) => value.clientSendId === "attempt-1"
  );
  const replacement = secondStore.getOrCreateScopedValue(
    scope,
    { text: "second" },
    () => ({ clientSendId: "attempt-2" }),
    async (value) => value.clientSendId === "attempt-1"
  );
  const [completed, replacementValue] = await Promise.all([completion, replacement]);
  assert.equal(completed, true);
  assert.equal(replacementValue.clientSendId, "attempt-2");
  assert.match(values.get(key), /attempt-2/);
});

test("two stores allocate one id for the same scope and intent", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  let created = 0;
  const first = createExternalActionAttemptStore(storage);
  const second = createExternalActionAttemptStore(storage);
  const [a, b] = await Promise.all([
    first.getOrCreateScopedValue("cross-tab", { text: "hello" }, () => ({ clientSendId: `attempt-${++created}` })),
    second.getOrCreateScopedValue("cross-tab", { text: "hello" }, () => ({ clientSendId: `attempt-${++created}` }))
  ]);
  assert.deepEqual(a, b);
  assert.equal(created, 1);
});

test("one tab completing an action leaves the shared id for a stale tab", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const first = createExternalActionAttemptStore(storage);
  const stale = createExternalActionAttemptStore(storage);
  const scope = "completed-cross-tab-action";
  const intent = { question: "Lunch?", options: ["Yes", "No"] };
  let created = 0;
  const create = () => ({ clientSendId: `attempt-${++created}` });

  const original = await first.getOrCreateScopedValue(scope, intent, create);
  assert.equal(await first.completeScopedValue(scope, () => true), true);
  const replay = await stale.getOrCreateScopedValue(scope, intent, create);

  assert.deepEqual(replay, original);
  assert.equal(created, 1);
});

test("a completed reconciled action can release its scope for a changed intent", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const store = createExternalActionAttemptStore(storage);
  await store.getOrCreateScopedValue(
    "changed-intent",
    { emoji: "heart" },
    () => ({ clientActionId: "attempt-1" })
  );
  const next = await store.getOrCreateScopedValue(
    "changed-intent",
    { emoji: "laugh" },
    () => ({ clientActionId: "attempt-2" }),
    async (value) => value.clientActionId === "attempt-1"
  );

  assert.equal(next.clientActionId, "attempt-2");
});

test("poll vote uses the same canonical option order for identity and dispatch", () => {
  const vote = source.slice(
    source.indexOf("const voteOnPoll"),
    source.indexOf("const editMessage", source.indexOf("const voteOnPoll"))
  );
  assert.match(vote, /normalizedSelectedOptions = \[\.\.\.selectedOptions\]\.sort\(\)/);
  assert.match(vote, /selectedOptions: normalizedSelectedOptions/);
  assert.doesNotMatch(vote, /\{ clientActionId, selectedOptions \}/);
});

test("unavailable durable storage fails closed", async () => {
  await assert.rejects(
    createExternalActionAttemptStore().getOrCreateScopedValue(
      "no-storage",
      { text: "hello" },
      () => ({ clientSendId: "unsafe-new-id" })
    ),
    ExternalActionAttemptStorageError
  );
});
