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
  type Attempt as SelectorAttempt,
  type AttemptTier,
  type SelectedTranscript
} from "./selection";
import type {
  RefinementContext,
  RefinementNearbyMessage,
  TextRefinementService
} from "./text-refinement-service";
import {
  applyRefinementPatches,
  deriveOverallConfidence
} from "./refinement-patches";

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
  provider: TranscriptionProvider | null;
  /**
   * Progressive (multi-tier) mode. When set, each configured tier is
   * run sequentially in the **manual** path; the **automatic** path
   * (enqueueMessage) only runs `fast` and `standard` so a heavy `max`
   * pass on one message can never starve fresh fast transcripts for
   * other messages waiting in the queue. Refinement (GPT-5-nano)
   * never runs from the auto path.
   *
   * Missing tier keys are simply skipped — the runner doesn't have to
   * configure all three.
   */
  providers?: Partial<Record<"fast" | "standard" | "max", TranscriptionProvider>>;
  refiner?: TextRefinementService | null;
  refinementEnabled?: boolean;
  nearbyMessages?: NearbyMessagesResolver | null;
  attachmentResolver: AttachmentResolver | null;
  config: TranscriptionServiceConfig;
  convertCafToM4a?: (absolutePath: string) => Promise<string | null>;
  convertVideoToAudioM4a?: (absolutePath: string) => Promise<string | null>;
  warn?: (message: string) => void;
}

export interface TranscribeMessageOptions {
  /**
   * Manual force-retry: delete the existing parent row + cascaded
   * attempts, then re-run the full progressive chain. Used by the
   * dashboard's `Try again` affordance. Auto-scan never sets this.
   */
  force?: boolean;
}

export interface TranscriptionService {
  /** Fire-and-forget; never throws. Used by scan-time enqueue. */
  enqueueMessage(messageId: string): void;
  /**
   * Synchronous entrypoint used by manual `Transcribe / Try again`.
   * Runs the FULL chain — every configured local tier (fast,
   * standard, max) followed by refinement when enabled. The auto path
   * (enqueueMessage) intentionally does NOT run this; it uses the
   * fast-first priority queue instead.
   */
  transcribeMessage(
    messageId: string,
    options?: TranscribeMessageOptions
  ): Promise<TranscribeMessageOutcome>;
  /**
   * Returns the set of tier names currently queued or running for
   * this message. Drives the dashboard's `Improving transcript...`
   * hint without polling. Returns an empty array when nothing is in
   * flight or progressive mode isn't active.
   */
  getPendingTiers(messageId: string): AttemptTier[];
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

type PreparedRequest =
  | { kind: "ok"; request: TranscriptionRequest; resolvedPath: string }
  | { kind: "skipped"; reason: string };

type LocalTier = "fast" | "standard" | "max";

interface QueueItem {
  messageId: string;
  tier: LocalTier;
}

export function createTranscriptionService(deps: TranscriptionServiceDeps): TranscriptionService {
  const warn = deps.warn ?? ((message) => console.warn(message));
  const cafConverter = deps.convertCafToM4a ?? convertCafToM4a;
  const videoAudioExtractor = deps.convertVideoToAudioM4a ?? convertVideoToAudioM4a;
  const RETENTION_WARNING_COOLDOWN_MS = 6 * 60 * 60 * 1000;
  let retentionWarningAt = 0;

  // Per-messageId mutex. Both the auto queue worker and the manual
  // transcribeMessage path go through withSerial(messageId, ...) so a
  // force-retry never races a queued tier on the same message.
  const serialQueues = new Map<string, Promise<unknown>>();

  // Progressive mode is active when at least one tier provider is
  // wired. Tier ordering for the manual path is strict: fast → standard
  // → max. The queue (auto path) skips max and refinement entirely.
  const configuredManualTiers: LocalTier[] = [];
  if (deps.providers?.fast) configuredManualTiers.push("fast");
  if (deps.providers?.standard) configuredManualTiers.push("standard");
  if (deps.providers?.max) configuredManualTiers.push("max");
  const configuredAutoTiers: LocalTier[] = configuredManualTiers.filter(
    (t) => t === "fast" || t === "standard"
  );
  const progressiveActive = configuredManualTiers.length > 0;

  // Fast-first scheduling state. Two physical queues — the worker
  // always drains `fastQueue` to empty before touching `standardQueue`,
  // so a batch of new messages all see their `fast` transcript before
  // the runner spends time on any `standard` pass. `pendingTiersByMessage`
  // tracks what's queued/running per message for the dashboard's
  // truth-based `Improving transcript...` hint.
  const fastQueue: QueueItem[] = [];
  const standardQueue: QueueItem[] = [];
  const pendingTiersByMessage = new Map<string, Set<AttemptTier>>();
  let draining = false;

  function getPendingTiers(messageId: string): AttemptTier[] {
    const set = pendingTiersByMessage.get(messageId);
    return set ? Array.from(set) : [];
  }

  function trackPending(messageId: string, tier: AttemptTier): void {
    const set = pendingTiersByMessage.get(messageId);
    if (set) {
      set.add(tier);
    } else {
      pendingTiersByMessage.set(messageId, new Set([tier]));
    }
  }

  function clearPending(messageId: string, tier: AttemptTier): void {
    const set = pendingTiersByMessage.get(messageId);
    if (!set) return;
    set.delete(tier);
    if (set.size === 0) pendingTiersByMessage.delete(messageId);
  }

  function withSerial<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
    const previous = serialQueues.get(messageId) ?? Promise.resolve();
    const guarded = previous.catch(() => undefined).then(() => fn());
    // Store a swallowed version so a thrown error doesn't poison
    // future calls but the actual result is still propagated to the
    // caller via `guarded`.
    const placeholder = guarded.catch(() => undefined);
    serialQueues.set(messageId, placeholder);
    placeholder.finally(() => {
      if (serialQueues.get(messageId) === placeholder) {
        serialQueues.delete(messageId);
      }
    });
    return guarded;
  }

