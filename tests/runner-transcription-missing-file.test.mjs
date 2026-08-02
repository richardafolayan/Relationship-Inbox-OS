import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptionService } from "../apps/runner/dist/services/transcription/index.js";

function makeFakePrisma() {
  const audioRows = new Map();
  return {
    audioRows,
    message: {
      _messages: [],
      async findUnique({ where }) {
        return this._messages?.find((m) => m.id === where.id) ?? null;
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
      }
    }
  };
}

function makeFakeProvider() {
  const calls = [];
  return {
    calls,
    provider: {
      id: "openai",
      async transcribe(request) {
        calls.push(request);
        return { kind: "ok", result: { text: "should not be called", model: request.model } };
      }
    }
  };
}

test("missing file from the resolver writes a skipped row with errorMessage=missing_file", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push({
    id: "m1",
    platformMessageKey: "k1",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
    ])
  });
  const provider = makeFakeProvider();
  const warned = [];
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: { async resolve() { return null; } },
    config: {
      enabled: true,
      apiKey: "sk-test",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      maxBytes: 1024,
      maxSeconds: 60
    },
    warn: (msg) => warned.push(msg)
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(provider.calls.length, 0);
  const row = prisma.audioRows.get("m1|k1|g1");
  assert.equal(row.status, "skipped");
  assert.equal(row.errorMessage, "missing_file");
});

test("a missing_file skip emits the retention warning once per cooldown", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(
    {
      id: "m1",
      platformMessageKey: "k1",
      attachmentsJson: JSON.stringify([
        { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" }
      ])
    },
    {
      id: "m2",
      platformMessageKey: "k2",
      attachmentsJson: JSON.stringify([
        { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g2" }
      ])
    }
  );
  const warned = [];
  const service = createTranscriptionService({
    prisma,
    provider: { id: "openai", async transcribe() { return { kind: "ok", result: { text: "x", model: "x" } }; } },
    attachmentResolver: { async resolve() { return null; } },
    config: {
      enabled: true,
      apiKey: "sk-test",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      maxBytes: 1024,
      maxSeconds: 60
    },
    warn: (msg) => warned.push(msg)
  });
  await service.transcribeMessage("m1");
  await service.transcribeMessage("m2");
  // Only one retention warning, even though two messages produced
  // missing_file skips inside the cooldown window.
  const retentionWarnings = warned.filter((m) => m.includes("missing from disk"));
  assert.equal(retentionWarnings.length, 1, `expected one warning, got ${retentionWarnings.length}`);
  assert.match(retentionWarnings[0], /Audio Messages/);
});
