import test from "node:test";
import assert from "node:assert/strict";
import { runReassessForThread } from "../apps/runner/dist/services/reassess-thread.js";

// BUG PM11. iMessage splits one Person across handle-specific sibling threads.
// AI fields (rollingSummary / whatTheyWant) are persisted per-row, so a dormant
// sibling (e.g. an old phone-handle chat) carries STALE values while the live
// email-handle sibling carries fresh ones. runReassessForThread already targets
// the canonical (most-recent-inbound) sibling for the summary refresh + category
// write, but classifyThreadCategory was fed the REQUESTED row's summary /
// whatTheyWant. Reassessing the dormant phone sibling therefore steered the
// classifier with stale context, then persisted the (wrong) category to the
// canonical row.
//
// This test pins the classifier inputs to the CANONICAL sibling's values.
// Self-contained stubs in the style of runner-reassess-thread-race.test.mjs.

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

function makeDeps({ threadRow, classifyResult = "genuine", siblingIds, siblingRows, mergedMessages } = {}) {
  const calls = {
    resummarize: [],
    classifyThreadCategory: [],
    update: []
  };
  const deps = {
    prisma: {
      thread: {
        async findUnique() {
          return threadRow ?? makeThreadRow();
        },
        async findMany() {
          return siblingRows ?? [];
        },
        async update(args) {
          calls.update.push(args);
          return { id: args.where.id };
        }
      },
      message: {
        async findMany() {
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
    async siblingThreadIds() {
      return siblingIds ?? ["thread-1"];
    },
    async resummarize(threadId, options) {
      calls.resummarize.push({ threadId, options });
      return {
        ok: true,
        summary: "fresh summary",
        whatTheyWant: "fresh what they want",
        openLoops: ["follow up about thing"],
        needsReply: true
      };
    }
  };
  return { deps, calls };
}

test("runReassessForThread (iMessage) classifies off the CANONICAL sibling's summary/whatTheyWant, not the requested dormant row", async () => {
  // Reassess invoked on the dormant high-message-count phone row. The classifier
  // prompt must be built from the LIVE email sibling's fresh AI fields, not the
  // phone row's stale ones.
  const mergedMessages = [
    { direction: "IN", text: "fresh email msg", timestamp: new Date("2026-06-05T13:25:00Z"), audioTranscription: null },
    { direction: "IN", text: "older phone msg", timestamp: new Date("2026-06-04T14:50:00Z"), audioTranscription: null }
  ];
  const { deps, calls } = makeDeps({
    threadRow: makeThreadRow({
      id: "imsg-phone",
      platform: "IMESSAGE",
      personId: "serena",
      person: { displayName: "Serena" },
      // Stale values on the requested (dormant phone) row.
      rollingSummary: "STALE phone summary — months out of date",
      whatTheyWant: "STALE phone ask"
    }),
    siblingIds: ["imsg-phone", "imsg-email"],
    siblingRows: [
      {
        id: "imsg-phone",
        lastInboundAt: new Date("2026-06-04T14:50:00Z"),
        rollingSummary: "STALE phone summary — months out of date",
        whatTheyWant: "STALE phone ask",
        _count: { messages: 7313 }
      },
      {
        id: "imsg-email",
        lastInboundAt: new Date("2026-06-05T13:25:00Z"),
        rollingSummary: "FRESH email summary — the live conversation",
        whatTheyWant: "FRESH email ask",
        _count: { messages: 345 }
      }
    ],
    mergedMessages
  });

  const outcome = await runReassessForThread(deps, "imsg-phone");
  assert.equal(outcome.kind, "ok");

  // The category write lands on the canonical (live email) sibling.
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].where.id, "imsg-email");

  // Core assertion: the classifier prompt was built from the CANONICAL
  // sibling's fresh AI fields, NOT the requested dormant phone row's stale
  // ones. Before the fix these were thread.rollingSummary / thread.whatTheyWant
  // (the phone row), so this failed.
  assert.equal(calls.classifyThreadCategory.length, 1);
  assert.equal(
    calls.classifyThreadCategory[0].summary,
    "FRESH email summary — the live conversation"
  );
  assert.equal(calls.classifyThreadCategory[0].whatTheyWant, "FRESH email ask");
});

test("runReassessForThread (single-sibling iMessage) classifies off the requested row's own summary/whatTheyWant", async () => {
  // One handle only: the requested row IS the canonical row, so its values
  // drive the classifier and no sibling override happens.
  const { deps, calls } = makeDeps({
    threadRow: makeThreadRow({
      id: "solo",
      platform: "IMESSAGE",
      personId: "p1",
      rollingSummary: "solo summary",
      whatTheyWant: "solo ask"
    }),
    siblingIds: ["solo"]
  });
  const outcome = await runReassessForThread(deps, "solo");
  assert.equal(outcome.kind, "ok");
  assert.equal(calls.classifyThreadCategory.length, 1);
  assert.equal(calls.classifyThreadCategory[0].summary, "solo summary");
  assert.equal(calls.classifyThreadCategory[0].whatTheyWant, "solo ask");
});
