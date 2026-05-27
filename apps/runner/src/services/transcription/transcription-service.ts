import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { AttachmentPlaceholder } from "@inbox-os/core";
import { convertCafToM4a, convertVideoToAudioM4a } from "../imessage-attachment-server";
import { buildAudioFingerprint } from "./fingerprint";
import type {
  TranscriptionOutcome,
  TranscriptionProvider,
  TranscriptionRequest
} from "./provider";
import {
  pickHigherTier,
  selectBestTranscript,
  type Attempt as SelectorAttempt,
  type AttemptTier,
  type SelectedTranscript
} from "./selection";
import type {
  RefinementContext,
  RefinementNearbyMessage,
  TextRefinementService
} from "./text-refinement-service";

/**
 * MIME types OpenAI's audio.transcriptions endpoint accepts directly.
 * Apple's .caf voice notes are NOT in this list and must be converted
 * to m4a (audio/mp4) first via the shared `convertCafToM4a` helper
 * (also used by the dashboard's audio playback path).
 */
const SUPPORTED_MIME_TYPES = new Set<string>([
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/flac",
  "audio/x-flac"
]);

/**
 * Apple identifies voice notes either by mime (`audio/x-caf` /
 * `com.apple.coreaudio-format`) or by the magic filename "Audio
 * Message.caf". We accept both and route them through afconvert.
 */
function isCafSource(input: { mimeType: string | null; filename: string | null; transferName: string | null }): boolean {
  const mime = (input.mimeType ?? "").toLowerCase();
  const name = (input.transferName ?? input.filename ?? "").toLowerCase();
  if (mime.includes("caf") || mime.includes("coreaudio")) return true;
  if (/\.caf($|\?)/.test(name)) return true;
  if (name.includes("audio message")) return true;
  return false;
}

/**
 * Whether the attachment is a video the audio-extractor should run on.
 * iMessage videos arrive as `.mov` (QuickTime) most of the time but
 * occasionally `.mp4`; both are accepted by macOS `afconvert`.
 */
