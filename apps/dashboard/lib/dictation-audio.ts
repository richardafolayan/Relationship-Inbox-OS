// #462 (pilot R-0061) dictation audio prep.
//
// MediaRecorder gives us webm/opus on Chrome/Firefox and mp4/aac on Safari.
// The runner's local-whisper provider converts input to 16 kHz mono WAV with
// macOS `afconvert`, which reads Apple containers (m4a/caf/wav) but NOT
// webm/opus — and ffmpeg isn't installed. So a webm dictation clip fails with
// `local_whisper_conversion_failed`.
//
// Fix: decode the recorded blob in the browser (Web Audio decodes opus/aac
// everywhere) and re-encode it as a 16 kHz mono 16-bit PCM WAV before upload.
// WAV is afconvert-friendly (and OpenAI-friendly), so the existing transcription
// providers handle it unchanged — no server change, no API cost, local-first.

export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Encode mono Float32 PCM samples ([-1, 1]) as a 16-bit PCM WAV file.
 * Pure (no DOM) so it can be unit-tested. Returns the full RIFF/WAVE buffer.
 */
export function encodeWavFromMono(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numFrames = samples.length;
  const bytesPerSample = 2; // 16-bit
  const numChannels = 1; // mono
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;
  const writeString = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
  };

  // RIFF header
  writeString("RIFF");
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeString("WAVE");
  // fmt chunk
  writeString("fmt ");
  view.setUint32(offset, 16, true); offset += 4; // PCM fmt chunk size
  view.setUint16(offset, 1, true); offset += 2; // audioFormat = 1 (PCM)
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true); offset += 2; // bitsPerSample
  // data chunk
  writeString("data");
  view.setUint32(offset, dataSize, true); offset += 4;
  for (let i = 0; i < numFrames; i++) {
    let s = samples[i] ?? 0;
    s = Math.max(-1, Math.min(1, s));
    // Asymmetric scale matches the [-1,1] -> int16 convention.
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

type AudioCtor = typeof AudioContext;
type OfflineAudioCtor = typeof OfflineAudioContext;

function resolveAudioContext(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext ??
    null
  );
}

function resolveOfflineAudioContext(): OfflineAudioCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: OfflineAudioCtor }).webkitOfflineAudioContext ??
    null
  );
}

/**
 * Decode an arbitrary recorded audio Blob (webm/opus, mp4/aac, ...) and
 * re-encode it as a 16 kHz mono 16-bit PCM WAV Blob that whisper.cpp/afconvert
 * read reliably. Throws if the browser can't decode the recording (the caller
 * surfaces a calm "could not prepare the recording" error).
 */
export async function blobToWhisperWav(blob: Blob): Promise<Blob> {
  const AudioCtx = resolveAudioContext();
  const OfflineCtx = resolveOfflineAudioContext();
  if (!AudioCtx || !OfflineCtx) {
    throw new Error("Web Audio API is unavailable in this browser.");
  }

  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    // slice(0) hands decodeAudioData its own copy — some browsers detach the
    // source buffer, which would break a retry.
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void decodeCtx.close?.();
  }

  // Render the decoded audio through a 16 kHz mono offline context. A stereo
  // source is down-mixed to the single destination channel, and the rate
  // change resamples to 16 kHz in one pass.
  const frameCount = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
  const offline = new OfflineCtx(1, frameCount, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();

  const mono = rendered.getChannelData(0);
  const wav = encodeWavFromMono(mono, WHISPER_SAMPLE_RATE);
  return new Blob([wav], { type: "audio/wav" });
}
