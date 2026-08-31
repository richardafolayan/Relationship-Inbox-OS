import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptionService } from "../apps/runner/dist/services/transcription/index.js";

// Tests for the auto-scan priority queue. Verifies that:
//   - enqueueMessage runs `fast` across multiple messages before
//     starting any `standard` work, so a batch of new voice notes
//     all see their first transcript quickly even when `standard`
//     takes >5s per message.
//   - getPendingTiers reflects actual runtime queue state.
//   - auto path never schedules `max` or refinement (those are
//     manual-only tiers).
//   - force-retry through transcribeMessage runs the full chain
//     and doesn't get pre-empted by the auto queue.

function makeFakePrisma() {
  const parentRows = new Map();
  const attemptRows = [];
  let parentCounter = 0;
  let attemptCounter = 0;
  const database = {
    parentRows,
    attemptRows,
    message: {
      _messages: [],
      async findUnique({ where }) {
        return this._messages.find((m) => m.id === where.id) ?? null;
      }
    },
    messageAudioTranscription: {
      async findUnique({ where }) {
        if (where.messageId !== undefined) {
          return parentRows.get(where.messageId) ?? null;
        }
        for (const row of parentRows.values()) {
          if (where.id !== undefined && row.id === where.id) return row;
        }
        return null;
      },
      async create({ data }) {
        parentCounter += 1;
        const row = { id: `t-${parentCounter}`, ...data };
        parentRows.set(data.messageId, row);
        return row;
      },
      async update({ where, data }) {
        let row = null;
        if (where.id !== undefined) {
          for (const r of parentRows.values()) if (r.id === where.id) row = r;
        }
        if (!row && where.messageId !== undefined) {
          row = parentRows.get(where.messageId) ?? null;
        }
        if (!row) throw new Error("update: not found");
        Object.assign(row, data);
        return row;
      },
      async delete({ where }) {
        const row = parentRows.get(where.messageId);
        if (!row) throw new Error("delete: not found");
        parentRows.delete(where.messageId);
        for (let i = attemptRows.length - 1; i >= 0; i -= 1) {
          if (attemptRows[i].transcriptionId === row.id) attemptRows.splice(i, 1);
        }
        return row;
      }
    },
    messageAudioTranscriptionAttempt: {
      async create({ data }) {
        attemptCounter += 1;
        const row = { id: `a-${attemptCounter}`, ...data };
        attemptRows.push(row);
        return row;
      },
      async upsert({ where, update, create }) {
        const key = where.transcriptionId_tier_model;
        const existing = attemptRows.find(
          (row) =>
            row.transcriptionId === key.transcriptionId &&
            row.tier === key.tier &&
            row.model === key.model
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        attemptCounter += 1;
        const row = { id: `a-${attemptCounter}`, ...create };
        attemptRows.push(row);
        return row;
      },
      async findFirst({ where } = {}) {
        return (
          attemptRows.find(
            (a) =>
              (where?.transcriptionId === undefined ||
                a.transcriptionId === where.transcriptionId) &&
              (where?.tier === undefined || a.tier === where.tier) &&
              (where?.model === undefined || a.model === where.model)
          ) ?? null
        );
      },
      async findMany({ where } = {}) {
        if (where?.transcriptionId) {
          return attemptRows.filter((a) => a.transcriptionId === where.transcriptionId);
        }
        return [...attemptRows];
      }
    },
    async $transaction(work) {
      return work(database);
    }
  };
  return database;
}

function makeMessage(id, key) {
  return {
    id,
    platformMessageKey: key,
    threadId: "t-1",
    direction: "IN",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: `g-${id}` }
    ])
  };
}

function makeAudioFile() {
  const dir = mkdtempSync(join(tmpdir(), "audio-queue-"));
  const path = join(dir, "voice.m4a");
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  return path;
}

function makeResolver(path) {
  return {
    async resolve() {
      return {
        absolutePath: path,
        mimeType: "audio/mp4",
        filename: "v.m4a",
        transferName: "v.m4a"
      };
    }
  };
}

function timedProvider(id, label, ms, text) {
  const calls = [];
  return {
    calls,
    provider: {
      id,
      modelLabel: label,
      async transcribe(req) {
        calls.push({ at: Date.now(), req });
        await new Promise((r) => setTimeout(r, ms));
        return {
          kind: "ok",
          result: { text: `${text} for ${req.filePath}`, model: label }
        };
      }
    }
  };
}

const baseConfig = {
  enabled: true,
  apiKey: null,
  model: "gpt-4o-mini-transcribe",
  language: "en",
  maxBytes: 25 * 1024 * 1024,
  maxSeconds: 600
};

