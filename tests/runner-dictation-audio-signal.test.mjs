import assert from "node:assert/strict";
import test from "node:test";

const { analyzeMonoPcm16Wav, hasAudibleSpeechSignal } = await import(
  "../apps/runner/src/services/transcription/audio-signal.ts"
);
const { encodeWavFromMono } = await import("../apps/dashboard/lib/dictation-audio.ts");

function wavBuffer(samples) {
  return Buffer.from(encodeWavFromMono(samples, 16000));
}

test("silent recordings are rejected before Whisper can hallucinate text", () => {
  const summary = analyzeMonoPcm16Wav(wavBuffer(new Float32Array(16000)));
  assert.equal(summary.durationSeconds, 1);
  assert.equal(summary.peak, 0);
  assert.equal(summary.rms, 0);
  assert.equal(hasAudibleSpeechSignal(summary), false);
});

test("a normal speech-level signal passes the dictation guard", () => {
  const samples = Float32Array.from({ length: 16000 }, (_, index) =>
    Math.sin((index / 16000) * Math.PI * 2 * 220) * 0.08
  );
  const summary = analyzeMonoPcm16Wav(wavBuffer(samples));
  assert.ok(summary.peak > 0.07);
  assert.ok(summary.rms > 0.05);
  assert.equal(hasAudibleSpeechSignal(summary), true);
});

test("a click shorter than speech is rejected even when its peak is high", () => {
  const samples = Float32Array.from({ length: 1600 }, () => 0.2);
  assert.equal(hasAudibleSpeechSignal(analyzeMonoPcm16Wav(wavBuffer(samples))), false);
});
