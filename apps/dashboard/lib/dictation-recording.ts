import { blobToWhisperWav } from "./dictation-audio";

export type DictationUploadMode = "native-audio" | "wav";
export type DictationAudioSource = "live-recording" | "selected-file";

export interface PreparedDictationAudio {
  blob: Blob;
  filename: string;
}

const NATIVE_AUDIO_TYPES = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav"
]);

export function preferredDictationMimeType(
  isTypeSupported: (mimeType: string) => boolean
): string {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]) {
    if (isTypeSupported(mimeType)) return mimeType;
  }
  return "";
}

function nativeFilename(blob: Blob, originalName?: string): string {
  const supplied = originalName?.trim();
  if (supplied) return supplied;
  const mimeType = blob.type.toLowerCase().split(";", 1)[0] || "";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "dictation.wav";
  return "dictation.m4a";
}

export async function prepareDictationAudio(input: {
  blob: Blob;
  source: DictationAudioSource;
  uploadMode: DictationUploadMode;
  originalName?: string;
}): Promise<PreparedDictationAudio> {
  const mimeType = input.blob.type.toLowerCase().split(";", 1)[0] || "";
  if (
    input.source === "selected-file" &&
    input.originalName?.trim() &&
    input.uploadMode === "native-audio" &&
    NATIVE_AUDIO_TYPES.has(mimeType)
  ) {
    return {
      blob: input.blob,
      filename: nativeFilename(input.blob, input.originalName)
    };
  }
  return {
    blob: await blobToWhisperWav(input.blob),
    filename: "dictation.wav"
  };
}
