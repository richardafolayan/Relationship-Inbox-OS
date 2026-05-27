export { buildAudioFingerprint } from "./fingerprint";
export {
  collectAudioAttachments,
  createTranscriptionService,
  type AttachmentResolution,
  type AttachmentResolver,
  type TranscribeMessageOutcome,
  type TranscriptionService,
  type TranscriptionServiceConfig
} from "./transcription-service";
export { createOpenAITranscriptionProvider } from "./openai-provider";
export {
  buildWhisperArgs,
  createLocalWhisperProvider,
  type LocalWhisperProviderConfig,
  type ProcessRunner
} from "./local-whisper-provider";
export type {
  TranscriptionOutcome,
  TranscriptionProvider,
  TranscriptionProviderId,
  TranscriptionRequest,
  TranscriptionSuccess
} from "./provider";
