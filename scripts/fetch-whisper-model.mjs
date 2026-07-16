#!/usr/bin/env node
//
// Tovi: download an optional local speech-to-text model.
//
// Voice-note transcription runs locally via transformers.js + ONNX Runtime.
// The setup assistant invokes this only after the operator chooses a model.
//
//   npm run fetch:whisper-model
//
// Override the model or location with AUDIO_TRANSCRIPTION_LOCAL_MODEL and
// TRANSCRIPTION_MODEL_DIR. The model lives under data/ so it survives app
// updates.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() : undefined;
}

const modelId = (
  option("--model") || process.env.AUDIO_TRANSCRIPTION_LOCAL_MODEL || "Xenova/whisper-base.en"
).trim();
const modelDir = resolve(
  (option("--dir") || process.env.TRANSCRIPTION_MODEL_DIR || resolve(APP_DIR, "data", "models")).trim()
);

function directoryBytes(path) {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : entry.isFile() ? statSync(child).size : 0);
  }, 0);
}

mkdirSync(modelDir, { recursive: true });
console.log(`Downloading the voice-transcription model "${modelId}"`);
console.log(`into ${modelDir}...`);

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
const markerPath = join(modelDir, ".tovi-transcription-model.json");
const bytes = directoryBytes(modelDir);
writeFileSync(
  markerPath,
  `${JSON.stringify({ modelId, downloadedAt: new Date().toISOString(), bytes }, null, 2)}\n`,
  "utf8"
);
console.log("Voice-transcription model ready.");
