import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExternalActionAttemptStore } from "../apps/dashboard/lib/external-action-attempts.ts";

const source = await readFile(
  new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
  "utf8"
);

test("message mutations keep one client action id across an uncertain retry", () => {
  assert.match(source, /createExternalActionAttemptStore\(\)/);
  for (const action of ["send-poll", "reaction", "poll-vote", "edit"]) {
    assert.match(source, new RegExp("attemptKey = `" + action + ":"));
  }
  assert.equal((source.match(/externalActionAttempts\.getOrCreate\(attemptKey, uuid\)/g) ?? []).length, 4);
  assert.equal((source.match(/\{ clientActionId,/g) ?? []).length >= 3, true);
  assert.equal((source.match(/externalActionAttempts\.completeIfReconciled\(/g) ?? []).length, 4);
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
