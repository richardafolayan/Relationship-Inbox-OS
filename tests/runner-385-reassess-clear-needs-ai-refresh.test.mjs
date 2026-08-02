import test from "node:test";
import assert from "node:assert/strict";

// Issue #385: a successful Reassess (and the background self-heal that shares
// the same pipeline) must clear `needsAiRefresh` on the audio transcripts that
// fed the new summary, in the SAME transaction as the summary write, and clear
// nothing on a failed / missing-thread run. Tested against the compiled dist,
// like the other runner-* tests.
const { resummarizeThread, transcriptionMessageIdsToRefresh } = await import(
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

function transcript(needsAiRefresh, status = "transcribed", transcriptText = "voice transcript") {
  return { status, transcript: transcriptText, needsAiRefresh };
}

// ---- Targeting helper (PM tests 1 + 2) ---------------------------------

test("transcriptionMessageIdsToRefresh: only AI-visible messages whose transcript was upgraded", () => {
  const messages = [
    // voice-only bubble, transcript upgraded since last summary -> include
    msg("m1", { text: "", audioTranscription: transcript(true) }),
    // plain text, no transcription at all -> exclude
    msg("m2", { text: "hey there", audioTranscription: null }),
    // has a transcript but the flag isn't set -> exclude
    msg("m3", { text: "ok", audioTranscription: transcript(false) }),
    // flag set, but not AI-visible (pending, empty text, no usable transcript) -> exclude
    msg("m4", { text: "", audioTranscription: transcript(true, "pending", null) }),
    // flag set, but the body is an iMessage "kept an audio message" system event -> exclude
    msg("m5", {
      text: "Sarah kept an audio message from you.",
      audioTranscription: transcript(true)
    }),
    // text turn that also carries an upgraded voice transcript -> include
    msg("m6", { text: "thanks!", audioTranscription: transcript(true) })
  ];
  assert.deepEqual(transcriptionMessageIdsToRefresh(messages), ["m1", "m6"]);
});

test("transcriptionMessageIdsToRefresh: empty when nothing was upgraded", () => {
  const messages = [
    msg("m1", { text: "hi", audioTranscription: null }),
    msg("m2", { text: "ok", audioTranscription: transcript(false) })
  ];
  assert.deepEqual(transcriptionMessageIdsToRefresh(messages), []);
});

// ---- Pipeline (PM tests 3 + 4) -----------------------------------------

const baseThread = {
  id: "t1",
  platform: "LINKEDIN",
  personId: "p1",
  person: { displayName: "Jo" },
  rollingSummary: "old summary",
  openLoopsJson: null,
  rememberJson: null,
  lastInboundAt: new Date("2026-05-29T09:00:00.000Z"),
  lastOutboundAt: null,
  updatedAt: new Date("2026-05-29T09:01:00.000Z")
};

const SUMMARY = {
  summary: "Fresh summary",
  what_they_want: "Wants a call",
  open_loops: ["confirm Friday"],
  tone_notes: [],
  remember: [],
  reply_brief: null,
  needs_reply: true,
  // A real provider source. resummarizeThread persists only when the AI call
  // actually produced output; a result with no source (or a null providerId)
  // is the synthesised fallback and is NOT written (Bug Q2 data-loss guard).
  // These #385 tests exercise the SUCCESS path, so they carry a real source.
  source: {
    providerId: "openai",
    providerDisplayName: "OpenAI",
    fellBackFromProviderId: null,
    fellBackFromProviderDisplayName: null,
    fellBackReason: null,
    fellBackMessage: null
  }
};

function makeFakePrisma({ thread, messages }) {
  const calls = { findUnique: 0, findMany: 0, threadUpdateMany: [], updateMany: [], transaction: [] };
  const prisma = {
    thread: {
      async findUnique() {
        calls.findUnique += 1;
        return thread;
      },
      async updateMany(args) {
        calls.threadUpdateMany.push(args);
        return { count: 1 };
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
    async $transaction(work) {
      calls.transaction.push("callback");
      return work(prisma);
    }
  };
  return { prisma, calls };
}

function makeAi(result = SUMMARY) {
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

test("resummarizeThread: a successful summary clears needsAiRefresh on the contributing transcripts, in one transaction", async () => {
  const messages = [
    msg("m1", { text: "", audioTranscription: transcript(true) }), // contributes + upgraded
    msg("m2", { text: "hi", audioTranscription: null }) // contributes, but nothing to clear
  ];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const { aiService, aiCalls } = makeAi();

  const result = await resummarizeThread({ prisma, aiService, siblingThreadIds }, "t1", {
    race: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary, "Fresh summary");
  assert.equal(aiCalls[0].race, true); // race option threads through to the AI call
  // Summary write + clear happen together in one callback transaction.
  assert.equal(calls.transaction.length, 1);
  assert.equal(calls.threadUpdateMany.length, 1);
  assert.equal(calls.threadUpdateMany[0].data.rollingSummary, "Fresh summary");
  assert.deepEqual(calls.threadUpdateMany[0].where, {
    id: "t1",
    updatedAt: baseThread.updatedAt
  });
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].where.messageId.in, ["m1"]);
  assert.equal(calls.updateMany[0].where.needsAiRefresh, true);
  assert.equal(calls.updateMany[0].data.needsAiRefresh, false);
});

test("resummarizeThread: the background self-heal path (no race) also clears", async () => {
  const messages = [msg("m1", { text: "", audioTranscription: transcript(true) })];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const { aiService, aiCalls } = makeAi();

  await resummarizeThread({ prisma, aiService, siblingThreadIds }, "t1"); // no options = self-heal

  assert.equal(aiCalls[0].race, undefined);
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].where.messageId.in, ["m1"]);
});

test("resummarizeThread: no upgraded transcripts still guards the summary write transactionally", async () => {
  const messages = [
    msg("m1", { text: "hi", audioTranscription: null }),
    msg("m2", { text: "ok", audioTranscription: transcript(false) })
  ];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const { aiService } = makeAi();

  const result = await resummarizeThread({ prisma, aiService, siblingThreadIds }, "t1", {
    race: true
  });

  assert.equal(result.ok, true);
  assert.equal(calls.threadUpdateMany.length, 1); // summary still persisted
  assert.equal(calls.transaction.length, 1); // stale-result guard is transactional
  assert.equal(calls.updateMany.length, 0); // and nothing cleared
});

test("resummarizeThread: a missing thread writes nothing and clears nothing", async () => {
  const { prisma, calls } = makeFakePrisma({ thread: null, messages: [] });
  const { aiService, aiCalls } = makeAi();

  const result = await resummarizeThread({ prisma, aiService, siblingThreadIds }, "missing", {
    race: true
  });

  assert.deepEqual(result, { ok: false, reason: "not_found" });
  assert.equal(aiCalls.length, 0); // never reached the AI
  assert.equal(calls.threadUpdateMany.length, 0);
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.transaction.length, 0);
});

