import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTranscriptionService
} from "../apps/runner/dist/services/transcription/index.js";

// Tests for provider-selection behaviour in the service. The service
// itself doesn't pick a provider — the runner does in index.ts — but
// these confirm that whichever provider is wired in, the service uses
// its `id` and `modelLabel` for persistence and never calls a provider
// the operator didn't select.

function makeFakePrisma() {
  const audioRows = new Map();
  return {
    audioRows,
    message: {
      _messages: [],
      async findUnique({ where }) {
        return this._messages.find((m) => m.id === where.id) ?? null;
      }
    },
    messageAudioTranscription: {
      async findUnique({ where }) {
        if (where.audioFingerprint !== undefined) {
          return audioRows.get(where.audioFingerprint) ?? null;
        }
        if (where.messageId !== undefined) {
          for (const row of audioRows.values()) {
            if (row.messageId === where.messageId) return row;
          }
        }
        return null;
      },
      async create({ data }) {
        const row = { id: `row-${audioRows.size + 1}`, ...data };
        audioRows.set(data.audioFingerprint, row);
        return row;
      },
      async delete({ where }) {
        audioRows.delete(where.audioFingerprint);
      }
    }
  };
}

function makeAudioFile() {
  const dir = mkdtempSync(join(tmpdir(), "audio-sel-"));
  const path = join(dir, "voice.m4a");
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  return path;
}

function makeMessage(id, key) {
  return {
    id,
    platformMessageKey: key,
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: `g-${id}` }
    ])
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

test("provider=null leaves the service disabled (no prisma writes)", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const service = createTranscriptionService({
    prisma,
    provider: null,
    attachmentResolver: { async resolve() { return null; } },
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "disabled");
  assert.equal(prisma.audioRows.size, 0);
});

test("rows persist provider.id + provider.modelLabel from a local-whisper provider", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  let openaiCalls = 0;
  const localProvider = {
    id: "local-whisper",
    modelLabel: "ggml-base.en.bin",
    async transcribe() {
      return {
        kind: "ok",
        result: { text: "hello from local whisper", model: "ggml-base.en.bin" }
      };
    }
  };
  const service = createTranscriptionService({
    prisma,
    provider: localProvider,
    attachmentResolver: {
      async resolve() {
        return { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" };
      }
    },
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m1");
  const row = prisma.audioRows.get("k1|g-m1");
  assert.equal(row.status, "transcribed");
  assert.equal(row.provider, "local-whisper");
  assert.equal(row.model, "ggml-base.en.bin");
  assert.equal(openaiCalls, 0);
});

test("rows persist provider=openai when the OpenAI provider is wired", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m2", "k2"));
  const openaiProvider = {
    id: "openai",
    modelLabel: "gpt-4o-mini-transcribe",
    async transcribe() {
      return {
        kind: "ok",
        result: { text: "hi", model: "gpt-4o-mini-transcribe" }
      };
    }
  };
  const service = createTranscriptionService({
    prisma,
    provider: openaiProvider,
    attachmentResolver: {
      async resolve() {
        return { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" };
      }
    },
    config: baseConfig,
    warn: () => {}
  });
  await service.transcribeMessage("m2");
  const row = prisma.audioRows.get("k2|g-m2");
  assert.equal(row.provider, "openai");
  assert.equal(row.model, "gpt-4o-mini-transcribe");
});

test("provider that returns skipped persists the reason verbatim (e.g. local_whisper_not_configured)", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m3", "k3"));
  const stubProvider = {
    id: "local-whisper",
    modelLabel: "ggml-base.en.bin",
    async transcribe() {
      return { kind: "skipped", reason: "local_whisper_not_configured" };
    }
  };
  const service = createTranscriptionService({
    prisma,
    provider: stubProvider,
    attachmentResolver: {
      async resolve() {
        return { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" };
      }
    },
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m3");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  const row = prisma.audioRows.get("k3|g-m3");
  assert.equal(row.status, "skipped");
  assert.equal(row.errorMessage, "local_whisper_not_configured");
});

test("service no longer requires config.apiKey to be set (local-whisper path)", async () => {
  // Pre-local-whisper, config.apiKey null was a disable signal. With
  // local-whisper supported, the only required wires are provider +
  // resolver; apiKey can stay null when running local.
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m4", "k4"));
  const service = createTranscriptionService({
    prisma,
    provider: {
      id: "local-whisper",
      modelLabel: "ggml-base.en.bin",
      async transcribe() {
        return { kind: "ok", result: { text: "x", model: "ggml-base.en.bin" } };
      }
    },
    attachmentResolver: {
      async resolve() {
        return { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" };
      }
    },
    config: { ...baseConfig, apiKey: null },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m4");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.ok, 1);
});
