import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { prepareDictationAudio, preferredDictationMimeType } = await import(
  "../apps/dashboard/lib/dictation-recording.ts"
);

test("dictation prefers MP4/AAC before WebM when the browser supports both", () => {
  const supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  assert.equal(preferredDictationMimeType((mimeType) => supported.has(mimeType)), "audio/mp4");
});

test("dictation falls back to WebM when MP4 recording is unavailable", () => {
  assert.equal(
    preferredDictationMimeType((mimeType) => mimeType === "audio/webm;codecs=opus"),
    "audio/webm;codecs=opus"
  );
});

test("a Mac-hosted dictation keeps native MP4 audio instead of browser resampling it", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
  const prepared = await prepareDictationAudio({ blob, uploadMode: "native-audio" });
  assert.equal(prepared.blob, blob);
  assert.equal(prepared.filename, "dictation.m4a");
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