test("resummarizeThread: a failed summary generation leaves the summary and flags untouched", async () => {
  const messages = [msg("m1", { text: "", audioTranscription: transcript(true) })];
  const { prisma, calls } = makeFakePrisma({ thread: baseThread, messages });
  const aiService = {
    async updateThreadSummary() {
      throw new Error("provider down");
    }
  };

  await assert.rejects(
    () => resummarizeThread({ prisma, aiService, siblingThreadIds }, "t1", { race: true }),
    /provider down/
  );

  assert.equal(calls.threadUpdateMany.length, 0);
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.transaction.length, 0);
});

test("resummarizeThread: iMessage merges sibling threads when selecting messages, and still clears", async () => {
  const messages = [msg("m1", { text: "", audioTranscription: transcript(true) })];
  const { prisma, calls } = makeFakePrisma({ thread: { ...baseThread, platform: "IMESSAGE" }, messages });
  let findManyWhere = null;
  prisma.message.findMany = async (args) => {
    findManyWhere = args.where;
    return messages;
  };
  let sibArgs = null;
  const sib = async (platform, personId) => {
    sibArgs = { platform, personId };
    return ["t1", "t2"];
  };
  const { aiService } = makeAi();

  await resummarizeThread({ prisma, aiService, siblingThreadIds: sib }, "t1", { race: true });

  assert.deepEqual(sibArgs, { platform: "IMESSAGE", personId: "p1" });
  assert.deepEqual(findManyWhere, { threadId: { in: ["t1", "t2"] } });
  assert.deepEqual(calls.updateMany[0].where.messageId.in, ["m1"]);
});
