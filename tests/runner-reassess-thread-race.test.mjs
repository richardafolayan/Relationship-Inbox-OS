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
  classifyResult = "genuine",
  // iMessage sibling-merge fixtures. Only exercised by IMESSAGE threads; the
  // LINKEDIN tests never call these stubs (the service guards them behind the
  // platform check), so existing behaviour is unchanged.
  siblingIds,
  siblingRows,
  mergedMessages
} = {}) {
  const calls = {
    resummarize: [],
    findUnique: [],
    update: [],
    classifyThreadCategory: [],
    siblingThreadIds: [],
    threadFindMany: [],
    messageFindMany: []
  };
  const deps = {
    prisma: {
      thread: {
        async findUnique(args) {
          calls.findUnique.push(args);
          return threadRow ?? makeThreadRow();
        },
        async findMany(args) {
          calls.threadFindMany.push(args);
          return siblingRows ?? [];
        },
        async update(args) {
          calls.update.push(args);
          return { id: args.where.id };
        }
      },
      message: {
        async findMany(args) {
          calls.messageFindMany.push(args);
          return mergedMessages ?? [];
        }
      }
    },
    aiService: {
      async classifyThreadCategory(input) {
        calls.classifyThreadCategory.push(input);
        return classifyResult;
      }
    },
    async siblingThreadIds(platform, personId) {
      calls.siblingThreadIds.push({ platform, personId });
      return siblingIds ?? ["thread-1"];
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

test("runReassessForThread surfaces a resummarise not_found and skips the write", async () => {
  const { deps, calls } = makeDeps({
    resummariseResult: { ok: false, reason: "not_found" }
  });
  const outcome = await runReassessForThread(deps, "thread-1");
  assert.equal(outcome.kind, "not_found");
  // The summary + classify now run concurrently, so the parallel category
  // result is simply discarded; the load-bearing guarantee is that NO
  // summary/category write happens when resummarise reports the thread gone.
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

test("runReassessForThread (iMessage) redirects resummarize + writes to the CANONICAL sibling and classifies merged messages", async () => {
  // Serena bug: reassess invoked on the dormant high-message-count phone row
  // must refresh the LIVE email sibling (the row the readers consult) and
  // classify over the merged sibling messages, not just the phone row's.
  const mergedMessages = [
    { direction: "IN", text: "fresh email msg", timestamp: new Date("2026-06-05T13:25:00Z"), audioTranscription: null },
    { direction: "IN", text: "older phone msg", timestamp: new Date("2026-06-04T14:50:00Z"), audioTranscription: null }
  ];
  const { deps, calls } = makeDeps({
    threadRow: makeThreadRow({
      id: "imsg-phone",
      platform: "IMESSAGE",
      personId: "serena",
      person: { displayName: "Serena" }
    }),
    siblingIds: ["imsg-phone", "imsg-email"],
    siblingRows: [
      { id: "imsg-phone", lastInboundAt: new Date("2026-06-04T14:50:00Z"), _count: { messages: 7313 } },
      { id: "imsg-email", lastInboundAt: new Date("2026-06-05T13:25:00Z"), _count: { messages: 345 } }
    ],
    mergedMessages
  });

  const outcome = await runReassessForThread(deps, "imsg-phone");
  assert.equal(outcome.kind, "ok");

  // Resolved siblings for the iMessage Person.
  assert.equal(calls.siblingThreadIds.length, 1);
  assert.deepEqual(calls.siblingThreadIds[0], { platform: "IMESSAGE", personId: "serena" });

  // Resummarize targets the canonical (live email) sibling, NOT the requested
  // phone row, even though the phone row has far more messages.
  assert.equal(calls.resummarize.length, 1);
  assert.equal(calls.resummarize[0].threadId, "imsg-email");

  // Cache burn / category write lands on the canonical sibling too.
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].where.id, "imsg-email");
  assert.equal(calls.update[0].data.suggestedRepliesJson, null);
  assert.equal(calls.update[0].data.suggestedRepliesCacheKey, null);

  // The classifier saw the MERGED sibling messages (both handle chats).
  assert.equal(calls.classifyThreadCategory.length, 1);
  const classifiedTexts = calls.classifyThreadCategory[0].messages.map((m) => m.text);
  assert.ok(classifiedTexts.includes("fresh email msg"), "merged messages include the email turn");
  assert.ok(classifiedTexts.includes("older phone msg"), "merged messages include the phone turn");
});

test("runReassessForThread (single-thread iMessage) skips the sibling merge and behaves like before", async () => {
  // One handle only: no extra queries, resummarize + write target the row
  // itself. Guards against the sibling path firing for the common case.
  const { deps, calls } = makeDeps({
    threadRow: makeThreadRow({ id: "solo", platform: "IMESSAGE", personId: "p1" }),
    siblingIds: ["solo"]
  });
  const outcome = await runReassessForThread(deps, "solo");
  assert.equal(outcome.kind, "ok");
  assert.equal(calls.resummarize[0].threadId, "solo");
  assert.equal(calls.update[0].where.id, "solo");
  // No merged-message or sibling-row queries when there's a single sibling.
  assert.equal(calls.threadFindMany.length, 0);
  assert.equal(calls.messageFindMany.length, 0);
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
