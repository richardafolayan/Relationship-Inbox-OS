import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectAudioAttachments,
  createTranscriptionService
} from "../apps/runner/dist/services/transcription/index.js";

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
      async delete({ where }) {
        const existing = audioRows.get(where.audioFingerprint);
        if (!existing) throw new Error("row not found for delete");
        audioRows.delete(where.audioFingerprint);
        return existing;
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

function makeMessage(id, key, attachments) {
  return {
    id,
    platformMessageKey: key,
    attachmentsJson: JSON.stringify(attachments)
  };
}

function makeAudioFile() {
  const dir = mkdtempSync(join(tmpdir(), "video-test-"));
  const path = join(dir, "extracted.m4a");
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  return path;
}

// Write a placeholder "video" file so the existsSync precheck in the
// service passes. The conversion is stubbed via deps so we don't need
// a real .mov here — just a file at the resolver path.
function makeFakeVideoFile() {
  const dir = mkdtempSync(join(tmpdir(), "video-src-"));
  const path = join(dir, "src.mov");
  writeFileSync(path, Buffer.from([0, 1, 2, 3, 4, 5]));
  return path;
}

const baseConfig = {
  enabled: true,
  apiKey: "sk-test",
  model: "gpt-4o-mini-transcribe",
  language: "en",
  maxBytes: 25 * 1024 * 1024,
  maxSeconds: 600
};

test("collectAudioAttachments now picks up video kind alongside voice_note and audio", () => {
  const json = JSON.stringify([
    { type: "voice_note", manualReview: false, kind: "voice_note", guid: "g1" },
    { type: "photo", manualReview: false, kind: "photo", guid: "g2" },
    { type: "video", manualReview: false, kind: "video", guid: "g3" }
  ]);
  const out = collectAudioAttachments(json);
  assert.equal(out.length, 2);
  assert.equal(out[0].attachment.kind, "voice_note");
  assert.equal(out[1].attachment.kind, "video");
});

test("a video attachment routes through the video extractor and OpenAI sees the m4a", async () => {
  const audioPath = makeAudioFile();
  const fakeVideoPath = makeFakeVideoFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(
    makeMessage("m1", "k1", [
      { type: "video", manualReview: false, kind: "video", guid: "vid-1", byteSize: 30_000_000 }
    ])
  );
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "Yeah, see you Friday.", model: "gpt-4o-mini-transcribe" }
  }));
  let videoConverterCalls = 0;
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: {
      async resolve() {
        return {
          // The original video file lives on disk; the extractor will
          // return a small .m4a (we stub that with audioPath).
          absolutePath: fakeVideoPath,
          mimeType: "video/quicktime",
          filename: "IMG_4873.mov",
          transferName: "IMG_4873.mov"
        };
      }
    },
    config: baseConfig,
    convertVideoToAudioM4a: async () => {
      videoConverterCalls += 1;
      return audioPath;
    },
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.ok, 1);
  assert.equal(videoConverterCalls, 1, "video extractor should have run");
  assert.equal(provider.calls.length, 1);
  // Upload is the extracted m4a, not the original .mov, and the
  // filename advertises audio so OpenAI's extension sniffer is happy.
  assert.equal(provider.calls[0].mimeType, "audio/mp4");
  assert.equal(provider.calls[0].filename, "video-audio.m4a");
  assert.equal(provider.calls[0].filePath, audioPath);
  const row = prisma.audioRows.get("k1|vid-1");
  assert.equal(row.status, "transcribed");
  assert.equal(row.transcript, "Yeah, see you Friday.");
});

test("a video whose extractor fails records a skip with a clear reason", async () => {
  const fakeVideoPath = makeFakeVideoFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(
    makeMessage("m1", "k1", [
      { type: "video", manualReview: false, kind: "video", guid: "vid-1" }
    ])
  );
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "x", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: {
      async resolve() {
        return {
          absolutePath: fakeVideoPath,
          mimeType: "video/quicktime",
          filename: "v.mov",
          transferName: "v.mov"
        };
      }
    },
    config: baseConfig,
    convertVideoToAudioM4a: async () => null,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.skipped, 1);
  assert.equal(provider.calls.length, 0);
  const row = prisma.audioRows.get("k1|vid-1");
  assert.equal(row.status, "skipped");
  assert.equal(row.errorMessage, "video to m4a conversion failed");
});

test("size cap applies to the extracted m4a, not the original video bytes", async () => {
  // A 30 MiB .mov original is over the 25 MiB OpenAI request cap, but
  // the extracted audio is sub-MiB and must be accepted.
  const audioPath = makeAudioFile();
  const fakeVideoPath = makeFakeVideoFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(
    makeMessage("m1", "k1", [
      { type: "video", manualReview: false, kind: "video", guid: "vid-1", byteSize: 30_000_000 }
    ])
  );
  const provider = makeFakeProvider(() => ({
    kind: "ok",
    result: { text: "ok", model: "gpt-4o-mini-transcribe" }
  }));
  const service = createTranscriptionService({
    prisma,
    provider: provider.provider,
    attachmentResolver: {
      async resolve() {
        return {
          absolutePath: fakeVideoPath,
          mimeType: "video/quicktime",
          filename: "big.mov",
          transferName: "big.mov"
        };
      }
    },
    config: baseConfig,
    convertVideoToAudioM4a: async () => audioPath,
    warn: () => {}
  });
  const outcome = await service.transcribeMessage("m1");
  assert.equal(outcome.kind, "processed");
  assert.equal(outcome.ok, 1);
});