  function enqueueMessage(messageId: string): void {
    if (!deps.config.enabled) return;
    // Single-mode (no `providers` wired): use the legacy fire-and-
    // forget shape — one call runs the one provider and returns.
    if (!progressiveActive) {
      if (!deps.provider) return;
      queueMicrotask(() => {
        void withSerial(messageId, () => transcribeMessage(messageId)).catch(
          (error) => {
            warn(
              `[transcription] unhandled error for message ${messageId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        );
      });
      return;
    }
    // Progressive auto path: queue a `fast` task. The drainer will
    // chain `standard` after a successful fast pass. Never queues
    // `max` from this path — that's a manual-only tier.
    if (configuredAutoTiers.length === 0) return;
    // De-dupe: if any tier for this message is already queued / running,
    // skip. The manual force=true path resets state by deleting the
    // parent row before re-entering.
    if (pendingTiersByMessage.has(messageId)) return;
    if (configuredAutoTiers.includes("fast")) {
      trackPending(messageId, "fast");
      if (configuredAutoTiers.includes("standard")) {
        trackPending(messageId, "standard");
      }
      fastQueue.push({ messageId, tier: "fast" });
    } else if (configuredAutoTiers.includes("standard")) {
      trackPending(messageId, "standard");
      standardQueue.push({ messageId, tier: "standard" });
    }
    scheduleDrain();
  }

  function scheduleDrain(): void {
    if (draining) return;
    queueMicrotask(() => void drain());
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (fastQueue.length > 0 || standardQueue.length > 0) {
        // ALWAYS prefer fast tasks. This is the heart of the "fast
        // across all messages first" guarantee — a slow `standard`
        // pass in the queue waits while any newly-enqueued fast tasks
        // run, so a batch of incoming voice notes all see their first
        // transcript before any of them gets upgraded.
        const item = fastQueue.shift() ?? standardQueue.shift();
        if (!item) break;
        try {
          await withSerial(item.messageId, () =>
            runOneTierForQueue(item)
          );
        } catch (error) {
          warn(
            `[transcription] queue task failed (message=${item.messageId} tier=${item.tier}): ${error instanceof Error ? error.message : String(error)}`
          );
          clearPending(item.messageId, item.tier);
        }
      }
    } finally {
      draining = false;
    }
  }

  async function runOneTierForQueue(item: QueueItem): Promise<void> {
    const provider = deps.providers?.[item.tier];
    if (!provider) {
      clearPending(item.messageId, item.tier);
      return;
    }
    const result = await runOneProgressiveTier(item.messageId, item.tier);
    clearPending(item.messageId, item.tier);
    // Chain: a successful `fast` queues the `standard` tier so the
    // upgrade actually happens. A failed/skipped `fast` does not
    // chain — the operator can manually retry.
    if (
      result === "ok" &&
      item.tier === "fast" &&
      configuredAutoTiers.includes("standard")
    ) {
      standardQueue.push({ messageId: item.messageId, tier: "standard" });
      // standard was already marked pending at enqueue time; nothing
      // to add here.
    } else if (
      result !== "ok" &&
      item.tier === "fast" &&
      configuredAutoTiers.includes("standard")
    ) {
      // Fast failed; drop the standard tracking so the dashboard
      // doesn't show a stale "Improving transcript..." line forever.
      clearPending(item.messageId, "standard");
    }
  }

  async function transcribeMessage(
    messageId: string,
    options: TranscribeMessageOptions = {}
  ): Promise<TranscribeMessageOutcome> {
    return withSerial(messageId, () => transcribeMessageLocked(messageId, options));
  }

  async function transcribeMessageLocked(
    messageId: string,
    options: TranscribeMessageOptions
  ): Promise<TranscribeMessageOutcome> {
    if (!deps.config.enabled) return { kind: "disabled" };
    if (!progressiveActive && !deps.provider) return { kind: "disabled" };
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

    const existingForMessage = await deps.prisma.messageAudioTranscription.findUnique({
      where: { messageId },
      select: { id: true, status: true }
    });
    if (existingForMessage && !options.force) {
      return {
        kind: "processed",
        attachments: audioAttachments.length,
        ok: 0,
        failed: 0,
        skipped: 1
      };
    }
    if (existingForMessage && options.force) {
      await deps.prisma.messageAudioTranscription.delete({
        where: { messageId }
      });
      // Also clear any in-memory queue state for this message; the
      // manual retry is the new source of truth.
      pendingTiersByMessage.delete(messageId);
    }

    if (progressiveActive) {
      // Track pending tiers up front so a long-running manual call
      // surfaces `isImproving=true` for the duration.
      for (const tier of configuredManualTiers) {
        trackPending(messageId, tier);
      }
      if (deps.refinementEnabled && deps.refiner) {
        trackPending(messageId, "refinement");
      }
      try {
        return await runProgressiveManual({
          message,
          attachments: audioAttachments
        });
      } finally {
        for (const tier of configuredManualTiers) {
          clearPending(messageId, tier);
        }
        clearPending(messageId, "refinement");
      }
    }
    return runSingleModel({
      message,
      attachments: audioAttachments
    });
  }

  // -------------------------------------------------------------------
  // Single-model orchestration (pre-progressive behaviour, kept for
  // back-compat when no `providers` map is wired).
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
      break; // one row per message by schema
    }
    return { kind: "processed", attachments: attachments.length, ok, failed, skipped };
  }

  // -------------------------------------------------------------------
  // Manual progressive: runs the FULL chain (all configured tiers +
  // optional refinement) inline. The auto path uses runOneProgressiveTier
  // via the queue instead.
  // -------------------------------------------------------------------
  async function runProgressiveManual(input: {
    message: {
      id: string;
      platformMessageKey: string;
      threadId: string;
      direction: "IN" | "OUT" | string;
    };
    attachments: Array<{ attachment: AttachmentPlaceholder; index: number }>;
  }): Promise<TranscribeMessageOutcome> {
    const { message, attachments } = input;
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    const liveAttempts: SelectorAttempt[] = [];
    let selection: SelectedTranscript | null = null;

    for (const tier of configuredManualTiers) {
      const result = await runOneProgressiveTier(message.id, tier);
      if (result === "ok") ok += 1;
      else if (result === "failed") failed += 1;
      else skipped += 1;
    }
    // Re-read attempt rows to drive refinement context.
    const parent = await deps.prisma.messageAudioTranscription.findUnique({
      where: { messageId: message.id },
      select: { id: true, transcript: true, selectedTier: true, selectedProvider: true, selectedModel: true }
    });
    if (parent) {
      const attemptRows = await deps.prisma.messageAudioTranscriptionAttempt.findMany({
        where: { transcriptionId: parent.id }
      });
      for (const row of attemptRows) {
        if (row.status === "transcribed" && row.transcript) {
          liveAttempts.push({
            tier: row.tier as AttemptTier,
            model: row.model,
            provider: row.provider,
            status: row.status,
            transcript: row.transcript
          });
        }
      }
      if (parent.selectedTier && parent.transcript) {
        selection = {
          tier: parent.selectedTier as AttemptTier,
          model: parent.selectedModel ?? "",
          provider: parent.selectedProvider ?? "",
          transcript: parent.transcript
        };
      }
    }

    // Optional refinement step (manual path only).
    if (
      deps.refinementEnabled &&
      deps.refiner &&
      parent &&
      liveAttempts.some((a) => a.tier === "standard" || a.tier === "max")
    ) {
      await runProgressiveRefinement({ message, parentId: parent.id, attempts: liveAttempts });
    }

    return {
      kind: "processed",
      attachments: attachments.length,
      ok,
      failed,
      skipped
    };
  }

  // -------------------------------------------------------------------
  // Run ONE local tier for ONE message. Self-contained: looks up the
  // message, prepares the audio, ensures a parent row exists, runs the
  // provider, writes an attempt row, and updates the parent's selected
  // transcript IF this tier outranks any previous selection. Used by
  // BOTH the manual path (loops fast→standard→max) and the auto queue
  // (one tier per dequeue).
  // -------------------------------------------------------------------
  async function runOneProgressiveTier(
    messageId: string,
    tier: LocalTier
  ): Promise<"ok" | "failed" | "skipped"> {
    const provider = deps.providers?.[tier];
    if (!provider) return "skipped";
    if (!deps.attachmentResolver) return "skipped";

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
    if (!message) return "skipped";
    const audio = collectAudioAttachments(message.attachmentsJson);
    if (audio.length === 0) return "skipped";
    const first = audio[0];
    if (!first) return "skipped";
    const { attachment, index } = first;
    const fingerprint = buildAudioFingerprint({
      platformMessageKey: message.platformMessageKey,
      attachmentGuid: attachment.guid,
      attachmentIndex: index
    });
    const attachmentId = attachment.guid ?? `idx-${index}`;

    // Ensure parent exists. If a pre-tier failure (missing_file etc.)
    // is hit, we write a parent-skip row WITHOUT attempts.
    let parent = await deps.prisma.messageAudioTranscription.findUnique({
      where: { messageId }
    });
    const prepared = await prepareRequest(attachment, provider.modelLabel || deps.config.model);
    if (prepared.kind === "skipped") {
      if (!parent) {
        await deps.prisma.messageAudioTranscription.create({
          data: {
            messageId,
            attachmentId,
            audioFingerprint: fingerprint,
            status: "skipped",
            errorMessage: prepared.reason
          }
        });
        maybeRetentionWarn(prepared.reason);
      }
      return "skipped";
    }
    if (!parent) {
      parent = await deps.prisma.messageAudioTranscription.create({
        data: {
          messageId,
          attachmentId,
          audioFingerprint: fingerprint,
          status: "pending",
          language: deps.config.language
        }
      });
    }

    // Idempotency: if this tier+model already ran for this transcription
    // (e.g. the queue worker re-entered after a force-retry race) skip
    // without billing the provider again.
    const existingAttempt = await deps.prisma.messageAudioTranscriptionAttempt.findFirst({
      where: {
        transcriptionId: parent.id,
        tier,
        model: provider.modelLabel
      }
    });
    if (existingAttempt) {
      return existingAttempt.status === "transcribed" ? "ok" : "skipped";
    }

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
      model: provider.modelLabel,
      durationMs: elapsed
    };

    if (outcome.kind === "ok") {
      const text = outcome.result.text?.trim() ?? "";
      if (text.length === 0) {
        await deps.prisma.messageAudioTranscriptionAttempt.create({
          data: { ...attemptBase, status: "skipped", errorMessage: "empty_output" }
        });
        return "skipped";
      }
      await deps.prisma.messageAudioTranscriptionAttempt.create({
        data: {
          ...attemptBase,
          status: "transcribed",
          transcript: text,
          errorMessage: null
        }
      });
      // Selection rule: a successful tier replaces the parent
      // transcript ONLY when it outranks the current selection.
      const candidate: SelectedTranscript = {
        tier,
        model: provider.modelLabel,
        provider: provider.id,
        transcript: text
      };
      const currentSelection: SelectedTranscript | null = parent.selectedTier
        ? {
            tier: parent.selectedTier as AttemptTier,
            model: parent.selectedModel ?? "",
            provider: parent.selectedProvider ?? "",
            transcript: parent.transcript ?? ""
          }
        : null;
      const winner = pickHigherTier(currentSelection, candidate);
      if (winner === candidate) {
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
            // Mark for AI refresh only when we replaced a previous
            // selection. A first-write fast transcript is the BASE,
            // not a "refresh trigger".
            needsAiRefresh: currentSelection !== null
          }
        });
      }
      return "ok";
    } else if (outcome.kind === "skipped") {
      await deps.prisma.messageAudioTranscriptionAttempt.create({
        data: { ...attemptBase, status: "skipped", errorMessage: outcome.reason }
      });
      // If parent is still in `pending` state (this is the first tier
      // we ran and it skipped), record the skip on the parent so the
      // dashboard renders the right copy.
      if (!parent.selectedTier && parent.status === "pending") {
        await deps.prisma.messageAudioTranscription.update({
          where: { id: parent.id },
          data: { status: "skipped", errorMessage: outcome.reason }
        });
      }
      return "skipped";
    } else {
      await deps.prisma.messageAudioTranscriptionAttempt.create({
        data: { ...attemptBase, status: "failed", errorMessage: outcome.errorMessage }
      });
      if (!parent.selectedTier && parent.status === "pending") {
        await deps.prisma.messageAudioTranscription.update({
          where: { id: parent.id },
          data: { status: "failed", errorMessage: outcome.errorMessage }
        });
      }
      warn(
        `[transcription] tier=${tier} failed message=${messageId} attachment=${attachmentId}: ${outcome.errorMessage}`
      );
      return "failed";
    }
  }

  async function runProgressiveRefinement(input: {
    message: { id: string; threadId: string; direction: "IN" | "OUT" | string };
    parentId: string;
    attempts: SelectorAttempt[];
  }): Promise<void> {
    if (!deps.refiner) return;
    const nearby = deps.nearbyMessages
      ? await safeFetchNearby(deps.nearbyMessages, {
          messageId: input.message.id,
          threadId: input.message.threadId,
          radius: 8
        })
      : [];
    const refinementContext: RefinementContext = {
      messageId: input.message.id,
      threadId: input.message.threadId,
      direction: input.message.direction === "OUT" ? "OUT" : "IN",
      speakerRole: input.message.direction === "OUT" ? "operator" : "contact",
      attempts: input.attempts.map((a) => ({
        tier: a.tier === "refinement" ? "max" : (a.tier as "fast" | "standard" | "max"),
        model: a.model,
        transcript: a.transcript ?? ""
      })),
      nearbyMessages: nearby
    };
    const startedAt = Date.now();
    const outcome = await deps.refiner.refine(refinementContext);
    const elapsed = Date.now() - startedAt;

    const attemptBase = {
      transcriptionId: input.parentId,
      tier: "refinement" as const,
      provider: "openai-text-refiner",
      durationMs: elapsed
    };
    if (outcome.kind === "ok") {
      // Patch-based application (#386). The refiner returns a list of
      // substring replacements rather than a whole transcript. We
      // build the final text deterministically: highest-tier local is
      // the base, each safe patch is applied in turn, then the three
      // post-apply guards (duplicate / shrink / drift) decide whether
      // we accept the result. The orchestrator — not the model —
      // controls every byte of the selected transcript.
      const base = input.attempts[input.attempts.length - 1]?.transcript?.trim() ?? "";
      const application = applyRefinementPatches({
        base,
        corrections: outcome.result.corrections
      });
      const overallConfidence = deriveOverallConfidence(application.applied);
      // The refinement attempt row stores whatever post-patch text we
      // produced (even if a guard later rejects it) so the operator
      // can debug. We persist the rejection reason in errorMessage so
      // it shows up alongside the attempts list.
      const attemptOutcomeStatus = application.rejection
        ? "skipped"
        : application.applied.length === 0
          ? "skipped"
          : "transcribed";
      await deps.prisma.messageAudioTranscriptionAttempt.create({
        data: {
          ...attemptBase,
          model: outcome.result.model,
          status: attemptOutcomeStatus,
          transcript: application.patched,
          errorMessage:
            application.rejection ??
            (application.applied.length === 0 ? "no_safe_corrections" : null)
        }
      });
      const parent = await deps.prisma.messageAudioTranscription.findUnique({
        where: { id: input.parentId },
        select: { selectedTier: true }
      });
      // Update parent only when patches were accepted AND no guard
      // rejected the result. Otherwise the base (which is already in
      // parent.transcript as the max tier's output) stays untouched.
      if (!application.rejection && application.applied.length > 0) {
        await deps.prisma.messageAudioTranscription.update({
          where: { id: input.parentId },
          data: {
            transcript: application.patched,
            selectedTier: "refinement",
            selectedModel: outcome.result.model,
            selectedProvider: "openai-text-refiner",
            refinedTranscript: application.patched,
            refinementModel: outcome.result.model,
            refinementConfidence: overallConfidence,
            refinementJson: outcome.result.rawJson,
            needsAiRefresh: parent?.selectedTier !== null && parent?.selectedTier !== undefined
          }
        });
      } else if (application.rejection) {
        // Persist the rejection on the parent for visibility, but do
        // NOT change selectedTier — keep the highest-tier local
        // transcript as the selection.
        await deps.prisma.messageAudioTranscription.update({
          where: { id: input.parentId },
          data: { refinementJson: outcome.result.rawJson }
        });
        warn(
          `[transcription] refinement rejected message=${input.message.id}: ${application.rejection}`
        );
      } else {
        // application.applied.length === 0 → refiner saw no safe
        // corrections. Persist the audit JSON but keep the base.
        await deps.prisma.messageAudioTranscription.update({
          where: { id: input.parentId },
          data: { refinementJson: outcome.result.rawJson }
        });
      }
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
      warn(`[transcription] refinement failed message=${input.message.id}: ${outcome.errorMessage}`);
    }
  }

  // -------------------------------------------------------------------
  // Helpers.
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

  return { enqueueMessage, transcribeMessage, getPendingTiers };
}

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

export { selectBestTranscript } from "./selection";
export type { AttemptTier } from "./selection";
