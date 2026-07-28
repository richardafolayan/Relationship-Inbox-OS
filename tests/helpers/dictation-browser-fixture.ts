import { prepareDictationAudio } from "../../apps/dashboard/lib/dictation-recording";

declare global {
  interface Window {
    runDictationRuntimeFixtures: () => Promise<unknown>;
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function generatedWebm(gainValue: number): Promise<Blob> {
  const context = new AudioContext();
  await context.resume();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 220;
  gain.gain.value = gainValue;
  oscillator.connect(gain);
  gain.connect(destination);

  const mimeType = "audio/webm;codecs=opus";
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(`${mimeType} is not supported`);
  }
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(destination.stream, { mimeType });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
  recorder.start();
  oscillator.start();
  await new Promise((resolve) => setTimeout(resolve, 900));
  oscillator.stop();
  recorder.stop();
  await stopped;
  destination.stream.getTracks().forEach((track) => track.stop());
  await context.close();
  return new Blob(chunks, { type: recorder.mimeType });
}

async function convertGenerated(gainValue: number) {
  const raw = await generatedWebm(gainValue);
  const prepared = await prepareDictationAudio({
    blob: raw,
    source: "live-recording",
    uploadMode: "native-audio",
    originalName: "must-not-bypass-live-recording.webm"
  });
  return {
    filename: prepared.filename,
    rawBytes: raw.size,
    rawType: raw.type,
    wavBase64: toBase64(await prepared.blob.arrayBuffer()),
    wavBytes: prepared.blob.size,
    wavType: prepared.blob.type
  };
}

async function conversionFailure(bytes: number[], type: string) {
  try {
    await prepareDictationAudio({
      blob: new Blob([new Uint8Array(bytes)], { type }),
      source: "live-recording",
      uploadMode: "native-audio"
    });
    return { failed: false };
  } catch (error) {
    return {
      failed: true,
      name: error instanceof Error ? error.name : "Error"
    };
  }
}

window.runDictationRuntimeFixtures = async () => ({
  meaningful: await convertGenerated(0.2),
  silent: await convertGenerated(0),
  empty: await conversionFailure([], "audio/webm;codecs=opus"),
  corrupt: await conversionFailure([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3], "audio/webm;codecs=opus"),
  unsupported: await conversionFailure([1, 2, 3, 4, 5, 6], "audio/unsupported")
});
