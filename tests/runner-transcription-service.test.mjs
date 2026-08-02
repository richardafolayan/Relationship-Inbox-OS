import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptionService } from "../apps/runner/dist/services/transcription/index.js";

function makeFakePrisma() {
  const audioRows = new Map();
  return {
    audioRows,
    message: {
      async findUnique({ where, select }) {
        return this._messages?.find((m) => m.id === where.id) ?? null;
      },
      _messages: []
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
      }
    }
  };
}

function makeFakeProvider(impl) {
  const calls = [];
  return {
    calls,
    provider: {
      id: "openai",
      async transcribe(request) {
        calls.push(request);
        return impl(request);
      }
    }
  };
}

function makeFakeResolver(mapping) {
  return {
    async resolve(guid) {
      return mapping[guid] ?? null;
    }
  };
}

function makeAudioFile() {
  const dir = mkdtempSync(join(tmpdir(), "audio-test-"));
  const path = join(dir, "voice.m4a");
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  return path;
}

test("disabled service returns disabled outcome and writes no rows", async () => {
  const prisma = makeFakePrisma();
  const provider = makeFakeProvider(() => ({ kind: "ok", result: { text: "x", model: "x" } }));
  const resolver = makeFakeResolver({});
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: resolver,
    config: {
      enabled: false,
      apiKey: "sk-test",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      maxBytes: 1024,
      maxSeconds: 60
    },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "disabled");
  assert.equal(provider.calls.length, 0);
  assert.equal(prisma.audioRows.size, 0);
});

test("missing provider or resolver returns disabled", async () => {
  const prisma = makeFakePrisma();
  const service = createTranscriptionService({
    prisma,
    provider: null,
    attachmentResolver: null,
    config: {
      enabled: true,
      apiKey: null,
      model: "gpt-4o-mini-transcribe",
      language: "en",
      maxBytes: 1024,
      maxSeconds: 60
    },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "disabled");
});

test("no audio attachment returns no_audio", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([{ type: "image", manualReview: false, kind: "photo" }])
  });
  const provider = makeFakeProvider(() => ({ kind: "ok", result: { text: "x", model: "x" } }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({}),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-mini-transcribe", language: "en", maxBytes: 1024, maxSeconds: 60 },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "no_audio");
  assert.equal(provider.calls.length, 0);
});

test("successful transcription writes a transcribed row", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
    ])
  });
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "hello there", model: "gpt-4o-mini-transcribe", language: "en", durationSeconds: 4 }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({
      g1: { absolutePath: audioPath, mimeType: "audio/mp4", filename: "voice.m4a", transferName: "voice.m4a" }
    }),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-mini-transcribe", language: "en", maxBytes: 1024, maxSeconds: 60 },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.ok, 1);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.skipped, 0);
  assert.equal(provider.calls.length, 1);
  const row = prisma.audioRows.get("m1|k1|g1");
  assert.ok(row, "expected a row at fingerprint m1|k1|g1");
  assert.equal(row.status, "transcribed");
  assert.equal(row.transcript, "hello there");
  assert.equal(row.provider, "openai");
  assert.equal(row.model, "gpt-4o-mini-transcribe");
});

test("model defaults to gpt-4o-mini-transcribe", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
    ])
  });
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "x", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({
      g1: { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" }
    }),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-mini-transcribe", language: "en", maxBytes: 1024, maxSeconds: 60 },
    warn: () => {}
  });
  await service.transcribeMessage("m1");
  assert.equal(provider.calls[0].model, "gpt-4o-mini-transcribe");
});

test("AUDIO_TRANSCRIPTION_MODEL override flows through to the provider", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
    ])
  });
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "x", model: "gpt-4o-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({
      g1: { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" }
    }),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-transcribe", language: "en", maxBytes: 1024, maxSeconds: 60 },
    warn: () => {}
  });
  await service.transcribeMessage("m1");
  assert.equal(provider.calls[0].model, "gpt-4o-transcribe");
});

test("idempotent: existing fingerprint row is skipped, provider never called", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
    ])
  });
  // Seed an existing transcribed row. The service now dedups by
  // messageId (the strict @unique constraint), so the seed must carry
  // the messageId of the message the test is re-running.
  prisma.audioRows.set("m1|k1|g1", {
    status: "transcribed",
    id: "old",
    messageId: "m1"
  });
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "x", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({
      g1: { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" }
    }),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-mini-transcribe", language: "en", maxBytes: 1024, maxSeconds: 60 },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(provider.calls.length, 0);
});

test("provider error stores a failed row and does not throw", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
    ])
  });
  const provider = makeFakeProvider(() => ({ kind: "failed", errorMessage: "rate limited" }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({
      g1: { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" }
    }),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-mini-transcribe", language: "en", maxBytes: 1024, maxSeconds: 60 },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.failed, 1);
  const row = prisma.audioRows.get("m1|k1|g1");
  assert.equal(row.status, "failed");
  assert.equal(row.errorMessage, "rate limited");
});

test("unsupported mime is recorded as skipped without calling the provider", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "audio", manualReview: false, kind: "audio", guid: "g1" }
    ])
  });
  const provider = makeFakeProvider(() => ({ kind: "ok", result: { text: "x", model: "x" } }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({
      g1: {
        absolutePath: audioPath,
        mimeType: "audio/midi",
        filename: "weird.midi",
        transferName: "weird.midi"
      }
    }),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-mini-transcribe", language: "en", maxBytes: 1024, maxSeconds: 60 },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(provider.calls.length, 0);
  const row = prisma.audioRows.get("m1|k1|g1");
  assert.equal(row.status, "skipped");
});

test("oversized files are skipped with a clear reason", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
    ])
  });
  const provider = makeFakeProvider(() => ({ kind: "ok", result: { text: "x", model: "x" } }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: makeFakeResolver({
      g1: { absolutePath: audioPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" }
    }),
    config: { enabled: true, apiKey: "sk", model: "gpt-4o-mini-transcribe", language: "en", maxBytes: 1, maxSeconds: 60 },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.skipped, 1);
  const row = prisma.audioRows.get("m1|k1|g1");
  assert.equal(row.status, "skipped");
  assert.match(row.errorMessage, /exceeds size cap/);
});
