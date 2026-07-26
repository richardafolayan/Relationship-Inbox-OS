import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { prepareDictationAudio, preferredDictationMimeType } = await import(
  "../apps/dashboard/lib/dictation-recording.ts"
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

test("the thread page offers native capture when secure getUserMedia is unavailable", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /!window\.isSecureContext \|\| !navigator\.mediaDevices\?\.getUserMedia/);
  assert.match(source, /accept="audio\/\*"/);
  assert.match(source, /capture="user"/);
  assert.match(source, /onChange=\{captureDictationFile\}/);
  assert.match(source, /!window\.isSecureContext \|\| !navigator\.mediaDevices\?\.getUserMedia[\s\S]*?voiceNoteCaptureInputRef\.current\?\.click/);
});
