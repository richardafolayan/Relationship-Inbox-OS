import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createExternalActionAttemptStore,
  ExternalActionAttemptConflictError,
  ExternalActionAttemptStorageError
} from "../apps/dashboard/lib/external-action-attempts.ts";
import { composerRecoveryResolution } from "../apps/dashboard/lib/thread-composer-send-recovery.ts";

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
  for (const action of ["send-poll", "dictation-send", "reaction", "poll-vote", "edit"]) {
    assert.match(source, new RegExp("scope = `" + action + ":"));
  }
  assert.match(source, /threadComposerSendScope\(startThreadId\)/);
  assert.equal(
    (source.match(/externalActionAttempts\.getOrCreateScopedValue/g) ?? []).length >= 7,
    true
  );
  assert.equal((source.match(/\{ clientActionId,/g) ?? []).length >= 3, true);
  assert.equal(
    (source.match(/\.completeScopedValue/g) ?? []).length >= 7,
    true
  );
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
    "attempt-2"
  );
  assert.equal(created, 2);
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
  const staleInFlight = await stale.getOrCreateScopedValue(scope, intent, create);
  assert.deepEqual(staleInFlight, original);
  assert.equal(await first.completeScopedValue(scope, () => true), true);
  const replay = await stale.getOrCreateScopedValue(scope, intent, create);

  assert.deepEqual(replay, original);
  assert.equal(created, 1);
});

test("a stale tab cannot claim a generation after another tab definitively releases it", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const firstPins = new Map();
  const stalePins = new Map();
  const pinStorage = (pins) => ({
    getItem: (key) => pins.get(key) ?? null,
    setItem: (key, value) => pins.set(key, value),
    removeItem: (key) => pins.delete(key)
  });
  const first = createExternalActionAttemptStore(storage, undefined, pinStorage(firstPins));
  const stale = createExternalActionAttemptStore(storage, undefined, pinStorage(stalePins));
  const scope = "revoked-composer-send";
  const intent = { text: "Do not replay after revocation" };
  const value = { clientSendId: "send-1", notFoundRecovery: "replay" };

  await first.getOrCreateScopedValue(scope, intent, () => value);
  await stale.getOrCreateScopedValue(scope, intent, () => value);
  assert.equal(
    await first.completeScopedValue(
      scope,
      (candidate) => candidate.clientSendId === value.clientSendId
    ),
    true
  );

  assert.equal(
    await stale.compareAndReplaceScopedValue(
      scope,
      (candidate) =>
        candidate.clientSendId === value.clientSendId &&
        candidate.notFoundRecovery === "replay",
      { ...value, notFoundRecovery: "blocked" }
    ),
    false
  );
  assert.equal(stale.readScopedAttempt(scope), undefined);
});

test("a released generation retains an explicit recovery tombstone", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const store = createExternalActionAttemptStore(storage);
  const scope = "restored-composer-generation";
  const original = { clientSendId: "send-x", notFoundRecovery: "restore" };
  const tombstone = {
    ...original,
    resolution: "restored",
    restoredSessionRevisionId: "session-y"
  };

  await store.getOrCreateScopedValue(scope, { text: "preserved" }, () => original);
  assert.equal(
    await store.compareAndCompleteScopedValue(
      scope,
      (value) => value.clientSendId === "send-x",
      true,
      tombstone
    ),
    true
  );
  assert.deepEqual(store.readCompletedScopedValues(scope), [tombstone]);
});

test("a completed successor suppresses its restored predecessor after a stale-tab remount", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const store = createExternalActionAttemptStore(storage);
  const scope = "composer-predecessor-lineage";
  const predecessor = {
    attemptKind: "immediate",
    clientSendId: "send-x",
    notFoundRecovery: "restore",
    requestedAt: "2026-08-30T09:00:00.000Z",
    scheduledFor: null,
    sessionRevision: 1,
    sessionRevisionId: "session-x"
  };
  const restored = {
    ...predecessor,
    resolution: "restored",
    restoredSessionRevisionId: "session-y"
  };

  await store.getOrCreateScopedValue(scope, { session: "x" }, () => predecessor);
  await store.compareAndCompleteScopedValue(scope, () => true, true, restored);
  const successor = {
    ...predecessor,
    clientSendId: "send-y",
    resolution: "sent",
    sessionRevision: 2,
    sessionRevisionId: "session-y"
  };
  await store.getOrCreateScopedValue(scope, { session: "y" }, () => successor);
  await store.completeScopedValue(scope, () => true, true, successor);

  const remounted = createExternalActionAttemptStore(storage);
  assert.deepEqual(
    composerRecoveryResolution(
      predecessor,
      remounted.readCompletedScopedValues(scope)
    ),
    { kind: "sent", sessionRevisionId: "session-y" }
  );
  assert.equal(remounted.readScopedAttempt(scope), undefined);
});

