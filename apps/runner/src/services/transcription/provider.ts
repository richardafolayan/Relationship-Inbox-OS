/**
 * Minimal provider interface for speech-to-text. v1 ships one
 * implementation (OpenAI file transcription). The interface exists so
 * tests can inject a fake without touching the network, and so a future
 * second provider (local Whisper, when cost forces it) is a single new
 * file rather than a refactor.
 *
 * Realtime / streaming providers are intentionally out of scope. Stored
 * voice notes are files; the provider contract is file in, text out.
 */

export interface TranscriptionRequest {
  /** Absolute path to a file the provider can read. */
  filePath: string;
  /** MIME type. Used both for the upload and for skip decisions upstream. */
  mimeType: string;
  /** Original filename, used by some providers as a hint. */
  filename: string;
  /** BCP-47 language hint (e.g. "en"). */
  language?: string;
  /** Provider-specific model id, resolved by config. */
  model: string;
}

export interface TranscriptionSuccess {
  text: string;
  /** Detected language returned by the provider, when available. */
  language?: string;
  /** Duration in whole seconds, when the provider returns one. */
  durationSeconds?: number;
  /** Echo of the model id actually used. */
  model: string;
}

export type TranscriptionOutcome =
  | { kind: "ok"; result: TranscriptionSuccess }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; errorMessage: string };

export type TranscriptionProviderId = "openai" | "local-whisper" | "transformers";

export interface TranscriptionProvider {
  readonly id: TranscriptionProviderId;
  /**
   * Stable human-readable identifier persisted on each
   * `MessageAudioTranscription` row's `model` column. For OpenAI this
   * is the audio model id (`gpt-4o-mini-transcribe`); for local
   * Whisper it's the basename of the ggml model file
   * (`ggml-base.en.bin`). Lets the operator see in the DB which
   * physical model produced a given transcript without having to
   * track env state.
   */
  readonly modelLabel: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionOutcome>;
}
