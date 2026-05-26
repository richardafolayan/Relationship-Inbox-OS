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

export interface TranscriptionProvider {
  readonly id: "openai";
  transcribe(request: TranscriptionRequest): Promise<TranscriptionOutcome>;
}