test("restoration lineage is bounded and an expired predecessor fails closed", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const store = createExternalActionAttemptStore(storage);
  const scope = "durable-restoration-lineage";
  const restored = {
    clientSendId: "restored-x",
    resolution: "restored",
    restoredSessionRevisionId: "session-y"
  };
  await store.getOrCreateScopedValue(scope, { generation: "x" }, () => restored);
  await store.completeScopedValue(scope, () => true, true, restored);

  for (let index = 0; index < 101; index += 1) {
    const sent = { clientSendId: `sent-${index}`, resolution: "sent" };
    await store.getOrCreateScopedValue(scope, { generation: index }, () => sent);
    await store.completeScopedValue(scope, () => true, true, sent);
  }

  const completed = store.readCompletedScopedValues(scope);
  assert.equal(completed.length, 100);
  assert.equal(completed.some((value) => value.clientSendId === restored.clientSendId), false);
  assert.equal(composerRecoveryResolution(restored, completed), null);
  assert.equal(typeof store.readCompletedScopedState(scope).prunedBefore, "number");
});

test("a torn completion record dominates the surviving active record", async () => {
  const values = new Map();
  let rejectActiveRemoval = true;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      if (rejectActiveRemoval && key.includes(":value:scoped:")) {
        rejectActiveRemoval = false;
        throw new Error("simulated crash before active cleanup");
      }
      values.delete(key);
    }
  };
  const scope = "torn-composer-completion";
  const store = createExternalActionAttemptStore(storage);
  const active = { clientSendId: "send-x", notFoundRecovery: "blocked" };
  const tombstone = {
    ...active,
    resolution: "restored",
    restoredSessionRevisionId: "session-y"
  };

  await store.getOrCreateScopedValue(scope, { generation: "x" }, () => active);
  await assert.rejects(
    store.compareAndCompleteScopedValue(scope, () => true, true, tombstone)
  );

  assert.deepEqual(store.readCompletedScopedValues(scope), [tombstone]);
  assert.equal(store.readScopedAttempt(scope), undefined);
});

test("a recovery claim must compare against shared state rather than a stale tab pin", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const firstPins = new Map();
  const stalePins = new Map();
  const pinStorage = (pins) => ({
    getItem: (key) => pins.get(key) ?? null,
    setItem: (key, value) => pins.set(key, value),
    removeItem: (key) => pins.delete(key)
  });
  const first = createExternalActionAttemptStore(storage, undefined, pinStorage(firstPins));
  const stale = createExternalActionAttemptStore(storage, undefined, pinStorage(stalePins));
  const scope = "changed-composer-recovery";
  const intent = { text: "Preserved reply" };
  const replay = { clientSendId: "send-1", notFoundRecovery: "replay" };
  const restore = { ...replay, notFoundRecovery: "restore" };

  await first.getOrCreateScopedValue(scope, intent, () => replay);
  await stale.getOrCreateScopedValue(scope, intent, () => replay);
  assert.equal(
    await first.compareAndReplaceScopedValue(
      scope,
      (candidate) => candidate.clientSendId === "send-1",
      restore
    ),
    true
  );
  assert.equal(
    await stale.compareAndReplaceScopedValue(
      scope,
      (candidate) => candidate.notFoundRecovery === "replay",
      { ...replay, notFoundRecovery: "blocked" }
    ),
    false
  );
  assert.deepEqual(stale.readScopedAttempt(scope)?.value, restore);
});

