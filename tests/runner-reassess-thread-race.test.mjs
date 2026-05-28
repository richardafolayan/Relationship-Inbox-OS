import test from "node:test";
import assert from "node:assert/strict";
import { runReassessForThread } from "../apps/runner/dist/services/reassess-thread.js";

// Issue #382 / pilot R-0029. Behavioural test for the reassess
// pipeline's race wiring. The companion source-level scope test
// (runner-reassess-race-scope.test.mjs) proves race: true does not
// appear in scan paths; this test proves it actually flows through to
// BOTH AI calls when the reassess service is invoked.
//
// Stubs prisma + aiService + the resummarize callback. The point is
// to record what arguments each receives — the underlying race
// helper's behaviour is unit-tested at runner-ai-race.test.mjs.

function makeThreadRow(overrides = {}) {
  return {
    id: "thread-1",
    platform: "LINKEDIN",
    rollingSummary: "previous summary",
    whatTheyWant: "previous what they want",
    category: "genuine",
    person: { displayName: "Test Person" },
    messages: [
      {
        direction: "IN",
        text: "hello",
        timestamp: new Date("2026-05-28T10:00:00Z"),
        audioTranscription: null
      }
    ],
    ...overrides
  };
}

function makeDeps({
  resummariseResult,
  threadRow,
  classifyResult = "genuine"
} = {}) {
  const calls = {
    resummarize: [],
    findUnique: [],
    update: [],
    classifyThreadCategory: []
  };
  const deps = {
    prisma: {
      thread: {
        async findUnique(args) {
          calls.findUnique.push(args);
          return threadRow ?? makeThreadRow();
        },
        async update(args) {
          calls.update.push(args);
          return { id: args.where.id };
        }
      }
    },
    aiService: {
      async classifyThreadCategory(input) {
        calls.classifyThreadCategory.push(input);
        return classifyResult;
      }
    },
    async resummarize(threadId, options) {
      calls.resummarize.push({ threadId, options });
      return (
        resummariseResult ?? {
          ok: true,
          summary: "fresh summary",
          whatTheyWant: "fresh what they want",
          openLoops: ["follow up about thing"],
          needsReply: true
        }
      );
    }
  };
  return { deps, calls };
}

test("runReassessForThread passes race: true to the resummarise call", async () => {
  const { deps, calls } = makeDeps();
  await runReassessForThread(deps, "thread-1");
  assert.equal(calls.resummarize.length, 1);
  assert.deepEqual(calls.resummarize[0].options, { race: true });
});

test("runReassessForThread passes race: true to classifyThreadCategory", async () => {
  const { deps, calls } = makeDeps();
  await runReassessForThread(deps, "thread-1");
  assert.equal(calls.classifyThreadCategory.length, 1);
  assert.equal(calls.classifyThreadCategory[0].race, true);
});

test("runReassessForThread returns the classifier's result, not the existing thread.category", async () => {
  const { deps } = makeDeps({
    threadRow: makeThreadRow({ category: "genuine" }),
    classifyResult: "outreach"
  });
  const outcome = await runReassessForThread(deps, "thread-1");
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.category, "outreach");
});

test("runReassessForThread falls back to the existing category when classify returns null", async () => {
  const { deps } = makeDeps({
    threadRow: makeThreadRow({ category: "genuine" }),
    classifyResult: null
  });
  const outcome = await runReassessForThread(deps, "thread-1");
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.category, "genuine");
});

test("runReassessForThread surfaces a missing thread as not_found (resummarise failure)", async () => {
  const { deps, calls } = makeDeps({
    resummariseResult: { ok: false, reason: "not_found" }
  });
  const outcome = await runReassessForThread(deps, "thread-1");
  assert.equal(outcome.kind, "not_found");
  // No further work happens after resummarise reports not_found.
  assert.equal(calls.findUnique.length, 0);
  assert.equal(calls.classifyThreadCategory.length, 0);
  assert.equal(calls.update.length, 0);
});

test("runReassessForThread surfaces a missing thread as not_found (prisma findUnique returns null)", async () => {
  const { deps, calls } = makeDeps({ threadRow: null });
  // Inject the null override on the findUnique stub directly so the
  // makeThreadRow fallback doesn't kick in.
  deps.prisma.thread.findUnique = async () => null;
  const outcome = await runReassessForThread(deps, "thread-1");
  assert.equal(outcome.kind, "not_found");
  assert.equal(calls.classifyThreadCategory.length, 0);
  assert.equal(calls.update.length, 0);
});

test("runReassessForThread burns the suggested-replies cache on success", async () => {
  const { deps, calls } = makeDeps();
  await runReassessForThread(deps, "thread-1");
  assert.equal(calls.update.length, 1);
  const updateData = calls.update[0].data;
  // Cache fields must be cleared so the next /data/thread fetch
  // regenerates against the new summary / category.
  assert.equal(updateData.suggestedRepliesCacheKey, null);
  assert.equal(updateData.suggestedRepliesJson, null);
  // Category writes through when classifier returned a value.
  assert.equal(updateData.category, "genuine");
});

test("runReassessForThread tolerates a classifier exception (treats it as null)", async () => {
  const { deps, calls } = makeDeps();
  deps.aiService.classifyThreadCategory = async () => {
    throw new Error("boom");
  };
  const outcome = await runReassessForThread(deps, "thread-1");
  assert.equal(outcome.kind, "ok");
  // The thread row had category: "genuine" so the existing value
  // bubbles through when classification fails.
  assert.equal(outcome.category, "genuine");
  // Cache burn still runs even when classifier blew up.
  assert.equal(calls.update.length, 1);
});