test("auto enqueue runs fast for all messages before any standard", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(
    makeMessage("m1", "k1"),
    makeMessage("m2", "k2"),
    makeMessage("m3", "k3")
  );
  // Fast tier takes 20ms; standard takes 60ms. If the service ran
  // each message's full chain serially (m1 fast+standard, then m2,
  // then m3), m3's fast wouldn't start until ~160ms in. With the
  // priority queue, m3's fast starts before m1's standard.
  const fast = timedProvider("local-whisper", "ggml-small.en.bin", 20, "fast");
  const standard = timedProvider(
    "local-whisper",
    "ggml-large-v3-turbo-q5_0.bin",
    60,
    "standard"
  );
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  const t0 = Date.now();
  service.enqueueMessage("m1");
  service.enqueueMessage("m2");
  service.enqueueMessage("m3");
  // Wait for the whole queue to drain.
  await new Promise((r) => setTimeout(r, 500));
  const elapsed = Date.now() - t0;
  // Provider call ordering: all three fast calls must come before
  // any standard call.
  const callOrder = [...fast.calls.map((c) => ({ at: c.at, tier: "fast" })),
                     ...standard.calls.map((c) => ({ at: c.at, tier: "standard" }))]
    .sort((a, b) => a.at - b.at);
  const firstStandardIdx = callOrder.findIndex((c) => c.tier === "standard");
  const fastBeforeStandard = callOrder.slice(0, firstStandardIdx).filter((c) => c.tier === "fast").length;
  assert.equal(fastBeforeStandard, 3, "all 3 fast calls must complete before any standard call");
  // Total elapsed >= 3*20 + 3*60 = 240ms minimum
  assert.ok(elapsed >= 200, `expected at least 200ms, got ${elapsed}`);
  // All messages got a transcript.
  assert.equal(prisma.parentRows.get("m1")?.status, "transcribed");
  assert.equal(prisma.parentRows.get("m2")?.status, "transcribed");
  assert.equal(prisma.parentRows.get("m3")?.status, "transcribed");
});

test("auto enqueue never schedules max tier", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = timedProvider("local-whisper", "f", 10, "fast");
  const standard = timedProvider("local-whisper", "s", 10, "standard");
  const max = timedProvider("local-whisper", "m", 10, "max");
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: {
      fast: fast.provider,
      standard: standard.provider,
      max: max.provider
    },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  service.enqueueMessage("m1");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fast.calls.length, 1, "fast should run");
  assert.equal(standard.calls.length, 1, "standard should run");
  assert.equal(max.calls.length, 0, "max must NOT run from auto enqueue");
});

test("auto enqueue never calls refiner even when refinement is enabled", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = timedProvider("local-whisper", "f", 10, "fast");
  const standard = timedProvider("local-whisper", "s", 10, "standard");
  let refinerCalls = 0;
  const refiner = {
    async refine() {
      refinerCalls += 1;
      return {
        kind: "ok",
        result: {
          correctedTranscript: "refined",
          confidence: "high",
          changesMade: [],
          uncertainPhrases: [],
          model: "gpt-5-nano",
          rawJson: "{}"
        }
      };
    }
  };
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    refiner,
    refinementEnabled: true,
    nearbyMessages: { async fetch() { return []; } },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  service.enqueueMessage("m1");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(refinerCalls, 0, "refiner must not be called from auto path");
  // But standard did run.
  assert.equal(standard.calls.length, 1);
});

test("getPendingTiers reports tiers actually queued, then clears as work completes", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = timedProvider("local-whisper", "f", 50, "fast");
  const standard = timedProvider("local-whisper", "s", 50, "standard");
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  // No work in flight yet.
  assert.deepEqual(service.getPendingTiers("m1"), []);
  service.enqueueMessage("m1");
  // Immediately after enqueue, fast + standard are both pending.
  const beforeStart = service.getPendingTiers("m1").sort();
  assert.deepEqual(beforeStart, ["fast", "standard"]);
  // After fast completes (~50ms), only standard pending.
  await new Promise((r) => setTimeout(r, 75));
  assert.deepEqual(service.getPendingTiers("m1"), ["standard"]);
  // After standard completes (~50ms more), nothing pending.
  await new Promise((r) => setTimeout(r, 75));
  assert.deepEqual(service.getPendingTiers("m1"), []);
});

test("getPendingTiers clears 'standard' when fast fails (no upgrade queued)", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = {
    calls: [],
    provider: {
      id: "local-whisper",
      modelLabel: "f",
      async transcribe(req) {
        this.calls.push({ at: Date.now(), req });
        await new Promise((r) => setTimeout(r, 20));
        return { kind: "failed", errorMessage: "local_whisper_command_failed" };
      },
      calls: []
    }
  };
  const standard = timedProvider("local-whisper", "s", 50, "standard");
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  service.enqueueMessage("m1");
  await new Promise((r) => setTimeout(r, 100));
  // Fast failed → standard should NOT have been queued → nothing pending.
  assert.deepEqual(service.getPendingTiers("m1"), []);
  assert.equal(standard.calls.length, 0, "standard should not run after fast failure");
});

test("manual transcribeMessage runs full chain (including max + refinement)", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = timedProvider("local-whisper", "f", 5, "fast");
  const standard = timedProvider("local-whisper", "s", 5, "standard");
  const max = timedProvider("local-whisper", "m", 5, "max");
  let refinerCalls = 0;
  const refiner = {
    async refine() {
      refinerCalls += 1;
      return {
        kind: "ok",
        result: {
          correctedTranscript: "yeah refined transcript with food shop and more food shop content from local",
          confidence: "high",
          changesMade: [],
          uncertainPhrases: [],
          model: "gpt-5-nano",
          rawJson: "{}"
        }
      };
    }
  };
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: {
      fast: fast.provider,
      standard: standard.provider,
      max: max.provider
    },
    refiner,
    refinementEnabled: true,
    nearbyMessages: { async fetch() { return []; } },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(fast.calls.length, 1, "fast ran");
  assert.equal(standard.calls.length, 1, "standard ran");
  assert.equal(max.calls.length, 1, "max ran");
  assert.equal(refinerCalls, 1, "refiner ran (manual path)");
});
