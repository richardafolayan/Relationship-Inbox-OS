import { preferredDictationMimeType } from "./dictation-recording";
import {
  defaultDictationChunkStore,
  type DictationChunkStore,
  type DictationInterruptionReason,
  type RecoveredDictationCapture
} from "./dictation-chunk-store";

export type DictationCaptureUnavailableReason = "insecure" | "unsupported";

export interface DictationCaptureAvailability {
  available: boolean;
  reason: DictationCaptureUnavailableReason | null;
}

export interface DictationCaptureSession {
  cancel: () => void;
  interrupt: (reason: DictationInterruptionReason) => void;
  native: false;
  recorder: MediaRecorder;
  resume: () => void;
  stop: () => void;
  stream: MediaStream;
}

interface StartDictationCaptureInput {
  chunkStore?: DictationChunkStore;
  MediaRecorderClass?: typeof MediaRecorder;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  onCancel?: () => void;
  onError: (error: unknown) => void;
  onInterrupted?: (capture: RecoveredDictationCapture) => void | Promise<void>;
  onRecorded: (blob: Blob) => void | Promise<void>;
  wakeLock?: {
    request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
  };
}

const DICTATION_TIMESLICE_MS = 1_000;
const DICTATION_STALL_MS = 6_000;
const DICTATION_MUTE_GRACE_MS = 1_500;

export function dictationCaptureAvailability(input: {
  isSecureContext: boolean;
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | null;
  MediaRecorderClass?: typeof MediaRecorder;
  nativeAvailable?: boolean;
}): DictationCaptureAvailability {
  if (input.nativeAvailable) return { available: true, reason: null };
  if (!input.isSecureContext) return { available: false, reason: "insecure" };
  if (!input.mediaDevices?.getUserMedia || !input.MediaRecorderClass) {
    return { available: false, reason: "unsupported" };
  }
  return { available: true, reason: null };
}

export function dictationCaptureRecoveryMessage(
  reason: DictationCaptureUnavailableReason | null
): string {
  if (reason === "insecure") {
    return "Full Tovi dictation is unavailable on this HTTP link. On your Mac, open Tovi Settings, choose Phone access, then scan the HTTPS QR code.";
  }
  return "This browser cannot record Tovi dictation. Update iOS, then open the HTTPS phone link in Safari.";
}

export function microphoneAccessMessage(error: unknown, standalone = false): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return standalone
      ? "Microphone access is off. Open iPhone Settings, find Tovi, allow Microphone, then reopen Tovi."
      : "Microphone access is off. In Safari, open Website Settings for this page, set Microphone to Allow, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found on this iPhone. Disconnect audio accessories, then try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The iPhone microphone is busy. Stop the other recording or call, then try again.";
  }
  return "The iPhone microphone could not start. Close and reopen this page, then try again.";
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {}
  }
}

