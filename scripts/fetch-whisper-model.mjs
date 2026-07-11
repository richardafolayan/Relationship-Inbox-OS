#!/usr/bin/env node
//
// Tovi — download the local speech-to-text model.
//
// Voice-note transcription (the pilot default) runs locally via
// transformers.js + ONNX Runtime — no external binary, no Xcode/Homebrew.
// This downloads the model ONCE into data/models so a fresh install
// transcribes voice notes out of the box. The installer runs it
// automatically; you can re-run it any time (it reuses cached files):
//
//   npm run fetch:whisper-model
//
// Override the model or location with AUDIO_TRANSCRIPTION_LOCAL_MODEL and
// TRANSCRIPTION_MODEL_DIR. The model lives under data/ so it survives app
// updates.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelId = (process.env.AUDIO_TRANSCRIPTION_LOCAL_MODEL || "Xenova/whisper-base.en").trim();
const modelDir = resolve(
  (process.env.TRANSCRIPTION_MODEL_DIR || resolve(APP_DIR, "data", "models")).trim()
);

mkdirSync(modelDir, { recursive: true });
console.log(`Downloading the voice-transcription model "${modelId}"`);
console.log(`into ${modelDir} (one-time, ~150 MB)...`);

let tf;
try {
  tf = await import("@huggingface/transformers");
} catch (error) {
  console.error(
    "Could not load @huggingface/transformers. Run `npm install` first, then retry."
  );
  console.error(String(error?.message ?? error));
  process.exit(1);
}

tf.env.cacheDir = modelDir;
tf.env.allowLocalModels = true;

try {
  const transcriber = await tf.pipeline("automatic-speech-recognition", modelId);
  // Force a full model init with one second of silence so the first real
  // transcription is instant and any download/decode error surfaces now.
  await transcriber(new Float32Array(16000));
} catch (error) {
  console.error("Model download / initialisation failed.");
  console.error(String(error?.message ?? error));
  process.exit(1);
}

const files = existsSync(modelDir) ? readdirSync(modelDir) : [];
if (files.length === 0) {
  console.error(`Model directory is empty after download: ${modelDir}`);
  process.exit(1);
}
console.log("Voice-transcription model ready.");