test("the completing tab allocates a new id for a later identical operation", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const store = createExternalActionAttemptStore(storage);
  const scope = "repeat-identical-poll";
  const intent = { question: "Lunch?", options: ["Yes", "No"] };
  let created = 0;
  const create = () => ({ clientSendId: `attempt-${++created}` });

  const original = await store.getOrCreateScopedValue(scope, intent, create);
  assert.equal(await store.completeScopedValue(scope, () => true), true);
  const next = await store.getOrCreateScopedValue(scope, intent, create);

  assert.equal(original.clientSendId, "attempt-1");
  assert.equal(next.clientSendId, "attempt-2");
  assert.equal(created, 2);
});

test("a stale tab keeps its first id after another tab completes a later identical action", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const firstPins = new Map();
  const stalePins = new Map();
  const pinStorage = (pins) => ({
    getItem: (key) => pins.get(key) ?? null,
    setItem: (key, value) => pins.set(key, value),
    removeItem: (key) => pins.delete(key)
  });
  const first = createExternalActionAttemptStore(storage, undefined, pinStorage(firstPins));
  const stale = createExternalActionAttemptStore(storage, undefined, pinStorage(stalePins));
  const scope = "interleaved-identical-poll";
  const intent = { question: "Lunch?", options: ["Yes", "No"] };
  let created = 0;
  const create = () => ({ clientSendId: `attempt-${++created}` });

  const original = await first.getOrCreateScopedValue(scope, intent, create);
  assert.deepEqual(await stale.getOrCreateScopedValue(scope, intent, create), original);
  assert.equal(await first.completeScopedValue(scope, () => true), true);
  const second = await first.getOrCreateScopedValue(scope, intent, create);
  assert.equal(await first.completeScopedValue(scope, () => true), true);

  const staleAfterRemount = createExternalActionAttemptStore(
    storage,
    undefined,
    pinStorage(stalePins)
  );
  const staleRetry = await staleAfterRemount.getOrCreateScopedValue(scope, intent, create);

  assert.equal(original.clientSendId, "attempt-1");
  assert.equal(second.clientSendId, "attempt-2");
  assert.equal(staleRetry.clientSendId, "attempt-1");
  assert.equal(created, 2);
});

test("completing a stale generation does not overwrite the current shared generation", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const first = createExternalActionAttemptStore(storage);
  const stale = createExternalActionAttemptStore(storage);
  const scope = "stale-completion-after-new-generation";
  const key = `rios.external-action-attempt.v1:value:scoped:${scope}`;
  const intent = { question: "Lunch?", options: ["Yes", "No"] };
  let created = 0;
  const create = () => ({ clientSendId: `attempt-${++created}` });

  await first.getOrCreateScopedValue(scope, intent, create);
  await stale.getOrCreateScopedValue(scope, intent, create);
  await first.completeScopedValue(scope, () => true);
  const current = await first.getOrCreateScopedValue(scope, intent, create);
  await first.completeScopedValue(scope, () => true);

  assert.equal(
    await stale.completeScopedValue(
      scope,
      (value) => value.clientSendId === "attempt-1",
      true
    ),
    true
  );
  assert.equal(current.clientSendId, "attempt-2");
  assert.equal(values.get(key), undefined);
  assert.deepEqual(stale.readCompletedScopedValues(scope), [
    { clientSendId: "attempt-1" }
  ]);
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

test("an unresolved scoped action can be read after remount and completed actions stay hidden", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const scope = "composer-send:thread-a";
  const intent = { kind: "immediate", threadId: "thread-a", text: "Hello" };
  const value = { clientSendId: "send-1", sessionRevision: 1 };
  const first = createExternalActionAttemptStore(storage);
  await first.getOrCreateScopedValue(scope, intent, () => value);

  assert.deepEqual(createExternalActionAttemptStore(storage).readScopedAttempt(scope), {
    intent,
    value
  });

  await first.completeScopedValue(scope, (candidate) => candidate.clientSendId === "send-1");
  assert.equal(createExternalActionAttemptStore(storage).readScopedAttempt(scope), undefined);
  assert.equal(
    [...values.values()].some((persisted) => persisted.includes("Hello")),
    false
  );
});

