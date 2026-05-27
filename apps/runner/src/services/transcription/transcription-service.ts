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

interface TranscriptionServiceDeps {
  prisma: PrismaClient;
  provider: TranscriptionProvider | null;
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
   * When true, an existing transcription row for the same fingerprint
   * is deleted before the attempt. Used by the manual "Try again"
   * affordance in the dashboard: if a previous run wrote a
   * `missing_file` skip because the audio hadn't downloaded yet from
   * iCloud, the operator can ask the runner to re-check. Auto-scan
   * never sets this — fingerprint dedup keeps scans cheap.
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
   * fingerprint dedup and re-attempt against the current disk state.
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
  | { kind: "processed"; attachments: number; ok: number; failed: number; skipped: number };

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
    if (!deps.provider || !deps.attachmentResolver) {
      // Defensive: a misconfigured runner (enabled but no provider /
      // resolver wired up) bails before touching prisma. The OpenAI
      // and local-whisper providers each carry their own configured
      // credentials / paths, so we no longer gate on `config.apiKey`
      // here — that field is OpenAI-only and would falsely disable
      // the local-whisper path when the operator hasn't set
      // OPENAI_API_KEY at all.
      return { kind: "disabled" };
    }

    const message = await deps.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        platformMessageKey: true,
        attachmentsJson: true
      }
    });
    if (!message) return { kind: "missing_message" };

    const audioAttachments = collectAudioAttachments(message.attachmentsJson);
    if (audioAttachments.length === 0) return { kind: "no_audio" };

    let ok = 0;
    let failed = 0;
    let skipped = 0;

    for (const { attachment, index } of audioAttachments) {
      const fingerprint = buildAudioFingerprint({
        platformMessageKey: message.platformMessageKey,
        attachmentGuid: attachment.guid,
        attachmentIndex: index
      });

      // Idempotency: any prior row for this fingerprint wins by default.
      // We don't auto-retry failed transcriptions because most failures
      // are structural (file unsupported, OpenAI quota exhausted) and a
      // tight retry loop just burns money. The manual "Try again"
      // affordance passes `options.force` to bypass dedup — the most
      // common case there is `missing_file` skips where the audio was
      // pending iCloud download at first run and is on disk now.
      const existing = await deps.prisma.messageAudioTranscription.findUnique({
        where: { audioFingerprint: fingerprint },
        select: { id: true, status: true }
      });
      if (existing && !options.force) {
        skipped += 1;
        continue;
      }
      if (existing && options.force) {
        await deps.prisma.messageAudioTranscription.delete({
          where: { audioFingerprint: fingerprint }
        });
      }

      const attachmentId = attachment.guid ?? `idx-${index}`;
      const outcome = await transcribeAttachment(attachment, attachmentId);

      const baseFields = {
        messageId,
        attachmentId,
        audioFingerprint: fingerprint
      };

      if (outcome.kind === "ok") {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            ...baseFields,
            status: "transcribed",
            transcript: outcome.result.text,
            // Provider + model come from the active provider instance,
            // so a row written under local-whisper persists
            // provider="local-whisper" / model="ggml-base.en.bin" while
            // an OpenAI run persists provider="openai" /
            // model="gpt-4o-mini-transcribe". `outcome.result.model`
            // is the per-call echo from the provider (preserves the
            // exact OpenAI model id when present) and falls through
            // to the provider's own label otherwise.
            provider: deps.provider!.id,
            model: outcome.result.model || deps.provider!.modelLabel,
            language: outcome.result.language ?? deps.config.language,
            durationSeconds: outcome.result.durationSeconds ?? null,
            errorMessage: null
          }
        });
        ok += 1;
      } else if (outcome.kind === "skipped") {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            ...baseFields,
            status: "skipped",
            errorMessage: outcome.reason
          }
        });
        skipped += 1;
        if (outcome.reason === "missing_file") {
          const now = Date.now();
          if (now - retentionWarningAt >= RETENTION_WARNING_COOLDOWN_MS) {
            retentionWarningAt = now;
            warn(
              "[transcription] iMessage voice note missing from disk before transcription could run. " +
                "Apple Messages may be expiring audio files before Inbox OS reads them. " +
                "Open Messages, Settings > Messages, and set Audio Messages > Expire to Never (or Keep) " +
                "to stop future voice notes being lost."
            );
          }
        }
      } else {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            ...baseFields,
            status: "failed",
            provider: deps.provider!.id,
            model: deps.provider!.modelLabel,
            errorMessage: outcome.errorMessage
          }
        });
        failed += 1;
        warn(
          `[transcription] failed message=${messageId} attachment=${attachmentId}: ${outcome.errorMessage}`
        );
      }
    }

    return { kind: "processed", attachments: audioAttachments.length, ok, failed, skipped };
  }

  async function transcribeAttachment(
    attachment: AttachmentPlaceholder,
    attachmentId: string
  ): Promise<TranscriptionOutcome> {
    if (!attachment.guid) {
      return { kind: "skipped", reason: "attachment has no guid" };
    }
    const resolved = await deps.attachmentResolver!.resolve(attachment.guid);
    if (!resolved) {
      // Stable code (rather than free-text "attachment not found...")
      // so the dashboard and the retention-warning counter can both
      // match a single string. Apple expires audio messages after the
      // user-configurable retention window — if transcription was
      // turned on after a thread had been running for a while, many
      // historical rows resolve to this state.
      return { kind: "skipped", reason: "missing_file" };
    }

    if (!existsSync(resolved.absolutePath)) {
      return { kind: "skipped", reason: "missing_file" };
    }

    // CAF voice notes and videos both need converting to m4a before
    // OpenAI will accept the upload. Conversion is cached on disk by
    // source path + mtime so a re-run never repeats the afconvert call.
    // Failed conversions are treated as "skipped" with a clear reason;
    // the runner does not crash.
    const sourceIsCaf = isCafSource({
      mimeType: resolved.mimeType,
      filename: resolved.filename,
      transferName: resolved.transferName
    });
    const sourceIsVideo = !sourceIsCaf && isVideoSource({
      kind: attachment.kind,
      mimeType: resolved.mimeType,
      filename: resolved.filename,
      transferName: resolved.transferName
    });

    let request: TranscriptionRequest;
    if (sourceIsCaf) {
      const converted = await cafConverter(resolved.absolutePath);
      if (!converted) {
        return { kind: "skipped", reason: "caf to m4a conversion failed" };
      }
      // Size cap is enforced on the extracted m4a — for both CAF and
      // video, the upload bytes are the converted m4a, not the original.
      const m4aSize = safeFileSize(converted);
      if (m4aSize > deps.config.maxBytes) {
        return { kind: "skipped", reason: `attachment exceeds size cap (${m4aSize} bytes)` };
      }
      // The original transferName is "Audio Message.caf". OpenAI's
      // /v1/audio/transcriptions endpoint sniffs the filename extension
      // to decide whether the file format is supported, so the upload
      // must advertise the converted `.m4a` shape rather than the
      // original `.caf` name.
      request = {
        filePath: converted,
        mimeType: "audio/mp4",
        filename: "voice-note.m4a",
        language: deps.config.language,
        model: deps.config.model
      };
    } else if (sourceIsVideo) {
      const converted = await videoAudioExtractor(resolved.absolutePath);
      if (!converted) {
        // afconvert refused the container (no audio track, or a codec
        // macOS can't decode). Skipped, not failed — there's nothing
        // for OpenAI to work with even if we did upload.
        return { kind: "skipped", reason: "video to m4a conversion failed" };
      }
      const m4aSize = safeFileSize(converted);
      if (m4aSize > deps.config.maxBytes) {
        return { kind: "skipped", reason: `attachment exceeds size cap (${m4aSize} bytes)` };
      }
      request = {
        filePath: converted,
        mimeType: "audio/mp4",
        // Generic name so OpenAI's filename-extension sniffer sees an
        // audio/mp4 upload (not a `.mov` it would reject).
        filename: "video-audio.m4a",
        language: deps.config.language,
        model: deps.config.model
      };
    } else {
      const stat = statSync(resolved.absolutePath);
      if (stat.size > deps.config.maxBytes) {
        return { kind: "skipped", reason: `attachment exceeds size cap (${stat.size} bytes)` };
      }
      const mimeType = (resolved.mimeType ?? "").toLowerCase();
      if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
        return { kind: "skipped", reason: `unsupported mime type ${mimeType || "<unknown>"}` };
      }
      request = {
        filePath: resolved.absolutePath,
        mimeType,
        filename: resolved.transferName ?? resolved.filename ?? `audio${extname(resolved.absolutePath) || ""}`,
        language: deps.config.language,
        model: deps.config.model
      };
    }

    return deps.provider!.transcribe(request);
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