function isVideoSource(input: {
  kind: string | undefined;
  mimeType: string | null;
  filename: string | null;
  transferName: string | null;
}): boolean {
  if (input.kind === "video") return true;
  const mime = (input.mimeType ?? "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  const name = (input.transferName ?? input.filename ?? "").toLowerCase();
  if (/\.(mov|mp4|m4v)($|\?)/.test(name)) return true;
  return false;
}

/**
 * Resolve a stored audio attachment to a (path, mime) the provider can
 * upload. Returns `null` when the attachment cannot be located on disk
 * or cannot be converted to a supported format; callers treat null as
 * "skip silently".
 */
export interface AttachmentResolution {
  absolutePath: string;
  mimeType: string;
  filename: string;
  /** True when the audio is already in a provider-accepted format. */
  ready: boolean;
}

export interface AttachmentResolver {
  /**
   * Given an attachment's platform-side identifier (iMessage guid), return
   * the file metadata needed to upload it. Implementations should read
   * the platform's authoritative store (chat.db for iMessage) and never
   * trust the dashboard's attachmentsJson alone.
   */
  resolve(attachmentId: string): Promise<{
    absolutePath: string;
    mimeType: string | null;
    filename: string | null;
    transferName: string | null;
  } | null>;
}

export interface TranscriptionServiceConfig {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  language: string;
  maxBytes: number;
  maxSeconds: number;
}

/**
 * Optional nearby-thread fetcher for the refinement step. The runner
 * passes a closure that hits the same Prisma instance as the rest of
 * the service. Pulled out as a typed dep so tests can stub it without
 * mocking the full prisma message model.
 */
export interface NearbyMessagesResolver {
  fetch(input: {
    messageId: string;
    threadId: string;
    /** Approx number of messages before/after to return. */
    radius: number;
  }): Promise<RefinementNearbyMessage[]>;
}

interface TranscriptionServiceDeps {
  prisma: PrismaClient;
  /**
   * Single-model mode. When `providers` (below) is not given, the
   * service falls back to this single-provider behaviour and the
   * pipeline matches the pre-progressive shape (one row in
   * `MessageAudioTranscription`, no attempt history). Existing tests
   * exercise this path.
   */
  provider: TranscriptionProvider | null;
  /**
   * Progressive (multi-tier) mode. When set, each configured tier is
   * run sequentially; the highest-tier successful transcript becomes
   * `MessageAudioTranscription.transcript`. Raw output of every tier
   * is preserved in `MessageAudioTranscriptionAttempt`.
   *
   * Missing tier keys are simply skipped — the runner doesn't have to
   * configure all three.
   */
  providers?: Partial<Record<"fast" | "standard" | "max", TranscriptionProvider>>;
  /**
   * Optional text-only refinement step. Runs after the local tiers in
   * progressive mode. When undefined or null, refinement is skipped.
   * The refiner itself enforces "no client → skip cleanly" so we don't
   * have to gate on auth here.
   */
  refiner?: TextRefinementService | null;
  /**
   * Whether refinement is enabled by the operator. Even when `refiner`
   * is non-null we keep this flag separate so the runner can flip
   * refinement off without rewiring deps.
   */
  refinementEnabled?: boolean;
  /**
   * Pulls a few nearby messages for the refinement prompt. When not
   * provided, refinement runs with an empty nearby-messages list; the
   * refiner is still useful for clear ASR errors but loses context
   * disambiguation.
   */
  nearbyMessages?: NearbyMessagesResolver | null;
  attachmentResolver: AttachmentResolver | null;
  config: TranscriptionServiceConfig;
  /**
   * Optional override for the per-attachment conversion step. Defaults
   * to the shared `convertCafToM4a` helper exported by
   * `services/imessage-attachment-server`. Tests stub this to skip the
   * macOS-only afconvert dependency.
   */
  convertCafToM4a?: (absolutePath: string) => Promise<string | null>;
  /**
   * Optional override for the video-to-audio extractor. Defaults to the
   * shared `convertVideoToAudioM4a` helper. Tests stub this to skip
   * macOS-only afconvert when running on CI / Linux.
   */
  convertVideoToAudioM4a?: (absolutePath: string) => Promise<string | null>;
  /** Log channel; defaults to console.warn. Tests stub to silence noise. */
  warn?: (message: string) => void;
}

export interface TranscribeMessageOptions {
  /**
   * When true, an existing transcription row for the same message is
   * deleted before the attempt. Used by the manual "Try again"
   * affordance in the dashboard: if a previous run wrote a
   * `missing_file` skip because the audio hadn't downloaded yet from
   * iCloud, the operator can ask the runner to re-check. Auto-scan
   * never sets this — message-level dedup keeps scans cheap.
   *
   * In progressive mode, force=true cascade-deletes the attempts too
   * (the parent row's onDelete: Cascade handles this for us).
   */
  force?: boolean;
}

export interface TranscriptionService {
  /** Fire-and-forget; never throws. Scans must not block on this. */
  enqueueMessage(messageId: string): void;
  /**
   * Synchronous entrypoint for tests and the manual "Transcribe / Try
   * again" affordance. Resolves to a brief outcome summary so callers
   * can log without re-querying the DB. Set `force: true` to bypass
   * message-level dedup and re-attempt against the current disk state.
   */
  transcribeMessage(
    messageId: string,
    options?: TranscribeMessageOptions
  ): Promise<TranscribeMessageOutcome>;
}

export type TranscribeMessageOutcome =
  | { kind: "disabled" }
  | { kind: "no_audio" }
  | { kind: "missing_message" }
  | {
      kind: "processed";
      attachments: number;
      ok: number;
      failed: number;
      skipped: number;
    };

/**
 * Internal shape returned by `prepareRequest`: either a ready-to-send
 * TranscriptionRequest, or a skip reason that should be persisted as
 * the parent row's terminal state. Centralised so single-mode and
 * progressive mode share identical conversion + size-cap behaviour.
 */
type PreparedRequest =
  | { kind: "ok"; request: TranscriptionRequest; resolvedPath: string }
  | { kind: "skipped"; reason: string };

export function createTranscriptionService(deps: TranscriptionServiceDeps): TranscriptionService {
  const warn = deps.warn ?? ((message) => console.warn(message));
  const cafConverter = deps.convertCafToM4a ?? convertCafToM4a;
  const videoAudioExtractor = deps.convertVideoToAudioM4a ?? convertVideoToAudioM4a;
  const inflight = new Set<string>();
  // Retention-warning state. Emit a single calm warning per process the
  // first time we see a missing-file skip while transcription is on, so
  // the operator notices their Messages audio retention window is
  // expiring files before the runner can transcribe them. Re-armed
  // after RETENTION_WARNING_COOLDOWN_MS so a long-running process
  // surfaces the warning again if the situation repeats hours later.
  const RETENTION_WARNING_COOLDOWN_MS = 6 * 60 * 60 * 1000;
  let retentionWarningAt = 0;

  // Progressive mode is active when at least one tier provider is
  // wired. The runner decides which tiers to populate based on the
  // operator's env config — we don't second-guess it here. The tier
  // type is narrowed to the local tiers only; refinement is handled
  // separately and never appears in this list.
  type LocalTier = "fast" | "standard" | "max";
  const progressiveTiers: LocalTier[] = [];
  if (deps.providers?.fast) progressiveTiers.push("fast");
  if (deps.providers?.standard) progressiveTiers.push("standard");
  if (deps.providers?.max) progressiveTiers.push("max");
  const progressiveActive = progressiveTiers.length > 0;

  function enqueueMessage(messageId: string): void {
    if (!deps.config.enabled) return;
    if (inflight.has(messageId)) return;
    inflight.add(messageId);
    queueMicrotask(() => {
      void transcribeMessage(messageId)
        .catch((error) => {
          warn(
            `[transcription] unhandled error for message ${messageId}: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          inflight.delete(messageId);
        });
    });
  }

  async function transcribeMessage(
    messageId: string,
    options: TranscribeMessageOptions = {}
  ): Promise<TranscribeMessageOutcome> {
    if (!deps.config.enabled) return { kind: "disabled" };
    if (!progressiveActive && !deps.provider) {
      // Defensive: a misconfigured runner (enabled but no provider /
      // resolver wired up) bails before touching prisma.
      return { kind: "disabled" };
    }
    if (!deps.attachmentResolver) return { kind: "disabled" };

    const message = await deps.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        platformMessageKey: true,
        threadId: true,
        direction: true,
        attachmentsJson: true
      }
    });
    if (!message) return { kind: "missing_message" };

    const audioAttachments = collectAudioAttachments(message.attachmentsJson);
    if (audioAttachments.length === 0) return { kind: "no_audio" };

    // Message-level dedup: any prior row for this message wins by
    // default. The schema enforces one row per messageId. The manual
    // "Try again" affordance passes options.force to bypass dedup;
    // see force-handling below.
    const existingForMessage = await deps.prisma.messageAudioTranscription.findUnique({
      where: { messageId },
      select: { id: true, status: true }
    });

    if (existingForMessage && !options.force) {
      // Already processed. Don't re-enter the loop, don't run more
      // tiers, don't bill OpenAI / spin whisper.cpp.
      return {
        kind: "processed",
        attachments: audioAttachments.length,
        ok: 0,
        failed: 0,
        skipped: 1
      };
    }
    if (existingForMessage && options.force) {
      // Cascade-deletes attempts too. Progressive force-retry starts
      // completely fresh.
      await deps.prisma.messageAudioTranscription.delete({
        where: { messageId }
      });
    }

    if (progressiveActive) {
      return runProgressive({
        message,
        attachments: audioAttachments
      });
    }
    return runSingleModel({
      message,
      attachments: audioAttachments
    });
  }

  // -------------------------------------------------------------------
  // Single-model orchestration (pre-progressive behaviour).
  //
  // Preserved verbatim from the previous service so existing operators
  // and tests keep working when no `providers` map is wired. Writes
  // exactly one row to MessageAudioTranscription per message, no
  // attempts.
  // -------------------------------------------------------------------
  async function runSingleModel(input: {
    message: { id: string; platformMessageKey: string };
    attachments: Array<{ attachment: AttachmentPlaceholder; index: number }>;
  }): Promise<TranscribeMessageOutcome> {
    const { message, attachments } = input;
    let ok = 0;
    let failed = 0;
    let skipped = 0;

    for (const { attachment, index } of attachments) {
      const fingerprint = buildAudioFingerprint({
        platformMessageKey: message.platformMessageKey,
        attachmentGuid: attachment.guid,
        attachmentIndex: index
      });
      const attachmentId = attachment.guid ?? `idx-${index}`;
      const prepared = await prepareRequest(attachment, deps.provider!.modelLabel);

      if (prepared.kind === "skipped") {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            messageId: message.id,
            attachmentId,
            audioFingerprint: fingerprint,
            status: "skipped",
            errorMessage: prepared.reason
          }
        });
        skipped += 1;
        maybeRetentionWarn(prepared.reason);
        break;
      }

      const outcome = await deps.provider!.transcribe(prepared.request);
      if (outcome.kind === "ok") {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            messageId: message.id,
            attachmentId,
            audioFingerprint: fingerprint,
            status: "transcribed",
            transcript: outcome.result.text,
            provider: deps.provider!.id,
            model: outcome.result.model || deps.provider!.modelLabel,
            language: outcome.result.language ?? deps.config.language,
            durationSeconds: outcome.result.durationSeconds ?? null,
            errorMessage: null,
            selectedTier: null,
            selectedModel: outcome.result.model || deps.provider!.modelLabel,
            selectedProvider: deps.provider!.id
          }
        });
        ok += 1;
      } else if (outcome.kind === "skipped") {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            messageId: message.id,
            attachmentId,
            audioFingerprint: fingerprint,
            status: "skipped",
            errorMessage: outcome.reason
          }
        });
        skipped += 1;
        maybeRetentionWarn(outcome.reason);
      } else {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            messageId: message.id,
            attachmentId,
            audioFingerprint: fingerprint,
            status: "failed",
            provider: deps.provider!.id,
            model: deps.provider!.modelLabel,
            errorMessage: outcome.errorMessage
          }
        });
        failed += 1;
        warn(
          `[transcription] failed message=${message.id} attachment=${attachmentId}: ${outcome.errorMessage}`
        );
      }
      // One row per messageId by schema constraint — never iterate.
      break;
    }
    return { kind: "processed", attachments: attachments.length, ok, failed, skipped };
  }

  // -------------------------------------------------------------------
  // Progressive (multi-tier) orchestration.
  //
  // Creates a parent MessageAudioTranscription row, runs each
  // configured tier in sequence (fast → standard → max), writes one
  // MessageAudioTranscriptionAttempt per tier, and updates the parent's
  // selected transcript whenever a higher tier succeeds. Optionally
  // runs GPT-5-nano text refinement at the end.
  // -------------------------------------------------------------------
  async function runProgressive(input: {
    message: {
      id: string;
      platformMessageKey: string;
      threadId: string;
      direction: "IN" | "OUT" | string;
    };
    attachments: Array<{ attachment: AttachmentPlaceholder; index: number }>;
  }): Promise<TranscribeMessageOutcome> {
    const { message, attachments } = input;

    // We only process the first audio attachment per message (matches
    // single-mode behaviour). Voice notes with multiple voice tracks
    // are vanishingly rare on iMessage.
    const first = attachments[0];
    if (!first) {
      return { kind: "processed", attachments: 0, ok: 0, failed: 0, skipped: 0 };
    }
    const { attachment, index } = first;
    const fingerprint = buildAudioFingerprint({
      platformMessageKey: message.platformMessageKey,
      attachmentGuid: attachment.guid,
      attachmentIndex: index
    });
    const attachmentId = attachment.guid ?? `idx-${index}`;

    // Resolve + convert ONCE, then loop providers. The converted
    // (m4a) file is reused across all three tier calls — afconvert's
    // cache makes this cheap even if we re-entered.
    const prepared = await prepareRequest(attachment, "" /* model resolved per-tier */);
    if (prepared.kind === "skipped") {
      // Pre-tier skip (missing file, unsupported mime, etc.) becomes
      // the parent row terminal state. No attempt rows: no provider
      // was ever asked.
      await deps.prisma.messageAudioTranscription.create({
        data: {
          messageId: message.id,
          attachmentId,
          audioFingerprint: fingerprint,
          status: "skipped",
          errorMessage: prepared.reason
        }
      });
      maybeRetentionWarn(prepared.reason);
      return {
        kind: "processed",
        attachments: attachments.length,
        ok: 0,
        failed: 0,
        skipped: 1
      };
    }

    // Pre-create the parent row in `pending` state so attempt rows
    // have a FK target. The selected transcript is filled in as
    // tiers complete.
    const parent = await deps.prisma.messageAudioTranscription.create({
      data: {
        messageId: message.id,
        attachmentId,
        audioFingerprint: fingerprint,
        status: "pending",
        language: deps.config.language
      }
    });

    let ok = 0;
    let failed = 0;
    let skipped = 0;
    let currentSelection: SelectedTranscript | null = null;
    const liveAttempts: SelectorAttempt[] = [];

    for (const tier of progressiveTiers) {
      const provider = deps.providers![tier]!;
      const tierRequest: TranscriptionRequest = {
        ...prepared.request,
        model: provider.modelLabel || deps.config.model
      };
      const startedAt = Date.now();
      const outcome = await provider.transcribe(tierRequest);
      const elapsed = Date.now() - startedAt;

      const attemptBase = {
        transcriptionId: parent.id,
        tier,
        provider: provider.id,
        model: provider.modelLabel || outcome.kind === "ok" ? provider.modelLabel : provider.modelLabel,
        durationMs: elapsed
      };

      if (outcome.kind === "ok") {
        const text = outcome.result.text?.trim() ?? "";
        if (text.length === 0) {
          // Empty transcript is recorded as a skip so the selector
          // doesn't pick it up but we still have a row for debugging.
          await deps.prisma.messageAudioTranscriptionAttempt.create({
            data: {
              ...attemptBase,
              status: "skipped",
              errorMessage: "empty_output"
            }
          });
          skipped += 1;
          continue;
        }
        await deps.prisma.messageAudioTranscriptionAttempt.create({
          data: {
            ...attemptBase,
            status: "transcribed",
            transcript: text,
            errorMessage: null
          }
        });
        liveAttempts.push({
          tier,
          model: provider.modelLabel,
          provider: provider.id,
          status: "transcribed",
          transcript: text
        });
        const candidate: SelectedTranscript = {
          tier,
          model: provider.modelLabel,
          provider: provider.id,
          transcript: text
        };
        const previousSelection = currentSelection;
        currentSelection = pickHigherTier(currentSelection, candidate);
        if (currentSelection === candidate) {
          // New higher-tier transcript: update parent. If we're
          // replacing a previously selected transcript, flag the
          // thread for AI refresh.
          await deps.prisma.messageAudioTranscription.update({
            where: { id: parent.id },
            data: {
              transcript: text,
              provider: provider.id,
              model: provider.modelLabel,
              status: "transcribed",
              selectedTier: tier,
              selectedModel: provider.modelLabel,
              selectedProvider: provider.id,
              errorMessage: null,
              needsAiRefresh: previousSelection !== null
            }
          });
        }
        ok += 1;
      } else if (outcome.kind === "skipped") {
        await deps.prisma.messageAudioTranscriptionAttempt.create({
          data: {
            ...attemptBase,
            status: "skipped",
            errorMessage: outcome.reason
          }
        });
        skipped += 1;
      } else {
        await deps.prisma.messageAudioTranscriptionAttempt.create({
          data: {
            ...attemptBase,
            status: "failed",
            errorMessage: outcome.errorMessage
          }
        });
        failed += 1;
        warn(
          `[transcription] tier=${tier} failed message=${message.id} attachment=${attachmentId}: ${outcome.errorMessage}`
        );
      }
    }

    // Refinement runs only when:
    //   - operator enabled it
    //   - we have a refiner wired
    //   - at least one local tier produced a non-empty transcript
    //   - at least the `standard` tier completed successfully (the
    //     refiner needs reliable text to compare against; fast alone
    //     isn't trustworthy enough to justify the token cost)
    const standardOrMaxSucceeded = liveAttempts.some(
      (a) => a.tier === "standard" || a.tier === "max"
    );
    if (
      deps.refinementEnabled &&
      deps.refiner &&
      standardOrMaxSucceeded
    ) {
      const nearby = deps.nearbyMessages
        ? await safeFetchNearby(deps.nearbyMessages, {
            messageId: message.id,
            threadId: message.threadId,
            radius: 8
          })
        : [];
      const refinementContext: RefinementContext = {
        messageId: message.id,
        threadId: message.threadId,
        direction: message.direction === "OUT" ? "OUT" : "IN",
        speakerRole: message.direction === "OUT" ? "operator" : "contact",
        attempts: liveAttempts.map((a) => ({
          tier: a.tier === "refinement" ? "max" : a.tier,
          model: a.model,
          transcript: a.transcript ?? ""
        })),
        nearbyMessages: nearby
      };
      const startedAt = Date.now();
      const outcome = await deps.refiner.refine(refinementContext);
      const elapsed = Date.now() - startedAt;

      const attemptBase = {
        transcriptionId: parent.id,
        tier: "refinement" as const,
        provider: "openai-text-refiner",
        durationMs: elapsed
      };
      if (outcome.kind === "ok") {
        await deps.prisma.messageAudioTranscriptionAttempt.create({
          data: {
            ...attemptBase,
            model: outcome.result.model,
            status: "transcribed",
            transcript: outcome.result.correctedTranscript,
            errorMessage: null
          }
        });
        // Refinement wins over any local tier when it passes the
        // sanitiser. Parent.transcript becomes the refined text;
        // refinedTranscript + refinementJson carry the audit trail.
        await deps.prisma.messageAudioTranscription.update({
          where: { id: parent.id },
          data: {
            transcript: outcome.result.correctedTranscript,
            selectedTier: "refinement",
            selectedModel: outcome.result.model,
            selectedProvider: "openai-text-refiner",
            refinedTranscript: outcome.result.correctedTranscript,
            refinementModel: outcome.result.model,
            refinementConfidence: outcome.result.confidence,
            refinementJson: outcome.result.rawJson,
            needsAiRefresh: currentSelection !== null
          }
        });
        currentSelection = {
          tier: "refinement",
          model: outcome.result.model,
          provider: "openai-text-refiner",
          transcript: outcome.result.correctedTranscript
        };
      } else if (outcome.kind === "skipped") {
        await deps.prisma.messageAudioTranscriptionAttempt.create({
          data: {
            ...attemptBase,
            model: deps.refiner ? "gpt-5-nano" : "unknown",
            status: "skipped",
            errorMessage: outcome.reason
          }
        });
      } else {
        await deps.prisma.messageAudioTranscriptionAttempt.create({
          data: {
            ...attemptBase,
            model: "gpt-5-nano",
            status: "failed",
            errorMessage: outcome.errorMessage
          }
        });
        warn(
          `[transcription] refinement failed message=${message.id}: ${outcome.errorMessage}`
        );
      }
    }

    // Final parent status: derive from attempt outcomes.
    if (currentSelection) {
      // Already wrote status="transcribed" + selected* fields in the
      // success branch above; no further update needed.
    } else {
      // No tier produced a usable transcript. Mark parent as skipped
      // (operator can manually retry) or failed if everything failed.
      const finalStatus = failed > 0 && skipped === 0 ? "failed" : "skipped";
      await deps.prisma.messageAudioTranscription.update({
        where: { id: parent.id },
        data: {
          status: finalStatus,
          errorMessage:
            finalStatus === "failed"
              ? "all_tiers_failed"
              : "all_tiers_skipped"
        }
      });
    }

    // Re-derive `ok` to reflect at-most-one-transcript-per-message:
    // even when multiple tiers succeeded, only one transcript was
    // selected. We expose the per-tier counts for log readability via
    // the parent updates above, but the public return shape stays
    // backwards-compatible.
    return {
      kind: "processed",
      attachments: attachments.length,
      ok: currentSelection ? 1 : 0,
      failed,
      skipped
    };
  }

  // -------------------------------------------------------------------
  // Helpers shared by single + progressive paths.
  // -------------------------------------------------------------------

  async function prepareRequest(
    attachment: AttachmentPlaceholder,
    defaultModelLabel: string
  ): Promise<PreparedRequest> {
    if (!attachment.guid) {
      return { kind: "skipped", reason: "attachment has no guid" };
    }
    const resolved = await deps.attachmentResolver!.resolve(attachment.guid);
    if (!resolved) return { kind: "skipped", reason: "missing_file" };
    if (!existsSync(resolved.absolutePath)) {
      return { kind: "skipped", reason: "missing_file" };
    }

    const sourceIsCaf = isCafSource({
      mimeType: resolved.mimeType,
      filename: resolved.filename,
      transferName: resolved.transferName
    });
    const sourceIsVideo =
      !sourceIsCaf &&
      isVideoSource({
        kind: attachment.kind,
        mimeType: resolved.mimeType,
        filename: resolved.filename,
        transferName: resolved.transferName
      });

    if (sourceIsCaf) {
      const converted = await cafConverter(resolved.absolutePath);
      if (!converted) return { kind: "skipped", reason: "caf to m4a conversion failed" };
      const m4aSize = safeFileSize(converted);
      if (m4aSize > deps.config.maxBytes) {
        return { kind: "skipped", reason: `attachment exceeds size cap (${m4aSize} bytes)` };
      }
      return {
        kind: "ok",
        resolvedPath: converted,
        request: {
          filePath: converted,
          mimeType: "audio/mp4",
          filename: "voice-note.m4a",
          language: deps.config.language,
          model: defaultModelLabel || deps.config.model
        }
      };
    }
    if (sourceIsVideo) {
      const converted = await videoAudioExtractor(resolved.absolutePath);
      if (!converted) return { kind: "skipped", reason: "video to m4a conversion failed" };
      const m4aSize = safeFileSize(converted);
      if (m4aSize > deps.config.maxBytes) {
        return { kind: "skipped", reason: `attachment exceeds size cap (${m4aSize} bytes)` };
      }
      return {
        kind: "ok",
        resolvedPath: converted,
        request: {
          filePath: converted,
          mimeType: "audio/mp4",
          filename: "video-audio.m4a",
          language: deps.config.language,
          model: defaultModelLabel || deps.config.model
        }
      };
    }
    const stat = statSync(resolved.absolutePath);
    if (stat.size > deps.config.maxBytes) {
      return { kind: "skipped", reason: `attachment exceeds size cap (${stat.size} bytes)` };
    }
    const mimeType = (resolved.mimeType ?? "").toLowerCase();
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      return { kind: "skipped", reason: `unsupported mime type ${mimeType || "<unknown>"}` };
    }
    return {
      kind: "ok",
      resolvedPath: resolved.absolutePath,
      request: {
        filePath: resolved.absolutePath,
        mimeType,
        filename:
          resolved.transferName ??
          resolved.filename ??
          `audio${extname(resolved.absolutePath) || ""}`,
        language: deps.config.language,
        model: defaultModelLabel || deps.config.model
      }
    };
  }

  function maybeRetentionWarn(reason: string): void {
    if (reason !== "missing_file") return;
    const now = Date.now();
    if (now - retentionWarningAt < RETENTION_WARNING_COOLDOWN_MS) return;
    retentionWarningAt = now;
    warn(
      "[transcription] iMessage voice note missing from disk before transcription could run. " +
        "Apple Messages may be expiring audio files before Inbox OS reads them. " +
        "Open Messages, Settings > Messages, and set Audio Messages > Expire to Never (or Keep) " +
        "to stop future voice notes being lost."
    );
  }

  async function safeFetchNearby(
    resolver: NearbyMessagesResolver,
    input: { messageId: string; threadId: string; radius: number }
  ): Promise<RefinementNearbyMessage[]> {
    try {
      return await resolver.fetch(input);
    } catch (error) {
      warn(
        `[transcription] nearby-messages lookup failed for ${input.messageId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  function safeFileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  return { enqueueMessage, transcribeMessage };
}

/**
 * Parse the attachmentsJson column into the list of attachments the
 * transcription pipeline can usefully run on (voice notes, generic
 * audio attachments, and videos whose audio track is extractable via
 * `convertVideoToAudioM4a`). Each entry carries its original positional
 * index, used as a fallback id when an attachment has no guid.
 */
export function collectAudioAttachments(
  attachmentsJson: string | null
): Array<{ attachment: AttachmentPlaceholder; index: number }> {
  if (!attachmentsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachmentsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ attachment: AttachmentPlaceholder; index: number }> = [];
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const candidate = entry as AttachmentPlaceholder;
    if (
      candidate.kind === "voice_note" ||
      candidate.kind === "audio" ||
      candidate.kind === "video"
    ) {
      out.push({ attachment: candidate, index });
    }
  });
  return out;
}

// Re-export pure selector helper so the runner / dashboard surface can
// derive the selected transcript without importing the implementation.
export { selectBestTranscript } from "./selection";
export type { AttemptTier } from "./selection";
