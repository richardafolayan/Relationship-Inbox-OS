import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import type {
  TranscriptionOutcome,
  TranscriptionProvider,
  TranscriptionRequest
} from "./provider";

/**
 * OpenAI file-transcription provider. Posts the audio to
 * `/v1/audio/transcriptions` (via the SDK's `audio.transcriptions.create`)
 * and normalises the response into the shared TranscriptionOutcome shape.
 *
 * v1 wires only the file path. Streaming / realtime transcription
 * (`gpt-realtime-whisper` and similar) is not used here: stored voice
 * notes are files, and the file endpoint is the cheaper and simpler fit.
 * See the audio transcription section in docs/reference.md for the
 * rationale.
 */
export function createOpenAITranscriptionProvider(input: {
  apiKey: string;
  /** Override factory for tests. */
  clientFactory?: (apiKey: string) => OpenAI;
}): TranscriptionProvider {
  const client = input.clientFactory
    ? input.clientFactory(input.apiKey)
    : new OpenAI({ apiKey: input.apiKey });

  return {
    id: "openai",
    async transcribe(request: TranscriptionRequest): Promise<TranscriptionOutcome> {
      if (!existsSync(request.filePath)) {
        return { kind: "skipped", reason: "audio file missing on disk" };
      }
      try {
        // The SDK's `toFile` helper builds the multipart upload from a
        // readable stream; using a stream (rather than reading the whole
        // file into memory) keeps the runner steady on long voice notes.
        const upload = await toFile(
          createReadStream(request.filePath),
          basename(request.filename || request.filePath),
          { type: request.mimeType }
        );
        // gpt-4o-mini-transcribe and gpt-4o-transcribe only accept the
        // plain `json` response format; `verbose_json` (which carries
        // duration + language) is whisper-1 only. Sticking with `json`
        // keeps the request shape consistent across both modern
        // transcription models; the duration / language fields below
        // gracefully stay undefined when the response omits them.
        const response = await client.audio.transcriptions.create({
          file: upload,
          model: request.model,
          language: request.language,
          response_format: "json"
        });
        // The shape varies subtly between models; treat everything beyond
        // `text` as optional to stay forward-compatible.
        const text = typeof response.text === "string" ? response.text.trim() : "";
        if (!text) {
          return { kind: "skipped", reason: "empty transcription" };
        }
        const verbose = response as unknown as {
          duration?: number;
          language?: string;
        };
        return {
          kind: "ok",
          result: {
            text,
            language: typeof verbose.language === "string" ? verbose.language : undefined,
            durationSeconds:
              typeof verbose.duration === "number" && Number.isFinite(verbose.duration)
                ? Math.round(verbose.duration)
                : undefined,
            model: request.model
          }
        };
      } catch (error) {
        return {
          kind: "failed",
          errorMessage: shortenError(error)
        };
      }
    }
  };
}

/**
 * Reduce a thrown error to a short, log-safe string. Avoids dumping the
 * raw OpenAI response body (which can echo bits of the audio metadata)
 * into a stored row that's later shown in the dashboard.
 */
function shortenError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 200 ? `${error.message.slice(0, 200)}...` : error.message;
  }
  const text = String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}
