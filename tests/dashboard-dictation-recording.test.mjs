import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { prepareDictationAudio, preferredDictationMimeType } = await import(
  "../apps/dashboard/lib/dictation-recording.ts"
);
const threadPage = await readFile(
  new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
  "utf8"
);

test("dictation prefers WebM/Opus when the browser supports it", () => {
  const supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  assert.equal(
    preferredDictationMimeType((mimeType) => supported.has(mimeType)),
    "audio/webm;codecs=opus"
  );
});

test("dictation falls back to MP4/AAC when WebM recording is unavailable", () => {
  assert.equal(
    preferredDictationMimeType((mimeType) => mimeType === "audio/mp4;codecs=mp4a.40.2"),
    "audio/mp4;codecs=mp4a.40.2"
  );
});

test("a live Mac-hosted recording is normalized to WAV before upload", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
  await assert.rejects(
    prepareDictationAudio({ blob, uploadMode: "native-audio" }),
    /Web Audio API is unavailable/
  );
});

test("an explicitly selected native audio file can bypass browser resampling on Mac", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
  const prepared = await prepareDictationAudio({
    blob,
    uploadMode: "native-audio",
    originalName: "Recording.m4a"
  });
  assert.equal(prepared.blob, blob);
  assert.equal(prepared.filename, "Recording.m4a");
});

test("insecure iPhone access never invokes WebKit's video capture fallback", () => {
  assert.match(threadPage, /!window\.isSecureContext \|\| !navigator\.mediaDevices\?\.getUserMedia/);
  assert.doesNotMatch(threadPage, /capture="user"/);
  assert.doesNotMatch(threadPage, /accept="audio\/\*"/);
  assert.match(threadPage, /accept="\.m4a,\.mp3,\.wav,\.aac,\.aif,\.aiff,\.caf"/);
  assert.match(threadPage, /voiceNoteFileInputRef\.current\?\.click/);
  assert.match(threadPage, /Use the microphone key on your iPhone keyboard/);
});

test("Safari dictation records one complete MP4 instead of timesliced fragments", () => {
  assert.match(threadPage, /Safari needs one complete MP4 recording/);
  assert.match(threadPage, /recorder\.start\(\);/);
  assert.doesNotMatch(threadPage, /recorder\.start\(250\)/);
});

test("microphone permission failures explain how to recover", () => {
  assert.match(threadPage, /Microphone access is off\. Allow it in your browser settings/);
  assert.match(threadPage, /No microphone was found on this device/);
});
