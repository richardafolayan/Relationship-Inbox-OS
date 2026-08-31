import test from "node:test";
import assert from "node:assert/strict";

import { createTextRefinementService } from "../apps/runner/src/services/transcription/text-refinement-service.ts";

const context = {
  messageId: "message-1",
  threadId: "thread-1",
  direction: "IN",
  speakerRole: "contact",
  attempts: [{ tier: "standard", model: "local", transcript: "private transcript" }],
  nearbyMessages: [{ direction: "OUT", timestamp: "12:00", text: "private context" }]
};

test("AI-off blocks text refinement at the physical provider boundary", async () => {
  let providerCalls = 0;
  const service = createTextRefinementService({
    client: {
      chat: { completions: { async create() {
        providerCalls += 1;
        return { choices: [{ message: { content: "{}" } }] };
      } } }
    },
    canDispatch: async () => false,
    config: { model: "gpt-5-nano", timeoutMs: 1000 }
  });

  const outcome = await service.refine(context);
  assert.equal(outcome.kind, "skipped");
  assert.equal(providerCalls, 0);
});

test("source revocation blocks text refinement after context preparation", async () => {
  let providerCalls = 0;
  let dispatchChecks = 0;
  let allowed = true;
  const service = createTextRefinementService({
    client: {
      chat: { completions: { async create() {
        providerCalls += 1;
        return { choices: [{ message: { content: "{}" } }] };
      } } }
    },
    canDispatch: async () => {
      dispatchChecks += 1;
      return true;
    },
    config: { model: "gpt-5-nano", timeoutMs: 1000 }
  });
  allowed = false;

  const outcome = await service.refine(context, () => allowed);
  assert.equal(outcome.kind, "skipped");
  assert.equal(dispatchChecks, 0);
  assert.equal(providerCalls, 0);
});
