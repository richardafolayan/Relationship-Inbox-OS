import type {
  DictationInterruptionReason,
  RecoveredDictationCapture
} from "./dictation-chunk-store";

interface NativeDictationMessageHandler {
  postMessage: (message: Record<string, unknown>) => void;
}

interface NativeDictationWindow extends Window {
  webkit?: {
    messageHandlers?: {
      toviDictation?: NativeDictationMessageHandler;
    };
  };
}

interface NativeDictationEventDetail {
  active?: boolean;
  dataUrl?: string;
  endedAt?: number;
  interruptionReason?: DictationInterruptionReason;
  message?: string;
  mimeType?: string;
  sessionId?: string;
  startedAt?: number;
  type?: "cancelled" | "error" | "recorded" | "started" | "status";
}

export interface NativeDictationCaptureSession {
  cancel: () => void;
  interrupt: (reason: DictationInterruptionReason) => void;
  native: true;
  resume: () => void;
  stop: () => void;
}

interface StartNativeDictationCaptureInput {
  onCancel?: () => void;
  onError: (error: unknown) => void;
  onInterrupted?: (capture: RecoveredDictationCapture) => void | Promise<void>;
  onRecorded: (blob: Blob) => void | Promise<void>;
  targetWindow?: Window;
}

const NATIVE_EVENT = "tovi-native-dictation";
const NATIVE_START_TIMEOUT_MS = 10_000;

function nativeWindow(targetWindow: Window = window): NativeDictationWindow {
  return targetWindow as NativeDictationWindow;
}

function handler(targetWindow: Window = window): NativeDictationMessageHandler | null {
  return nativeWindow(targetWindow).webkit?.messageHandlers?.toviDictation ?? null;
}

export function nativeDictationCaptureAvailable(targetWindow: Window = window): boolean {
  return Boolean(handler(targetWindow));
}

function nativeError(message?: string): Error {
  return new Error(message?.trim() || "The iPhone recorder stopped unexpectedly.");
}

async function blobFromNativeEvent(detail: NativeDictationEventDetail): Promise<Blob> {
  if (!detail.dataUrl) throw nativeError("The iPhone recorder returned no audio.");
  const response = await fetch(detail.dataUrl);
  const blob = await response.blob();
  if (blob.size === 0) throw nativeError("The iPhone recorder returned empty audio.");
  return detail.mimeType && blob.type !== detail.mimeType
    ? new Blob([blob], { type: detail.mimeType })
    : blob;
}

export function startNativeDictationCapture({
  onCancel,
  onError,
  onInterrupted,
  onRecorded,
  targetWindow = window
}: StartNativeDictationCaptureInput): Promise<NativeDictationCaptureSession> {
  const messageHandler = handler(targetWindow);
  if (!messageHandler) {
    return Promise.reject(nativeError("The Tovi iPhone recorder is unavailable."));
  }

  const sessionId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let finished = false;
    const cleanup = () => {
      targetWindow.removeEventListener(NATIVE_EVENT, receive as EventListener);
      clearTimeout(startTimeout);
    };
    const acknowledge = () => {
      messageHandler.postMessage({ command: "acknowledge", sessionId });
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!settled) reject(error);
      else onError(error);
    };
    const deliver = async (detail: NativeDictationEventDetail) => {
      const blob = await blobFromNativeEvent(detail);
      const interruptionReason = detail.interruptionReason;
      if (interruptionReason) {
        await onInterrupted?.({
          blob,
          endedAt: detail.endedAt ?? Date.now(),
          id: sessionId,
          interruptionReason,
          mimeType: detail.mimeType || blob.type || "audio/mp4",
          startedAt: detail.startedAt ?? startedAt,
          status: "interrupted"
        });
      } else {
        await onRecorded(blob);
      }
      acknowledge();
    };
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<NativeDictationEventDetail>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (detail.type === "started" && !settled) {
        settled = true;
        resolve(session);
        return;
      }
      if (detail.type === "status") {
        if (detail.active === false) fail(nativeError(detail.message));
        return;
      }
      if (detail.type === "cancelled") {
        if (finished) return;
        finished = true;
        cleanup();
        onCancel?.();
        return;
      }
      if (detail.type === "error") {
        fail(nativeError(detail.message));
        return;
      }
      if (detail.type === "recorded") {
        if (finished) return;
        finished = true;
        cleanup();
        void deliver(detail).catch(onError);
      }
    };
    const post = (command: "cancel" | "start" | "status" | "stop") => {
      messageHandler.postMessage({ command, sessionId });
    };
    const session: NativeDictationCaptureSession = {
      native: true,
      stop: () => post("stop"),
      cancel: () => post("cancel"),
      interrupt: () => {},
      resume: () => post("status")
    };
    const startTimeout = setTimeout(() => {
      fail(nativeError("The iPhone recorder did not start."));
    }, NATIVE_START_TIMEOUT_MS);

    targetWindow.addEventListener(NATIVE_EVENT, receive as EventListener);
    post("start");
  });
}
