import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { convertAudioToWhisperWav } from "../imessage-attachment-server";
import type {
  TranscriptionOutcome,
  TranscriptionProvider,
  TranscriptionRequest
} from "./provider";

/**
 * Local speech-to-text via transformers.js + ONNX Runtime — the pilot
 * default. Unlike the whisper.cpp provider it needs NO external binary and
 * NO build tools (Xcode/Homebrew): `@huggingface/transformers` ships a
 * prebuilt onnxruntime-node, and the ONNX model is downloaded into a local
 * cache dir on install (see scripts/fetch-whisper-model.mjs). So a fresh
 * student install transcribes voice notes out of the box.
 *
 * The heavy library is imported lazily (dynamic import inside the loader)
 * so the runner only pays for it when transcription is actually enabled,
 * and the model/pipeline is built once and reused across calls.
 */

/** The transformers.js ASR pipeline shape we depend on. */
export type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>
) => Promise<{ text?: string } | Array<{ text?: string }>>;

export interface TransformersWhisperProviderConfig {
  /** transformers.js model id, e.g. "Xenova/whisper-base.en". */
  modelId: string;
  /** Absolute dir the model files are cached in (lives under data/). */
  modelDir: string;
  /** Per-call + load wall-clock budget in ms. */
  timeoutMs: number;
  /** Human label persisted on the row; defaults to the model id basename. */
  modelLabel?: string;
}

/** Builds (and caches) the ASR pipeline. Overridable in tests. */
export type PipelineLoader = (
  modelId: string,
  modelDir: string
) => Promise<AsrPipeline>;

const realPipelineLoader: PipelineLoader = async (modelId, modelDir) => {
  // Lazy dynamic import: the (heavy) dep + onnxruntime only load when
  // transcription is enabled and a voice note is actually processed.
  const tf = await import("@huggingface/transformers");
  // Load from our on-disk cache (populated at install time); fall back to
  // a network download if a pilot skipped the fetch step.
  tf.env.cacheDir = modelDir;
  tf.env.allowLocalModels = true;
  const pipe = await tf.pipeline("automatic-speech-recognition", modelId);
  return (audio, options) => pipe(audio, options) as ReturnType<AsrPipeline>;
};

/**
 * Parse a 16 kHz mono 16-bit PCM WAV into a normalised Float32Array, which
 * is what the transformers.js ASR pipeline expects. We reuse the same
 * `afconvert` step local-whisper uses to produce that WAV shape.
 */
export function readMonoPcm16Wav(path: string): Float32Array {
  const buf = readFileSync(path);
  // Walk RIFF chunks from byte 12 (after "RIFF"<size>"WAVE") to find "data".
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, buf.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }
  if (dataOffset < 0) throw new Error("wav: no data chunk found");
  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return samples;
}

export function createTransformersWhisperProvider(input: {
  config: TransformersWhisperProviderConfig;
  /** Test seam: override the afconvert -> WAV step. */
  convertToWav?: (absolutePath: string) => Promise<string | null>;
  /** Test seam: override the (heavy) pipeline loader. */
  pipelineLoader?: PipelineLoader;
}): TranscriptionProvider {
  const { config } = input;
  const wavConverter = input.convertToWav ?? convertAudioToWhisperWav;
  const loader = input.pipelineLoader ?? realPipelineLoader;
  const label = config.modelLabel || basename(config.modelId) || "whisper";

  // Build the pipeline once, lazily. On failure we reset the cached promise
  // so a later call can retry (e.g. after the model finishes downloading).
  let pipelinePromise: Promise<AsrPipeline> | null = null;
  function getPipeline(): Promise<AsrPipeline> {
    if (!pipelinePromise) {
      pipelinePromise = loader(config.modelId, config.modelDir).catch((error) => {
        pipelinePromise = null;
        throw error;
      });
    }
    return pipelinePromise;
  }

  return {
    id: "transformers",
    modelLabel: label,
    async transcribe(request: TranscriptionRequest): Promise<TranscriptionOutcome> {
      // whisper wants 16 kHz mono PCM; reuse the afconvert path.
      const wavPath = await wavConverter(request.filePath);
      if (!wavPath) {
        return { kind: "skipped", reason: "transformers_conversion_failed" };
      }

      let samples: Float32Array;
      try {
        samples = readMonoPcm16Wav(wavPath);
      } catch (error) {
        return { kind: "failed", errorMessage: shortenError(error) };
      }
      if (samples.length === 0) {
        return { kind: "skipped", reason: "transformers_empty_audio" };
      }

      let pipe: AsrPipeline;
      try {
        pipe = await withTimeout(getPipeline(), config.timeoutMs, "model_load_timeout");
      } catch {
        // Model missing / failed to load -> retryable skip so the dashboard
        // offers a retry once the model is fetched.
        return { kind: "skipped", reason: "transformers_model_unavailable" };
      }

      try {
        const options =
          request.language && request.language.trim().length > 0
            ? { language: request.language.trim() }
            : undefined;
        const out = await withTimeout(
          Promise.resolve(pipe(samples, options)),
          config.timeoutMs,
          "transcribe_timeout"
        );
        const raw = Array.isArray(out) ? out[0]?.text : out?.text;
        const text = (raw ?? "").trim();
        if (text.length === 0) {
          return { kind: "skipped", reason: "transformers_empty_output" };
        }
        return { kind: "ok", result: { text, model: label } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "transcribe_timeout") {
          return { kind: "failed", errorMessage: "transformers_timeout" };
        }
        return { kind: "failed", errorMessage: shortenError(error) };
      }
    }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function shortenError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}
