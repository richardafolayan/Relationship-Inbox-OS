import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [infoPlist, recorderSource, webViewSource, projectSource] = await Promise.all([
  readFile(new URL("../apps/ios/ToviIOS/Info.plist", import.meta.url), "utf8"),
  readFile(new URL("../apps/ios/ToviIOS/DictationRecorder.swift", import.meta.url), "utf8"),
  readFile(new URL("../apps/ios/ToviIOS/ToviWebView.swift", import.meta.url), "utf8"),
  readFile(new URL("../apps/ios/ToviIOS.xcodeproj/project.pbxproj", import.meta.url), "utf8")
]);

test("iPhone companion declares microphone use and background audio", () => {
  assert.match(infoPlist, /NSMicrophoneUsageDescription/);
  assert.match(infoPlist, /UIBackgroundModes[\s\S]*<string>audio<\/string>/);
});

test("native dictation writes AAC incrementally under an active recording session", () => {
  assert.match(recorderSource, /setCategory\(\s*\.record/);
  assert.match(recorderSource, /kAudioFormatMPEG4AAC/);
  assert.match(recorderSource, /recorder\.record\(\)/);
  assert.match(recorderSource, /applicationSupportDirectory/);
  assert.match(recorderSource, /audioSessionInterrupted/);
});

test("native bridge only returns recorded audio to the existing review UI", () => {
  assert.match(webViewSource, /toviDictation/);
  assert.match(webViewSource, /tovi-native-dictation/);
  assert.match(webViewSource, /data:audio\/mp4;base64/);
  assert.doesNotMatch(webViewSource, /\/send|send-message|autosend/i);
});

test("Xcode project includes every native bridge source", () => {
  for (const filename of [
    "ToviIOSApp.swift",
    "ContentView.swift",
    "DictationRecorder.swift",
    "ToviWebView.swift"
  ]) {
    assert.match(projectSource, new RegExp(filename.replace(".", "\\.")));
  }
});
