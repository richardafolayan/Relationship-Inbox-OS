import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptionService } from "../apps/runner/dist/services/transcription/index.js";

// Fake prisma that supports both the parent transcription table and
// the new per-tier attempt table. Records every write so tests can
// assert on attempt history without round-tripping through SQLite.
function makeFakePrisma() {
  const parentRows = new Map(); // keyed by messageId
  const attemptRows = []; // list, ordered by insert
  let parentCounter = 0;
  let attemptCounter = 0;

  return {
    parentRows,
    attemptRows,
    message: {
      _messages: [],
      async findUnique({ where }) {
        return this._messages.find((m) => m.id === where.id) ?? null;
      },
      async findMany() {
        return [];
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
        const row = {
          id: `t-${parentCounter}`,
          attemptIds: [],
          ...data
        };
        parentRows.set(data.messageId, row);
        return row;
      },
      async update({ where, data }) {
        let row = null;
        if (where.id !== undefined) {
          for (const candidate of parentRows.values()) {
            if (candidate.id === where.id) row = candidate;
          }
        }
        if (!row && where.messageId !== undefined) {
          row = parentRows.get(where.messageId) ?? null;
        }
        if (!row) throw new Error("update: row not found");
        Object.assign(row, data);
        return row;
      },
      async delete({ where }) {
        if (where.messageId !== undefined) {
          const row = parentRows.get(where.messageId);
          if (!row) throw new Error("delete: row not found");
          parentRows.delete(where.messageId);
          // Cascade-delete attempts
          for (let i = attemptRows.length - 1; i >= 0; i -= 1) {
            if (attemptRows[i].transcriptionId === row.id) {
              attemptRows.splice(i, 1);
            }
          }
          return row;
        }
        throw new Error("delete: unsupported where clause");
      }
    },
    messageAudioTranscriptionAttempt: {
      async create({ data }) {
        attemptCounter += 1;
        const row = { id: `a-${attemptCounter}`, ...data };
        attemptRows.push(row);
        return row;
      },
      async findFirst({ where } = {}) {
        if (!where) return attemptRows[0] ?? null;
        return (
          attemptRows.find(
            (a) =>
              (where.transcriptionId === undefined ||
                a.transcriptionId === where.transcriptionId) &&
              (where.tier === undefined || a.tier === where.tier) &&
              (where.model === undefined || a.model === where.model)
          ) ?? null
        );
      },
      async findMany({ where } = {}) {
        if (where && where.transcriptionId) {
          return attemptRows.filter((a) => a.transcriptionId === where.transcriptionId);
        }
        return [...attemptRows];
      }
    }
  };
}

function makeProvider(id, label, impl) {
  const calls = [];
  return {
    calls,
    provider: {
      id,
      modelLabel: label,
      async transcribe(request) {
        calls.push(request);
        return impl(request, calls.length);
      }
    }
  };
}

function makeMessage(id, key, threadId = "t-default", direction = "IN") {
  return {
    id,
    platformMessageKey: key,
    threadId,
    direction,
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: `g-${id}` }
    ])
  };
}

