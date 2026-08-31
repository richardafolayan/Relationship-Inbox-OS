import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  completedPreferencesFromConflict,
  createSetupPreferenceWriteQueue,
  setupNavigationDisabled,
  persistCompletedSetup
} from "../apps/dashboard/lib/setup-preference-writes.ts";
import { nextSetupStepIfCurrent } from "../apps/dashboard/lib/setup-wizard.ts";

const setupWizardSource = readFileSync(
  new URL("../apps/dashboard/components/common/SetupWizard.tsx", import.meta.url),
  "utf8"
);

test("connection navigation stays disabled until the active connection request settles", () => {
  assert.match(setupWizardSource, /onBusyChange\(true\)/);
  assert.match(setupWizardSource, /<Back disabled=\{busy !== null\}/);
  assert.match(setupWizardSource, /<Primary disabled=\{busy !== null\} onClick=\{onNext\}>Continue/);
  assert.match(setupWizardSource, /finishing \|\| savingPreferences \|\| connectingSource/);
  assert.match(setupWizardSource, /connectingSource \|\| stepBusy/);
  assert.match(setupWizardSource, /<Back disabled=\{busy\} onClick=\{onBack\}/);
});

test("a deferred step success cannot advance after navigation moved elsewhere", () => {
  const steps = ["welcome", "profile", "sources", "connect"];
  assert.equal(nextSetupStepIfCurrent("profile", "profile", steps), "sources");
  assert.equal(nextSetupStepIfCurrent("welcome", "profile", steps), "welcome");
});

test("a lost transcription response refreshes authoritative download status", () => {
  assert.match(setupWizardSource, /try \{\s*await refresh\(\);/);
  assert.match(setupWizardSource, /phase: "downloading"/);
});

test("Gemini key activation carries the current setup revision", () => {
  assert.match(setupWizardSource, /expectedRevision: preferenceWriter\.latestRevision\(\)/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("setup preference writes run in intent order and use the latest authoritative revision", async () => {
  const first = deferred();
  const calls = [];
  const queue = createSetupPreferenceWriteQueue(4, async (payload) => {
    calls.push(payload);
    if (calls.length === 1) return first.promise;
    return {
      selectedPlatforms: ["LINKEDIN"],
      aiEnabled: true,
      transcriptionMode: "off",
      startedAt: "start",
      completedAt: "",
      revision: 6
    };
  });

  const started = queue.save({ startedAt: "start" });
  const enabled = queue.save({ aiEnabled: true });
  await Promise.resolve();

  assert.deepEqual(calls, [{ startedAt: "start", expectedRevision: 4 }]);
  first.resolve({
    selectedPlatforms: ["LINKEDIN"],
    aiEnabled: false,
    transcriptionMode: "off",
    startedAt: "start",
    completedAt: "",
    revision: 5
  });

  const firstResult = await started;
  const secondResult = await enabled;
  assert.equal(firstResult.applied, true);
  assert.equal(secondResult.applied, true);
  assert.deepEqual(calls, [
    { startedAt: "start", expectedRevision: 4 },
    { aiEnabled: true, expectedRevision: 5 }
  ]);
  assert.equal(queue.latestRevision(), 6);
});

test("a failed setup preference write does not poison the queue or advance its revision", async () => {
  const calls = [];
  const queue = createSetupPreferenceWriteQueue(2, async (payload) => {
    calls.push(payload);
    if (calls.length === 1) throw new Error("disk full");
    return {
      selectedPlatforms: [],
      aiEnabled: true,
      transcriptionMode: "off",
      startedAt: "",
      completedAt: "",
      revision: 3
    };
  });

  await assert.rejects(queue.save({ startedAt: "start" }), /disk full/);
  const recovered = await queue.save({ aiEnabled: true });

  assert.equal(recovered.applied, true);
  assert.deepEqual(calls, [
    { startedAt: "start", expectedRevision: 2 },
    { aiEnabled: true, expectedRevision: 2 }
  ]);
  assert.equal(queue.latestRevision(), 3);
});

test("an older setup snapshot cannot replace newer authoritative preferences", () => {
  const queue = createSetupPreferenceWriteQueue(0, async () => {
    throw new Error("unused");
  });

  assert.equal(queue.acceptSnapshot({ revision: 8 }), true);
  assert.equal(queue.acceptSnapshot({ revision: 7 }), false);
  assert.equal(queue.acceptSnapshot({ revision: 8 }), true);
  assert.equal(queue.latestRevision(), 8);
});

test("setup completion is marked locally only after the atomic server write succeeds", async () => {
  const events = [];
  const preferences = await persistCompletedSetup({
    completedAt: "done",
    persistCompletion: async () => {
      events.push("server");
      return { revision: 8, completedAt: "done" };
    },
    markComplete: () => events.push("local")
  });
  assert.deepEqual(events, ["server", "local"]);
  assert.equal(preferences.revision, 8);
});

test("the review action persists completion before the ready screen is shown", () => {
  assert.match(setupWizardSource, /onFinish=\{async \(\) => \{ if \(await finish\(false\)\) next\(\); \}\}/);
  assert.match(setupWizardSource, /function ReviewStep\([^)]*onFinish/);
  assert.match(setupWizardSource, /onClick=\{\(\) => void onFinish\(\)\}/);
  assert.doesNotMatch(setupWizardSource, /step === "done"[\s\S]*?void finish\(\)/);
});

test("a failed atomic completion leaves local setup incomplete", async () => {
  const events = [];
  await assert.rejects(
    persistCompletedSetup({
      completedAt: "done",
      persistCompletion: async () => {
        events.push("server");
        throw new Error("offline");
      },
      markComplete: () => events.push("local")
    }),
    /offline/
  );
  assert.deepEqual(events, ["server"]);
});

test("local completion cache failure cannot undo authoritative server completion", async () => {
  const preferences = await persistCompletedSetup({
    completedAt: "done",
    persistCompletion: async () => ({ revision: 8, completedAt: "done" }),
    markComplete: () => {
      throw new Error("storage denied");
    }
  });
  assert.deepEqual(preferences, { revision: 8, completedAt: "done" });
});

test("an authoritative completed conflict is semantic completion success", () => {
  const completed = { revision: 9, completedAt: "done" };
  assert.deepEqual(completedPreferencesFromConflict(409, { preferences: completed }), completed);
  assert.equal(completedPreferencesFromConflict(409, { preferences: { revision: 9, completedAt: "" } }), null);
  assert.equal(completedPreferencesFromConflict(500, { preferences: completed }), null);
});

test("transcription navigation and removal stay disabled through writes and downloads", () => {
  assert.equal(setupNavigationDisabled(false, "idle"), false);
  assert.equal(setupNavigationDisabled(true, "idle"), true);
  assert.equal(setupNavigationDisabled(false, "downloading"), true);
});

test("an authoritative side-endpoint snapshot rebases the next queued write", async () => {
  const calls = [];
  const queue = createSetupPreferenceWriteQueue(3, async (payload) => {
    calls.push(payload);
    return {
      revision: 5,
      selectedPlatforms: [],
      aiEnabled: true,
      transcriptionMode: "standard",
      startedAt: "start",
      completedAt: ""
    };
  });

  assert.equal(queue.acceptSnapshot({ revision: 4 }), true);
  await queue.save({ completedAt: "done" });

  assert.deepEqual(calls, [{ completedAt: "done", expectedRevision: 4 }]);
  assert.equal(queue.latestRevision(), 5);
});
