import test from "node:test";
import assert from "node:assert/strict";

import { runnerConfig } from "../apps/runner/src/config.ts";
import { createAiService } from "../apps/runner/src/services/ai.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const message = {
  direction: "IN",
  text: "Can you send the details?",
  timestamp: "2026-08-30T10:00:00.000Z"
};

function summaryInput(extra = {}) {
  return {
    displayName: "Alex",
    previousSummary: "Alex asked about the project.",
    previousOpenLoops: ["Send the details"],
    previousRemember: [],
    messages: [message],
    needsReply: true,
    ...extra
  };
}

async function withConfiguredGemini(work) {
  const previous = {
    geminiApiKey: runnerConfig.geminiApiKey,
    openAiApiKey: runnerConfig.openAiApiKey,
    zAiApiKey: runnerConfig.zAiApiKey,
    aiProvider: runnerConfig.aiProvider
  };
  runnerConfig.geminiApiKey = "configured-test-key";
  runnerConfig.openAiApiKey = undefined;
  runnerConfig.zAiApiKey = undefined;
  runnerConfig.aiProvider = "gemini";
  try {
    await work();
  } finally {
    Object.assign(runnerConfig, previous);
  }
}

test("AI disabled blocks every provider path even when credentials are configured", async () => {
  await withConfiguredGemini(async () => {
    let transportCalls = 0;
    const ai = createAiService({
      getSettings: async () => ({ aiEnabled: false, aiProvider: "gemini" }),
      getOperatorProfile: async () => ({ displayName: "Richard" })
    }, {
      fetchImpl: async () => {
        transportCalls += 1;
        throw new Error("provider transport must not run");
      }
    });

    await ai.updateThreadSummary(summaryInput());
    await ai.classifyThreadCategory({
      platform: "LINKEDIN",
      displayName: "Alex",
      messages: [message]
    });

    assert.equal(transportCalls, 0);
  });
});

test("a revoked selection epoch stops summary disclosure at the provider boundary", async () => {
  await withConfiguredGemini(async () => {
    const enteredProfileRead = deferred();
    const releaseProfileRead = deferred();
    let allowed = true;
    let transportCalls = 0;
    const ai = createAiService({
      getSettings: async () => ({ aiEnabled: true, aiProvider: "gemini" }),
      getOperatorProfile: async () => {
        enteredProfileRead.resolve();
        await releaseProfileRead.promise;
        return { displayName: "Richard" };
      }
    }, {
      fetchImpl: async () => {
        transportCalls += 1;
        throw new Error("provider transport must not run after revocation");
      }
    });

    const running = ai.updateThreadSummary(summaryInput({
      shouldContinue: () => allowed
    }));
    await enteredProfileRead.promise;
    allowed = false;
    releaseProfileRead.resolve();
    await running;

    assert.equal(transportCalls, 0);
  });
});