function makeResolver(path = "/tmp/voice.m4a") {
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

const baseConfig = {
  enabled: true,
  apiKey: null,
  model: "gpt-4o-mini-transcribe",
  language: "en",
  maxBytes: 25 * 1024 * 1024,
  maxSeconds: 600
};

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeAudioFile() {
  const dir = mkdtempSync(join(tmpdir(), "audio-prog-"));
  const path = join(dir, "voice.m4a");
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  return path;
}

test("progressive: fast writes the first selected transcript", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = makeProvider("local-whisper", "ggml-small.en.bin", () => ({
    kind: "ok",
    result: { text: "fast text", model: "ggml-small.en.bin" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.ok, 1);

  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.status, "transcribed");
  assert.equal(parent.transcript, "fast text");
  assert.equal(parent.selectedTier, "fast");
  assert.equal(parent.selectedModel, "ggml-small.en.bin");
  assert.equal(parent.selectedProvider, "local-whisper");

  // One attempt row written.
  assert.equal(prisma.attemptRows.length, 1);
  assert.equal(prisma.attemptRows[0].tier, "fast");
  assert.equal(prisma.attemptRows[0].transcript, "fast text");
});

test("progressive: standard overwrites fast when both succeed", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = makeProvider("local-whisper", "ggml-small.en.bin", () => ({
    kind: "ok",
    result: { text: "fast text", model: "ggml-small.en.bin" }
  }));
  const standard = makeProvider("local-whisper", "ggml-large-v3-turbo-q5_0.bin", () => ({
    kind: "ok",
    result: { text: "standard text", model: "ggml-large-v3-turbo-q5_0.bin" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");

  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.selectedTier, "standard");
  assert.equal(parent.transcript, "standard text");
  // Parent flagged for AI refresh since standard replaced fast.
  assert.equal(parent.needsAiRefresh, true);
  // Both attempts persisted.
  assert.equal(prisma.attemptRows.length, 2);
  assert.equal(prisma.attemptRows[0].tier, "fast");
  assert.equal(prisma.attemptRows[1].tier, "standard");
});

test("progressive: failed standard does not delete a successful fast transcript", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = makeProvider("local-whisper", "ggml-small.en.bin", () => ({
    kind: "ok",
    result: { text: "fast text", model: "ggml-small.en.bin" }
  }));
  const standard = makeProvider("local-whisper", "ggml-large-v3-turbo-q5_0.bin", () => ({
    kind: "failed",
    errorMessage: "local_whisper_command_failed"
  }));
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");

  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.selectedTier, "fast");
  assert.equal(parent.transcript, "fast text");
  // Both rows persisted; one ok, one failed.
  assert.equal(prisma.attemptRows.length, 2);
  assert.equal(
    prisma.attemptRows.find((a) => a.tier === "standard").status,
    "failed"
  );
});

test("progressive: empty-output higher tier is recorded as skipped, not selected", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = makeProvider("local-whisper", "ggml-small.en.bin", () => ({
    kind: "ok",
    result: { text: "fast text", model: "ggml-small.en.bin" }
  }));
  const standard = makeProvider("local-whisper", "ggml-large-v3-turbo-q5_0.bin", () => ({
    kind: "ok",
    result: { text: "   ", model: "ggml-large-v3-turbo-q5_0.bin" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");

  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.selectedTier, "fast", "empty standard must not overwrite fast");
  assert.equal(parent.transcript, "fast text");
  const standardAttempt = prisma.attemptRows.find((a) => a.tier === "standard");
  assert.equal(standardAttempt.status, "skipped");
  assert.equal(standardAttempt.errorMessage, "empty_output");
});

test("progressive: refinement enabled but no standard/max success → no refiner call", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = makeProvider("local-whisper", "ggml-small.en.bin", () => ({
    kind: "ok",
    result: { text: "fast text", model: "ggml-small.en.bin" }
  }));
  let refinerCalls = 0;
  const refiner = {
    async refine() {
      refinerCalls += 1;
      return { kind: "ok", result: {
        correctedTranscript: "refined", confidence: "high",
        changesMade: [], uncertainPhrases: [], model: "gpt-5-nano",
        rawJson: "{}"
      } };
    }
  };
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider },
    refiner,
    refinementEnabled: true,
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");
  assert.equal(refinerCalls, 0, "refiner must not run without standard or max success");
});

test("progressive: refinement enabled + standard success → refiner runs and wins", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const fast = makeProvider("local-whisper", "ggml-small.en.bin", () => ({
    kind: "ok",
    result: {
      text: "yeah I did do well when I say food shop loosely",
      model: "ggml-small.en.bin"
    }
  }));
  const standard = makeProvider("local-whisper", "ggml-large-v3-turbo-q5_0.bin", () => ({
    kind: "ok",
    result: {
      text: "yeah I did do well when I say food shop so loosely because food shop",
      model: "ggml-large-v3-turbo-q5_0.bin"
    }
  }));
  let receivedContext = null;
  const refiner = {
    async refine(ctx) {
      receivedContext = ctx;
      return {
        kind: "ok",
        result: {
          correctedTranscript:
            "yeah I did do well when I say food shop so loosely because food shop",
          confidence: "high",
          changesMade: [{ from: "loosely.", to: "loosely.", reason: "ok" }],
          uncertainPhrases: [],
          model: "gpt-5-nano",
          rawJson: '{"correctedTranscript":"yeah ..."}'
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
    nearbyMessages: {
      async fetch() {
        return [
          { direction: "OUT", timestamp: "12:00", text: "Did you do a food shop?" }
        ];
      }
    },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");

  assert.ok(receivedContext, "refiner should have been called");
  // Refiner received both successful local attempts (fast + standard).
  assert.equal(receivedContext.attempts.length, 2);
  assert.equal(receivedContext.nearbyMessages.length, 1);
  assert.equal(receivedContext.direction, "IN");
  assert.equal(receivedContext.speakerRole, "contact");

  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.selectedTier, "refinement");
  assert.equal(parent.selectedProvider, "openai-text-refiner");
  assert.equal(parent.refinementModel, "gpt-5-nano");
  assert.equal(parent.refinementConfidence, "high");
  assert.match(parent.transcript, /food shop/);

  // Attempts: fast + standard + refinement = 3
  assert.equal(prisma.attemptRows.length, 3);
  assert.ok(prisma.attemptRows.find((a) => a.tier === "refinement"));
});

test("progressive: revocation after a local tier stops later providers and refinement", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  let allowed = true;
  const fast = makeProvider("local-whisper", "fast.bin", () => {
    allowed = false;
    return { kind: "ok", result: { text: "fast text", model: "fast.bin" } };
  });
  const standard = makeProvider("local-whisper", "standard.bin", () => ({
    kind: "ok",
    result: { text: "standard text", model: "standard.bin" }
  }));
  let refinerCalls = 0;
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    refiner: {
      async refine() {
        refinerCalls += 1;
        return { kind: "skipped", reason: "blocked" };
      }
    },
    refinementEnabled: true,
    nearbyMessages: { async fetch() { return []; } },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });

  await service.transcribeMessage("m1", { shouldContinue: () => allowed });

  assert.equal(fast.calls.length, 1);
  assert.equal(standard.calls.length, 0);
  assert.equal(refinerCalls, 0);
});

test("progressive: refinement failure does not erase the local selected transcript", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const standard = makeProvider("local-whisper", "ggml-large-v3-turbo-q5_0.bin", () => ({
    kind: "ok",
    result: {
      text: "standard transcript intact",
      model: "ggml-large-v3-turbo-q5_0.bin"
    }
  }));
  const refiner = {
    async refine() {
      return { kind: "failed", errorMessage: "refinement_timeout" };
    }
  };
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { standard: standard.provider },
    refiner,
    refinementEnabled: true,
    nearbyMessages: { async fetch() { return []; } },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");

  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.selectedTier, "standard");
  assert.equal(parent.transcript, "standard transcript intact");
  assert.equal(parent.refinedTranscript, null ?? undefined);
});

