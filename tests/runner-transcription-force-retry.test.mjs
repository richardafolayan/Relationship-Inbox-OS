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
      },
      async update({ where, data }) {
        for (const row of audioRows.values()) {
          if (row.id === where.id) {
            Object.assign(row, data);
            return row;
          }
        }
        throw new Error("row not found for update");
      },
      async delete({ where }) {
        if (where.audioFingerprint !== undefined) {
          const existing = audioRows.get(where.audioFingerprint);
          if (!existing) throw new Error("row not found for delete");
          audioRows.delete(where.audioFingerprint);
          return existing;
        }
        if (where.messageId !== undefined) {
          for (const [key, row] of audioRows.entries()) {
            if (row.messageId === where.messageId) {
              audioRows.delete(key);
              return row;
            }
          }
          throw new Error("row not found for delete");
        }
        throw new Error("delete: unsupported where clause");
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
        return impl(request, calls.length);
      }
    }
  };
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
  apiKey: "sk-test",
  model: "gpt-4o-mini-transcribe",
  language: "en",
  maxBytes: 1024,
  maxSeconds: 60
};

test("default call dedups when a row already exists", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  prisma.audioRows.set("k1|g-m1", {
    id: "old",
    status: "skipped",
    errorMessage: "missing_file",
    messageId: "m1"
  });
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "fresh", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: { async resolve() { return { absolutePath: "/", mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" }; } },
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(prisma.audioRows.get("k1|g-m1").id, "old");
});

test("force=true replaces the old row in place only after a successful call", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  prisma.audioRows.set("k1|g-m1", {
    id: "old",
    status: "skipped",
    errorMessage: "missing_file",
    messageId: "m1"
  });
  // Resolver now returns the file (e.g. iCloud finished downloading
  // between the first auto-pass and this manual retry).
  const audioPath = "/tmp/audio-force-test.m4a";
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "audio-force-"));
  const realPath = join(dir, "voice.m4a");
  writeFileSync(realPath, Buffer.from([0, 1, 2, 3]));
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "fresh", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: {
      async resolve() {
        return { absolutePath: realPath, mimeType: "audio/mp4", filename: "v.m4a", transferName: "v.m4a" };
      }
    },
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1", { force: true });
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.ok, 1);
  assert.equal(provider.calls.length, 1);
  const row = prisma.audioRows.get("k1|g-m1");
  assert.equal(row.id, "old");
  assert.equal(row.status, "transcribed");
  assert.equal(row.transcript, "fresh");
});

test("force=true on a still-missing file preserves the existing row", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  prisma.audioRows.set("k1|g-m1", {
    id: "old",
    status: "skipped",
    errorMessage: "missing_file",
    messageId: "m1"
  });
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "should-not-run", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    // Still missing.
    attachmentResolver: { async resolve() { return null; } },
    config: baseConfig,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1", { force: true });
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(provider.calls.length, 0);
  const row = prisma.audioRows.get("k1|g-m1");
  assert.equal(row.id, "old");
  assert.equal(row.status, "skipped");
  assert.equal(row.errorMessage, "missing_file");
});

test("force retry revocation before dispatch preserves the existing transcript", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const original = {
    id: "old",
    status: "transcribed",
    transcript: "keep this transcript",
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
    messageId: "m1"
  };
  prisma.audioRows.set("k1|g-m1", { ...original });
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "audio-force-revoke-"));
  const realPath = join(dir, "voice.m4a");
  writeFileSync(realPath, Buffer.from([0, 1, 2, 3]));
  let allowed = true;
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "must not run", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: {
      async resolve() {
        allowed = false;
        return {
          absolutePath: realPath,
          mimeType: "audio/mp4",
          filename: "v.m4a",
          transferName: "v.m4a"
        };
      }
    },
    config: baseConfig,
    warn: () => {}
  });

  const outcome = await service.transcribeMessage("m1", {
    force: true,
    shouldContinue: () => allowed
  });

  assert.equal(outcome.kind, "processed");
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(prisma.audioRows.get("k1|g-m1"), original);
});

test("force retry empty output preserves the existing transcript", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const original = {
    id: "old",
    status: "transcribed",
    transcript: "keep this transcript",
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
    messageId: "m1"
  };
  prisma.audioRows.set("k1|g-m1", { ...original });
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "audio-force-empty-"));
  const realPath = join(dir, "voice.m4a");
  writeFileSync(realPath, Buffer.from([0, 1, 2, 3]));
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "   ", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: {
      async resolve() {
        return {
          absolutePath: realPath,
          mimeType: "audio/mp4",
          filename: "v.m4a",
          transferName: "v.m4a"
        };
      }
    },
    config: baseConfig,
    warn: () => {}
  });

  const outcome = await service.transcribeMessage("m1", { force: true });

  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(prisma.audioRows.get("k1|g-m1"), original);
});

test("force retry provider failure preserves the existing transcript", async () => {
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  const original = {
    id: "old",
    status: "transcribed",
    transcript: "keep this transcript",
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
    messageId: "m1"
  };
  prisma.audioRows.set("k1|g-m1", { ...original });
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "audio-force-fail-"));
  const realPath = join(dir, "voice.m4a");
  writeFileSync(realPath, Buffer.from([0, 1, 2, 3]));
  const provider = makeFakeProvider(() => ({
    kind: "failed",
    errorMessage: "provider_failed"
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: {
      async resolve() {
        return {
          absolutePath: realPath,
          mimeType: "audio/mp4",
          filename: "v.m4a",
          transferName: "v.m4a"
        };
      }
    },
    config: baseConfig,
    warn: () => {}
  });

  const outcome = await service.transcribeMessage("m1", { force: true });

  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.failed, 1);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(prisma.audioRows.get("k1|g-m1"), original);
});

test("auto-path enqueueMessage still respects fingerprint dedup", async () => {
  // The fire-and-forget enqueue path must never bypass dedup, so a
  // re-scan can't accidentally spam OpenAI just because the operator
  // hasn't cleared old rows.
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));
  prisma.audioRows.set("k1|g-m1", {
    id: "old",
    status: "skipped",
    errorMessage: "missing_file",
    messageId: "m1"
  });
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "x", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: { async resolve() { return null; } },
    config: baseConfig,
    warn: () => {}
  });
  service.enqueueMessage("m1");
  // Let the queued microtask drain.
  await new Promise((r) => setImmediate(r));
  assert.equal(provider.calls.length, 0);
  // Old row still present and untouched.
  assert.equal(prisma.audioRows.get("k1|g-m1").id, "old");
});
