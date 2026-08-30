import test from "node:test";
import assert from "node:assert/strict";

import { createAiConsentCoordinator } from "../apps/runner/src/services/ai-consent-coordinator.ts";

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
