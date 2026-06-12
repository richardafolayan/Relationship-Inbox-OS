// Unit tests for the transformers.js + ONNX transcription provider (the
// pilot default). Everything heavy is stubbed: the afconvert->WAV step and
// the (lazy) transformers.js pipeline loader are injected, so these run in
// CI without downloading a model, loading onnxruntime, or touching macOS.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTransformersWhisperProvider,
  readMonoPcm16Wav
} from "../apps/runner/dist/services/transcription/transformers-whisper-provider.js";

// Minimal 16 kHz mono 16-bit PCM WAV with the given int16 samples.
function writeWav(samples) {
  const dir = mkdtempSync(join(tmpdir(), "tf-whisper-"));
  const path = join(dir, "audio.wav");
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  writeFileSync(path, buf);
  return path;
}

const request = { filePath: "/tmp/x.m4a", mimeType: "audio/m4a", filename: "x.m4a", model: "m" };

function fakeProvider({ text, loaderThrows, convertNull, arrayOutput } = {}) {
  return createTransformersWhisperProvider({
    config: { modelId: "Xenova/whisper-base.en", modelDir: "/tmp/no-such-model-dir", timeoutMs: 5000 },
    convertToWav: async () => (convertNull ? null : writeWav([100, 200, 300, -300])),
    pipelineLoader: async () => {
      if (loaderThrows) throw new Error("model not downloaded");
      return async () => (arrayOutput ? [{ text }] : { text });
    }
  });
}

test("readMonoPcm16Wav decodes 16-bit PCM into normalised floats", () => {
  const f = readMonoPcm16Wav(writeWav([0, 16384, -16384]));
  assert.equal(f.length, 3);
  assert.equal(f[0], 0);
  assert.ok(Math.abs(f[1] - 0.5) < 1e-3);
  assert.ok(Math.abs(f[2] + 0.5) < 1e-3);
});

test("transcribe returns ok with trimmed pipeline text + model label", async () => {
  const provider = fakeProvider({ text: "  hello world  " });
  assert.equal(provider.id, "transformers");
  assert.equal(provider.modelLabel, "whisper-base.en");
  const out = await provider.transcribe(request);
  assert.equal(out.kind, "ok");
  assert.equal(out.result.text, "hello world");
  assert.equal(out.result.model, "whisper-base.en");
});

test("transcribe handles array-shaped pipeline output", async () => {
  const out = await fakeProvider({ text: "from array", arrayOutput: true }).transcribe(request);
  assert.equal(out.kind, "ok");
  assert.equal(out.result.text, "from array");
});

test("transcribe skips when audio conversion fails", async () => {
  const out = await fakeProvider({ convertNull: true }).transcribe(request);
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "transformers_conversion_failed");
});

test("transcribe skips (retryable) when the model can't load", async () => {
  const out = await fakeProvider({ loaderThrows: true }).transcribe(request);
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "transformers_model_unavailable");
});

test("transcribe skips on empty transcript", async () => {
  const out = await fakeProvider({ text: "   " }).transcribe(request);
  assert.equal(out.kind, "skipped");
  assert.equal(out.reason, "transformers_empty_output");
});

test("a failed model load does not poison later calls (pipeline promise resets)", async () => {
  let attempts = 0;
  const provider = createTransformersWhisperProvider({
    config: { modelId: "Xenova/whisper-base.en", modelDir: "/tmp/none", timeoutMs: 5000 },
    convertToWav: async () => writeWav([1, 2, 3]),
    pipelineLoader: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return async () => ({ text: "recovered" });
    }
  });
  const first = await provider.transcribe(request);
  assert.equal(first.kind, "skipped"); // model_unavailable
  const second = await provider.transcribe(request);
  assert.equal(second.kind, "ok");
  assert.equal(second.result.text, "recovered");
  assert.equal(attempts, 2);
});
