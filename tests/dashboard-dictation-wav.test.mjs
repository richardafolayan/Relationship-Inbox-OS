import test from "node:test";
import assert from "node:assert/strict";

// #462 (pilot R-0061). Dictation records webm/opus, which the runner's
// local-whisper provider (macOS afconvert) can't read. The browser converts
// the recording to a 16 kHz mono 16-bit PCM WAV before upload; this pins the
// WAV encoder's RIFF/WAVE structure. The dashboard ships ESM TypeScript, so
// this runs under `node --import tsx`.
const { encodeWavFromMono, WHISPER_SAMPLE_RATE } = await import(
  "../apps/dashboard/lib/dictation-audio.ts"
);

function ascii(view, offset, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

test("WHISPER_SAMPLE_RATE is 16 kHz (whisper.cpp's required rate)", () => {
  assert.equal(WHISPER_SAMPLE_RATE, 16000);
});

test("encodeWavFromMono writes a valid 16 kHz mono 16-bit PCM RIFF/WAVE header", () => {
  const samples = new Float32Array([0, 0.25, -0.25, 0.5]);
  const buf = encodeWavFromMono(samples, 16000);
  const view = new DataView(buf);

  const dataSize = samples.length * 2;
  assert.equal(buf.byteLength, 44 + dataSize, "total length = 44-byte header + PCM data");

  // RIFF / WAVE / fmt / data chunk markers
  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + dataSize, "RIFF chunk size");
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16, "PCM fmt chunk size");

  // fmt fields
  assert.equal(view.getUint16(20, true), 1, "audioFormat = PCM");
  assert.equal(view.getUint16(22, true), 1, "numChannels = mono");
  assert.equal(view.getUint32(24, true), 16000, "sampleRate");
  assert.equal(view.getUint32(28, true), 16000 * 2, "byteRate = rate * blockAlign");
  assert.equal(view.getUint16(32, true), 2, "blockAlign = channels * bytesPerSample");
  assert.equal(view.getUint16(34, true), 16, "bitsPerSample");

  // data chunk
  assert.equal(ascii(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), dataSize, "data chunk size");
});

test("encodeWavFromMono converts float samples to int16 and clamps out-of-range", () => {
  const samples = new Float32Array([0, 1, -1, 1.5, -2]);
  const buf = encodeWavFromMono(samples, 16000);
  const view = new DataView(buf);
  const at = (i) => view.getInt16(44 + i * 2, true);
  assert.equal(at(0), 0); // silence
  assert.equal(at(1), 32767); // +1.0 -> max
  assert.equal(at(2), -32768); // -1.0 -> min
  assert.equal(at(3), 32767); // +1.5 clamped to +1.0
  assert.equal(at(4), -32768); // -2.0 clamped to -1.0
});

test("encodeWavFromMono handles an empty sample buffer (header only)", () => {
  const buf = encodeWavFromMono(new Float32Array([]), 16000);
  const view = new DataView(buf);
  assert.equal(buf.byteLength, 44);
  assert.equal(view.getUint32(40, true), 0, "zero-length data chunk");
  assert.equal(ascii(view, 0, 4), "RIFF");
});
