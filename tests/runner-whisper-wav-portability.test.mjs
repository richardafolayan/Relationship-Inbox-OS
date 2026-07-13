import assert from "node:assert/strict";
import test from "node:test";
import { isWhisperReadyWav } from "../apps/runner/src/services/imessage-attachment-server.ts";

function pcmWav({ channels = 1, sampleRate = 16_000, bitsPerSample = 16, samples = 16 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test("accepts the browser-recorded WAV shape without an OS converter", () => {
  assert.equal(isWhisperReadyWav(pcmWav()), true);
});

test("rejects WAV audio that still needs resampling or channel mixing", () => {
  assert.equal(isWhisperReadyWav(pcmWav({ sampleRate: 48_000 })), false);
  assert.equal(isWhisperReadyWav(pcmWav({ channels: 2 })), false);
});

test("rejects malformed or empty WAV input", () => {
  assert.equal(isWhisperReadyWav(Buffer.from("not audio")), false);
  assert.equal(isWhisperReadyWav(pcmWav({ samples: 0 })), false);
});
