import test from "node:test";
import assert from "node:assert/strict";

import { createAiConsentCoordinator } from "../apps/runner/src/services/ai-consent-coordinator.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("AI disable intent blocks immediately and failed persistence restores durable consent", async () => {
  let enabled = true;
  const coordinator = createAiConsentCoordinator({
    getEnabled: async () => enabled
  });

  const reservation = coordinator.reserveMutation(false);
  assert.equal(coordinator.isEnabledForNewWork(), false);
  await assert.rejects(
    reservation.run(async () => {
      throw new Error("write failed");
    }),
    /write failed/
  );
  assert.equal(coordinator.isEnabledForNewWork(), true);
});

test("an older failed AI mutation cannot overwrite a newer consent intent", async () => {
  let enabled = true;
  const coordinator = createAiConsentCoordinator({ getEnabled: async () => enabled });
  const older = coordinator.reserveMutation(false);
  const newer = coordinator.reserveMutation(true);

  await older.cancel();
  assert.equal(coordinator.isEnabledForNewWork(), true);
  await newer.run(async () => { enabled = true; });
  assert.equal(coordinator.isEnabledForNewWork(), true);
});

test("a stale durable read cannot overwrite a newer AI opt-out", async () => {
  const entered = deferred();
  const release = deferred();
  const coordinator = createAiConsentCoordinator({
    getEnabled: async () => {
      entered.resolve();
      await release.promise;
      return true;
    }
  });

  const older = coordinator.reserveMutation(true);
  const cancelling = older.cancel();
  await entered.promise;
  coordinator.reserveMutation(false);
  release.resolve();
  await cancelling;

  assert.equal(coordinator.isEnabledForNewWork(), false);
});

test("a newer disable persists after an older running enable finishes", async () => {
  let durable = false;
  const olderEntered = deferred();
  const releaseOlder = deferred();
  const coordinator = createAiConsentCoordinator({ getEnabled: async () => durable });
  const older = coordinator.reserveMutation(true);
  const olderRun = older.run(async () => {
    olderEntered.resolve();
    await releaseOlder.promise;
    durable = true;
  });
  await olderEntered.promise;

  const newer = coordinator.reserveMutation(false);
  const newerRun = newer.run(async () => { durable = false; });
  releaseOlder.resolve();
  await Promise.all([olderRun, newerRun]);

  assert.equal(durable, false);
  assert.equal(coordinator.isEnabledForNewWork(), false);
});

test("cancel waits for older AI persistence before restoring durable consent", async () => {
  let durable = false;
  const olderEntered = deferred();
  const releaseOlder = deferred();
  const coordinator = createAiConsentCoordinator({ getEnabled: async () => durable });
  const older = coordinator.reserveMutation(true);
  const olderRun = older.run(async () => {
    olderEntered.resolve();
    await releaseOlder.promise;
    durable = true;
  });
  await olderEntered.promise;

  const newer = coordinator.reserveMutation(false);
  const cancelling = newer.cancel();
  releaseOlder.resolve();
  await Promise.all([olderRun, cancelling]);

  assert.equal(durable, true);
  assert.equal(coordinator.isEnabledForNewWork(), true);
});

test("a failed AI restore cannot publish a stale read over a newer opt-out", async () => {
  const restoreEntered = deferred();
  const releaseRestore = deferred();
  const coordinator = createAiConsentCoordinator({
    getEnabled: async () => {
      restoreEntered.resolve();
      await releaseRestore.promise;
      return true;
    }
  });
  const older = coordinator.reserveMutation(false);
  const olderRun = older.run(async () => {
    throw new Error("write failed");
  });
  await restoreEntered.promise;

  const newer = coordinator.reserveMutation(false);
  releaseRestore.resolve();
  await assert.rejects(olderRun, /write failed/);

  assert.equal(coordinator.isEnabledForNewWork(), false);
  await newer.run(async () => undefined);
});