test("a copied composer revision reuses its content-free completed send marker", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const scope = "composer-send:thread-a";
  const intent = { threadId: "thread-a", text: "Private copied reply" };
  const value = {
    clientSendId: "send-original",
    sessionRevision: 1,
    sessionRevisionId: "28d6bb4f-0fe9-4a94-8284-e5c166097c60"
  };
  const first = createExternalActionAttemptStore(storage);
  await first.getOrCreateScopedValue(scope, intent, () => value);
  await first.completeScopedValue(
    scope,
    (candidate) => candidate.clientSendId === value.clientSendId,
    true
  );

  let allocations = 0;
  const copiedTab = createExternalActionAttemptStore(storage);
  const reused = await copiedTab.getOrCreateScopedValue(
    scope,
    intent,
    () => {
      allocations += 1;
      return { ...value, clientSendId: "send-duplicate" };
    },
    async () => true,
    (candidate) => candidate.sessionRevisionId === value.sessionRevisionId
  );

  assert.equal(reused.clientSendId, "send-original");
  assert.equal(allocations, 0);
  assert.equal(
    [...values.values()].some((persisted) => persisted.includes("Private copied reply")),
    false
  );
  assert.deepEqual(copiedTab.readCompletedScopedValues(scope), [value]);
});

test("a completed composer marker is reused only for the same action semantics", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const scope = "composer-send:thread-semantics";
  const revisionId = "28d6bb4f-0fe9-4a94-8284-e5c166097c60";
  const immediateValue = {
    attemptKind: "immediate",
    clientSendId: "send-immediate",
    scheduledFor: null,
    sessionRevisionId: revisionId
  };
  const first = createExternalActionAttemptStore(storage);
  await first.getOrCreateScopedValue(
    scope,
    { kind: "immediate", scheduledFor: null, sessionRevisionId: revisionId },
    () => immediateValue
  );
  await first.completeScopedValue(scope, () => true, true);

  let allocations = 0;
  const scheduledFor = "2026-08-31T09:00:00.000Z";
  const scheduled = await createExternalActionAttemptStore(storage).getOrCreateScopedValue(
    scope,
    { kind: "scheduled", scheduledFor, sessionRevisionId: revisionId },
    () => {
      allocations += 1;
      return {
        attemptKind: "scheduled",
        clientSendId: "send-scheduled",
        scheduledFor,
        sessionRevisionId: revisionId
      };
    },
    async () => true,
    (candidate) =>
      candidate.sessionRevisionId === revisionId &&
      candidate.attemptKind === "scheduled" &&
      candidate.scheduledFor === scheduledFor
  );

  assert.equal(scheduled.clientSendId, "send-scheduled");
  assert.equal(allocations, 1);
});

test("a copied stale pin cannot suppress a later identical composer intent with a new revision", async () => {
  const values = new Map();
  const firstPins = new Map();
  const copiedPins = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const pinStorage = (pins) => ({
    getItem: (key) => pins.get(key) ?? null,
    setItem: (key, value) => pins.set(key, value),
    removeItem: (key) => pins.delete(key)
  });
  const scope = "composer-send:thread-a";
  const oldIntent = {
    composerIntent: { text: "Same words" },
    sessionRevisionId: "28d6bb4f-0fe9-4a94-8284-e5c166097c60"
  };
  const oldValue = {
    clientSendId: "send-original",
    sessionRevisionId: oldIntent.sessionRevisionId
  };
  const first = createExternalActionAttemptStore(
    storage,
    undefined,
    pinStorage(firstPins)
  );
  const copied = createExternalActionAttemptStore(
    storage,
    undefined,
    pinStorage(copiedPins)
  );

  await first.getOrCreateScopedValue(scope, oldIntent, () => oldValue);
  await copied.getOrCreateScopedValue(scope, oldIntent, () => oldValue);
  await first.completeScopedValue(scope, () => true, true);

  const newRevisionId = "9b35961d-a8fc-441d-986f-a2f366bcc9e3";
  const next = await copied.getOrCreateScopedValue(
    scope,
    {
      composerIntent: { text: "Same words" },
      sessionRevisionId: newRevisionId
    },
    () => ({ clientSendId: "send-new", sessionRevisionId: newRevisionId }),
    async () => true,
    (candidate) => candidate.sessionRevisionId === newRevisionId
  );

  assert.equal(next.clientSendId, "send-new");
});
