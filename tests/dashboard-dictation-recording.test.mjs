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
const captureSource = await readFile(
  new URL("../apps/dashboard/lib/dictation-capture.ts", import.meta.url),
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
    preferredDictationMimeType(
      (mimeType) => mimeType === "audio/mp4;codecs=mp4a.40.2"
    ),
    "audio/mp4;codecs=mp4a.40.2"
  );
});

test("dictation falls back to MP4 without an explicit AAC codec", () => {
  assert.equal(
    preferredDictationMimeType((mimeType) => mimeType === "audio/mp4"),
    "audio/mp4"
  );
});

test("dictation lets the runtime choose when no preferred MIME type is supported", () => {
  assert.equal(preferredDictationMimeType(() => false), "");
});

test("a live Mac-hosted recording is normalized to WAV before upload", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], {
    type: "audio/mp4"
  });

  await assert.rejects(
    prepareDictationAudio({
      blob,
      source: "live-recording",
      uploadMode: "native-audio",
      originalName: "misleading-live-name.m4a"
    }),
    /Web Audio API is unavailable/
  );
});

test("an explicitly selected native audio file can bypass browser resampling on Mac", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], {
    type: "audio/mp4"
  });

  const prepared = await prepareDictationAudio({
    blob,
    source: "selected-file",
    uploadMode: "native-audio",
    originalName: "Recording.m4a"
  });

  assert.equal(prepared.blob, blob);
  assert.equal(prepared.filename, "Recording.m4a");
});

test("a selected file cannot take the native bypass without an explicit name", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], {
    type: "audio/mp4"
  });

  await assert.rejects(
    prepareDictationAudio({
      blob,
      source: "selected-file",
      uploadMode: "native-audio"
    }),
    /Web Audio API is unavailable/
  );
});

test("insecure iPhone access truthfully disables Tovi dictation", () => {
  assert.match(threadPage, /Dictation unavailable/);
  assert.match(threadPage, /dictationCaptureRecoveryMessage/);
  assert.doesNotMatch(
    threadPage,
    /Use the microphone key on your iPhone keyboard/
  );
  assert.doesNotMatch(threadPage, /Keyboard mic/);
  assert.doesNotMatch(threadPage, /capture="user"/);
  assert.match(
    threadPage,
    /accept="\.m4a,\.mp3,\.wav,\.aac,\.aif,\.aiff,\.caf"/
  );
  assert.match(threadPage, /voiceNoteFileInputRef\.current\?\.click/);
});

test("dictation persists short recorder slices and watches for capture stalls", () => {
  assert.match(captureSource, /recorder\.start\(DICTATION_TIMESLICE_MS\)/);
  assert.match(captureSource, /chunkStore\.append/);
  assert.match(captureSource, /DICTATION_STALL_MS/);
});

test("microphone permission failures explain how to recover", () => {
  assert.match(captureSource, /Website Settings for this page/);
  assert.match(captureSource, /find Tovi, allow Microphone/);
  assert.match(captureSource, /No microphone was found on this iPhone/);
});
