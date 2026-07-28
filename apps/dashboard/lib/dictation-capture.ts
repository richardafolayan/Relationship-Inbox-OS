import { preferredDictationMimeType } from "./dictation-recording";

export type DictationCaptureUnavailableReason = "insecure" | "unsupported";

export interface DictationCaptureAvailability {
  available: boolean;
  reason: DictationCaptureUnavailableReason | null;
}

export interface DictationCaptureSession {
  cancel: () => void;
  recorder: MediaRecorder;
  stop: () => void;
  stream: MediaStream;
}

interface StartDictationCaptureInput {
  MediaRecorderClass?: typeof MediaRecorder;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  onCancel?: () => void;
  onError: (error: unknown) => void;
  onRecorded: (blob: Blob) => void | Promise<void>;
}

export function dictationCaptureAvailability(input: {
  isSecureContext: boolean;
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | null;
  MediaRecorderClass?: typeof MediaRecorder;
}): DictationCaptureAvailability {
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
  MediaRecorderClass = MediaRecorder,
  mediaDevices = navigator.mediaDevices,
  onCancel,
  onError,
  onRecorded
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
    const chunks: BlobPart[] = [];
    let cancelled = false;
    let finished = false;
    let cancelNotified = false;
    let unexpectedEndHandled = false;

    const release = () => {
      if (finished) return;
      finished = true;
      stopTracks(stream!);
    };
    const notifyCancel = () => {
      if (cancelNotified) return;
      cancelNotified = true;
      onCancel?.();
    };

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      cancelled = true;
      release();
      onError("error" in event ? event.error : new Error("The recording stopped unexpectedly."));
    };
    recorder.onstop = () => {
      release();
      if (cancelled) {
        notifyCancel();
        return;
      }
      const blob = new Blob(chunks, { type: recorder!.mimeType || mimeType || "audio/webm" });
      if (blob.size === 0) {
        onError(new DOMException("The microphone did not capture any audio.", "NotReadableError"));
        return;
      }
      void Promise.resolve(onRecorded(blob)).catch(onError);
    };
    for (const track of stream.getAudioTracks()) {
      track.addEventListener?.("ended", () => {
        if (finished || unexpectedEndHandled) return;
        unexpectedEndHandled = true;
        cancelled = true;
        try {
          if (recorder!.state !== "inactive") recorder!.stop();
        } catch {
        } finally {
          release();
          onError(new DOMException("Microphone permission ended.", "NotAllowedError"));
        }
      }, { once: true });
    }
    recorder.start();

    return {
      recorder,
      stream,
      stop() {
        if (recorder!.state === "inactive") {
          release();
          return;
        }
        try {
          recorder!.stop();
        } finally {
          release();
        }
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
