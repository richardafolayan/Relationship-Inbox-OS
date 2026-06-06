import test from "node:test";
import assert from "node:assert/strict";

// Bug Q2 (data-loss). The bulk backfill (reassess-all-threads.ts) and the
// live Reassess endpoint both persist whatever updateThreadSummary returns.
// When EVERY AI provider fails at runtime (expired key, network outage,
// rate-limit, provider 5xx) the call does NOT throw — modelJson returns the
// caller fallback with `source.providerId === null`. The old resummarizeThread
// wrote that degraded fallback ("Conversation with {name}." + the raw last
// inbound) over the real summary; with --from-scratch the prior summary/loops
// are dropped too, so a single failed run could flatten every thread.
//
// Fix: resummarizeThread treats a fallback result as a FAILURE and SKIPS the
// prisma.thread.update. The signal is the AiSource the AI call now surfaces
// on SummaryOutput (source absent OR source.providerId === null), mirroring
// the validator raceModelJson already uses internally.
//
// Tested against the compiled dist, like the other runner-* tests.
const { resummarizeThread } = await import(
  "../apps/runner/dist/services/resummarize-thread.js"
);

function msg(id, overrides = {}) {
  return {
    id,
    direction: "IN",
    text: "hello",
    timestamp: new Date("2026-05-29T10:00:00.000Z"),
    rawJson: null,
    audioTranscription: null,
    ...overrides
  };
}

const baseThread = {
  id: "t1",
  platform: "LINKEDIN",
  personId: "p1",
  person: { displayName: "Jo" },
  rollingSummary: "old durable summary",
  openLoopsJson: JSON.stringify(["confirm Friday"]),
  rememberJson: JSON.stringify([{ note: "Trip to Lagos", date: null }]),
  lastInboundAt: new Date("2026-05-29T09:00:00.000Z"),
  lastOutboundAt: null
};

// A real provider source — what a SUCCESSFUL AI call attaches.
const REAL_SOURCE = {
  providerId: "openai",
  providerDisplayName: "OpenAI",
  fellBackFromProviderId: null,
  fellBackFromProviderDisplayName: null,
  fellBackReason: null,
  fellBackMessage: null
};

// The fallback source modelJson attaches when every provider is exhausted.
const FALLBACK_SOURCE = {
  providerId: null,
  providerDisplayName: null,
  fellBackFromProviderId: "openai",
  fellBackFromProviderDisplayName: "OpenAI",
  fellBackReason: "auth",
  fellBackMessage: "401 incorrect api key"
};

const GOOD_SUMMARY = {
  summary: "Fresh summary",
  what_they_want: "Wants a call",
  open_loops: ["confirm Friday"],
  tone_notes: [],
  remember: [],
  reply_brief: null,
  needs_reply: true,
  source: REAL_SOURCE
};

// What updateThreadSummary returns when the provider chain is exhausted: the
// degraded fallback fields, carrying the null-provider source.
const FALLBACK_SUMMARY = {
  summary: "Conversation with Jo.",
  what_they_want: "hello",
  open_loops: [],
  tone_notes: [],
  remember: [],
  reply_brief: null,
  needs_reply: true,
  source: FALLBACK_SOURCE
};

function makeFakePrisma({ thread, messages }) {
  const calls = { findUnique: 0, findMany: 0, threadUpdate: [], updateMany: [], transaction: [] };
  const prisma = {
    thread: {
      async findUnique() {
        calls.findUnique += 1;
        return thread;
      },
      async update(args) {
        calls.threadUpdate.push(args);
        return { id: args.where.id };
      }
    },
    message: {
      async findMany() {
        calls.findMany += 1;
        return messages;
      }
    },
    messageAudioTranscription: {
      async updateMany(args) {
        calls.updateMany.push(args);
        return { count: args.where.messageId.in.length };
      }
    },
    async $transaction(ops) {
      calls.transaction.push(ops.length);
      return Promise.all(ops);
    }
  };
  return { prisma, calls };
}

function makeAi(result) {
  const aiCalls = [];
  return {
    aiService: {
      async updateThreadSummary(input) {
        aiCalls.push(input);
        return result;
      }
    },
    aiCalls
  };
}

const siblingThreadIds = async () => ["t1"];

test("resummarizeThread: a real-provider summary is persisted as before", async () => {
  const messages = [msg("m1", { text: "hi" })];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const { aiService } = makeAi(GOOD_SUMMARY);

  const result = await resummarizeThread({ prisma, aiService, siblingThreadIds }, "t1", { race: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary, "Fresh summary");
  assert.equal(calls.threadUpdate.length, 1);
  assert.equal(calls.threadUpdate[0].data.rollingSummary, "Fresh summary");
});

test("resummarizeThread: a fallback result (provider chain exhausted) writes NOTHING and reports failure", async () => {
  const messages = [msg("m1", { text: "hello" })];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const { aiService } = makeAi(FALLBACK_SUMMARY);

  const result = await resummarizeThread({ prisma, aiService, siblingThreadIds }, "t1", { race: true });

  // Counts as a failure the caller can surface / exit non-zero on.
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ai_unavailable");
  // The crucial invariant: the real summary on disk is NOT overwritten.
  assert.equal(calls.threadUpdate.length, 0);
  assert.equal(calls.transaction.length, 0);
  assert.equal(calls.updateMany.length, 0);
});

test("resummarizeThread: a result with NO source at all is also treated as a fallback (defensive)", async () => {
  // A legacy/mocked AI service that returns the right shape but omits source
  // must not be mistaken for a successful provider call.
  const messages = [msg("m1", { text: "hello" })];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const noSource = { ...GOOD_SUMMARY };
  delete noSource.source;
  const { aiService } = makeAi(noSource);

  const result = await resummarizeThread({ prisma, aiService, siblingThreadIds }, "t1", { race: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "ai_unavailable");
  assert.equal(calls.threadUpdate.length, 0);
});

test("resummarizeThread (from-scratch): a fallback still writes nothing — the destructive path is guarded", async () => {
  // --from-scratch drops the prior summary/loops, so a persisted fallback here
  // would be the bare "Conversation with Jo." with no recovery. Must be blocked.
  const messages = [msg("m1", { text: "hello" })];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const { aiService, aiCalls } = makeAi(FALLBACK_SUMMARY);

  const result = await resummarizeThread(
    { prisma, aiService, siblingThreadIds },
    "t1",
    { fromScratch: true }
  );

  // fromScratch threaded through (prior summary dropped from the prompt input).
  assert.equal(aiCalls[0].previousSummary, undefined);
  assert.deepEqual(aiCalls[0].previousOpenLoops, []);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ai_unavailable");
  assert.equal(calls.threadUpdate.length, 0);
});