test("progressive: force=true cascade-deletes attempts and restarts", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const standard = makeProvider("local-whisper", "ggml-large-v3-turbo-q5_0.bin", () => ({
    kind: "ok",
    result: {
      text: "first pass",
      model: "ggml-large-v3-turbo-q5_0.bin"
    }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");
  assert.equal(prisma.attemptRows.length, 1);

  // Re-stub the provider to return a different transcript on retry.
  standard.provider.transcribe = async () => ({
    kind: "ok",
    result: {
      text: "second pass",
      model: "ggml-large-v3-turbo-q5_0.bin"
    }
  });
  await service.transcribeMessage("m1", { force: true });

  // Old parent row gone, new one written; attempts re-counted from scratch.
  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.transcript, "second pass");
  assert.equal(prisma.attemptRows.length, 1, "old attempts should have been cascaded out");
  assert.equal(prisma.attemptRows[0].transcript, "second pass");
});

test("progressive: pre-tier missing_file writes a parent skip with no attempt rows", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const standard = makeProvider("local-whisper", "x", () => ({
    kind: "ok",
    result: { text: "should not run", model: "x" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { standard: standard.provider },
    attachmentResolver: { async resolve() { return null; } },
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(standard.calls.length, 0);

  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.status, "skipped");
  assert.equal(parent.errorMessage, "missing_file");
  assert.equal(prisma.attemptRows.length, 0, "no provider was called → no attempt rows");
});

test("progressive: no provider configured falls back to single-mode (backwards compat)", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const single = makeProvider("local-whisper", "ggml-base.en.bin", () => ({
    kind: "ok",
    result: { text: "single", model: "ggml-base.en.bin" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: single.provider,
    // providers OMITTED -> single-mode active
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");
  const parent = prisma.parentRows.get("m1");
  assert.equal(parent.status, "transcribed");
  assert.equal(parent.transcript, "single");
  // No attempt rows in single-mode.
  assert.equal(prisma.attemptRows.length, 0);
});
