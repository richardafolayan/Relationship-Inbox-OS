// @tovi-browser
// @tovi-browser-platform darwin
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import electronPath from "electron";
import { build } from "esbuild";
import {
  convertAudioToWhisperWav,
  isWhisperReadyWav
} from "../apps/runner/src/services/imessage-attachment-server.ts";
import {
  hasAudibleSpeechSignal,
  readAudioSignalSummary
} from "../apps/runner/src/services/transcription/audio-signal.ts";

const RESULT_PREFIX = "__DICTATION_BROWSER_FIXTURE__";

async function runElectronFixture(tempRoot) {
  const rendererPath = join(tempRoot, "renderer.js");
  const htmlPath = join(tempRoot, "fixture.html");
  const mainPath = join(tempRoot, "main.cjs");
  const resultPath = join(tempRoot, "result.json");
  await build({
    bundle: true,
    entryPoints: [new URL("./helpers/dictation-browser-fixture.ts", import.meta.url).pathname],
    format: "iife",
    outfile: rendererPath,
    platform: "browser",
    target: "chrome120"
  });
  await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><script src="./renderer.js"></script>');
  await writeFile(
    mainPath,
    `const { writeFileSync } = require("node:fs");
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, sandbox: false } });
  try {
    await window.loadFile(${JSON.stringify(htmlPath)});
    const result = await window.webContents.executeJavaScript("window.runDictationRuntimeFixtures()");
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.stack || error) + "\\n");
    app.exit(1);
  }
});`
  );

  return await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [mainPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron dictation fixture timed out. ${stderr}`));
    }, 60_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Electron dictation fixture failed (${code}). ${stderr || stdout}`));
        return;
      }
      readFile(resultPath, "utf8").then(
        (payload) => resolve(JSON.parse(payload)),
        reject
      );
    });
  });
}

test("real WebM/Opus recordings use browser WAV conversion and runner production validation", {
  skip: process.platform !== "darwin"
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "tovi-dictation-browser-"));
  try {
    const result = await runElectronFixture(tempRoot);
    assert.equal(result.meaningful.rawType, "audio/webm;codecs=opus");
    assert.ok(result.meaningful.rawBytes > 0);
    assert.equal(result.meaningful.filename, "dictation.wav");
    assert.equal(result.meaningful.wavType, "audio/wav");

    const meaningfulPath = join(tempRoot, "meaningful.wav");
    const meaningfulWav = Buffer.from(result.meaningful.wavBase64, "base64");
    await writeFile(meaningfulPath, meaningfulWav);
    assert.equal(isWhisperReadyWav(meaningfulWav), true);
    assert.equal(meaningfulWav.readUInt16LE(22), 1);
    assert.equal(meaningfulWav.readUInt32LE(24), 16_000);
    assert.equal(await convertAudioToWhisperWav(meaningfulPath), meaningfulPath);
    const meaningful = readAudioSignalSummary(meaningfulPath);
    assert.ok(meaningful.durationSeconds > 0.5);
    assert.ok(meaningful.peak > 0.05);
    assert.ok(meaningful.rms > 0.01);
    assert.equal(hasAudibleSpeechSignal(meaningful), true);

    const silentPath = join(tempRoot, "silent.wav");
    const silentWav = Buffer.from(result.silent.wavBase64, "base64");
    await writeFile(silentPath, silentWav);
    assert.equal(isWhisperReadyWav(silentWav), true);
    assert.equal(await convertAudioToWhisperWav(silentPath), silentPath);
    assert.equal(hasAudibleSpeechSignal(readAudioSignalSummary(silentPath)), false);

    assert.equal(result.empty.failed, true);
    assert.equal(result.corrupt.failed, true);
    assert.equal(result.unsupported.failed, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
