export { buildAudioFingerprint } from "./fingerprint";
export {
  collectAudioAttachments,
  createTranscriptionService,
  selectBestTranscript,
  type AttachmentResolution,
  type AttachmentResolver,
  type AttemptTier,
  type NearbyMessagesResolver,
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
export {
  buildUserPrompt as buildRefinementUserPrompt,
  createTextRefinementService,
  parseAndSanitise as parseRefinementResponse,
  type ChatCompletionsClient,
  type PatchConfidence,
  type PatchType,
  type RefinementAttempt,
  type RefinementContext,
  type RefinementNearbyMessage,
  type RefinementOutcome,
  type RefinementPatch,
  type RefinementServiceConfig,
  type RefinementSuccess,
  type TextRefinementService
} from "./text-refinement-service";
export {
  applyRefinementPatches,
  deriveOverallConfidence,
  introducesNewDuplicate,
  type AppliedPatch,
  type DroppedPatch,
  type DroppedReason,
  type PatchApplicationResult
} from "./refinement-patches";