export async function startDictationCapture({
  chunkStore = defaultDictationChunkStore(),
  MediaRecorderClass = MediaRecorder,
  mediaDevices = navigator.mediaDevices,
  onCancel,
  onError,
  onInterrupted,
  onRecorded,
  wakeLock =
    typeof navigator !== "undefined" && "wakeLock" in navigator
      ? (navigator as Navigator & {
          wakeLock: {
            request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
          };
        }).wakeLock
      : undefined
}: StartDictationCaptureInput): Promise<DictationCaptureSession> {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  try {
    stream = await mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true
      },
      video: false
    });
    if (stream.getAudioTracks().length === 0 || stream.getVideoTracks().length > 0) {
      throw new DOMException("The browser returned an invalid capture stream.", "NotReadableError");
    }

    const mimeType = preferredDictationMimeType((candidate) =>
      MediaRecorderClass.isTypeSupported(candidate)
    );
    recorder = new MediaRecorderClass(stream, mimeType ? { mimeType } : undefined);
    const sessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    const chunks: BlobPart[] = [];
    let cancelled = false;
    let finished = false;
    let cancelNotified = false;
    let unexpectedEndHandled = false;
    let interruptionReason: DictationInterruptionReason | null = null;
    let sequence = 0;
    let lastDataAt = startedAt;
    let persistenceAvailable = true;
    let persistenceTail = chunkStore
      .begin({
        id: sessionId,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        startedAt,
        status: "recording"
      })
      .catch(() => {
        persistenceAvailable = false;
      });
    let muteTimer: ReturnType<typeof setTimeout> | null = null;
    let stallTimer: ReturnType<typeof setInterval> | null = null;
    let wakeLockSentinel: { release: () => Promise<void> } | null = null;

    const release = () => {
      if (finished) return;
      finished = true;
      if (muteTimer) clearTimeout(muteTimer);
      if (stallTimer) clearInterval(stallTimer);
      void wakeLockSentinel?.release().catch(() => {});
      stopTracks(stream!);
    };
    const notifyCancel = () => {
      if (cancelNotified) return;
      cancelNotified = true;
      onCancel?.();
    };
    const interrupt = (reason: DictationInterruptionReason) => {
      if (cancelled || finished || interruptionReason) return;
      interruptionReason = reason;
      try {
        recorder!.requestData?.();
      } catch {}
      try {
        if (recorder!.state !== "inactive") recorder!.stop();
      } catch (error) {
        release();
        onError(error);
      }
    };

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      chunks.push(event.data);
      lastDataAt = Date.now();
      const chunkSequence = sequence++;
      persistenceTail = persistenceTail
        .then(() =>
          persistenceAvailable
            ? chunkStore.append(sessionId, chunkSequence, event.data)
            : undefined
        )
        .catch(() => {
          persistenceAvailable = false;
        });
    };
    recorder.onerror = () => {
      interrupt("recorder-error");
    };
    recorder.onstop = async () => {
      release();
      await persistenceTail;
      if (cancelled) {
        await chunkStore.remove(sessionId).catch(() => {});
        notifyCancel();
        return;
      }
      if (interruptionReason && persistenceAvailable) {
        await chunkStore.interrupt(sessionId, interruptionReason, Date.now()).catch(() => {
          persistenceAvailable = false;
        });
        const recovered = await chunkStore.read(sessionId).catch(() => null);
        if (recovered) {
          await Promise.resolve(onInterrupted?.(recovered)).catch(onError);
          return;
        }
      }
      const blob = new Blob(chunks, {
        type: recorder!.mimeType || mimeType || "audio/webm"
      });
      if (blob.size === 0) {
        onError(new DOMException("The microphone did not capture any audio.", "NotReadableError"));
        return;
      }
      try {
        await onRecorded(blob);
        await chunkStore.remove(sessionId).catch(() => {});
      } catch (error) {
        onError(error);
      }
    };
    for (const track of stream.getAudioTracks()) {
      track.addEventListener?.("ended", () => {
        if (finished || unexpectedEndHandled) return;
        unexpectedEndHandled = true;
        interrupt("track-ended");
      }, { once: true });
      track.addEventListener?.("mute", () => {
        if (finished || interruptionReason || muteTimer) return;
        muteTimer = setTimeout(() => interrupt("muted"), DICTATION_MUTE_GRACE_MS);
      });
      track.addEventListener?.("unmute", () => {
        if (muteTimer) clearTimeout(muteTimer);
        muteTimer = null;
      });
    }
    recorder.start(DICTATION_TIMESLICE_MS);
    stallTimer = setInterval(() => {
      if (Date.now() - lastDataAt >= DICTATION_STALL_MS) interrupt("stalled");
    }, DICTATION_TIMESLICE_MS);
    if (wakeLock) {
      void wakeLock
        .request("screen")
        .then((sentinel) => {
          if (finished) void sentinel.release().catch(() => {});
          else wakeLockSentinel = sentinel;
        })
        .catch(() => {});
    }

    return {
      native: false,
      recorder,
      stream,
      stop() {
        if (recorder!.state === "inactive") {
          release();
          return;
        }
        try {
          recorder!.stop();
        } catch (error) {
          release();
          throw error;
        }
      },
      interrupt,
      resume() {
        if (finished || interruptionReason || wakeLockSentinel || !wakeLock) return;
        void wakeLock
          .request("screen")
          .then((sentinel) => {
            if (finished) void sentinel.release().catch(() => {});
            else wakeLockSentinel = sentinel;
          })
          .catch(() => {});
      },
      cancel() {
        cancelled = true;
        try {
          if (recorder!.state !== "inactive") recorder!.stop();
        } catch {
          notifyCancel();
        } finally {
          release();
          notifyCancel();
        }
      }
    };
  } catch (error) {
    if (stream) stopTracks(stream);
    throw error;
  }
}
