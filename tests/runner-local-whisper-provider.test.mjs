import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWhisperArgs,
  createLocalWhisperProvider
} from "../apps/runner/dist/services/transcription/local-whisper-provider.js";

function fakeChildSuccess(transcriptText, outputBase) {
  // Simulate whisper.cpp writing `<outputBase>.txt`. Emit `close` on the
  // next tick so the provider's promise has a chance to attach listeners.
  const emitter = new EventEmitter();
  emitter.stdout = null;
  emitter.stderr = new EventEmitter();
  emitter.kill = () => {};
  setImmediate(() => {
    writeFileSync(`${outputBase}.txt`, transcriptText);
    emitter.emit("close", 0);
  });
  return emitter;
}

function fakeChildExit(code, stderr = "") {
  const emitter = new EventEmitter();
  emitter.stdout = null;
  emitter.stderr = new EventEmitter();
  emitter.kill = () => {};
  setImmediate(() => {
    if (stderr) emitter.stderr.emit("data", Buffer.from(stderr));
    emitter.emit("close", code);
  });
  return emitter;
}

function fakeChildHang() {
  // Never closes — provider's timeout has to win the race.
  const emitter = new EventEmitter();
  emitter.stdout = null;
  emitter.stderr = new EventEmitter();
  emitter.killed = false;
  emitter.kill = () => {
    emitter.killed = true;
  };
  return emitter;
}

function fakeChildSpawnError(message) {
  const emitter = new EventEmitter();
  emitter.stdout = null;
  emitter.stderr = new EventEmitter();
  emitter.kill = () => {};
  setImmediate(() => emitter.emit("error", new Error(message)));
  return emitter;
}

function baseConfig(overrides = {}) {
  return {
    command: "whisper-cli",
    modelPath: "/models/ggml-base.en.bin",
    timeoutMs: 5_000,
    threads: 4,
    extraArgs: [],
    ...overrides
  };
}

function makeRequest(filePath) {
  return {
    filePath,
    mimeType: "audio/mp4",
    filename: "voice-note.m4a",
    language: "en",
    model: ""
  };
}

// Default stub for the WAV converter: pretend afconvert ran and produced
// a sibling .wav. Tests that need to assert the converter's input/output
// override this directly.
function passthroughConvertToWav(input) {
  return Promise.resolve(input.replace(/\.[^./]+$/, ".wav"));
}

test("buildWhisperArgs assembles the expected CLI argv", () => {
  const args = buildWhisperArgs({
    modelPath: "/m/ggml.bin",
    audioPath: "/a/voice.m4a",
    language: "en",
    threads: 6,
    outputBase: "/o/out",
    extraArgs: ["--max-len", "0"]
  });
  assert.deepEqual(args, [
    "-m",
    "/m/ggml.bin",
    "-f",
    "/a/voice.m4a",
    "-otxt",
    "-of",
    "/o/out",
    "-nt",
    "-t",
    "6",
    "-l",
    "en",
    "--max-len",
    "0"
  ]);
});

test("missing command short-circuits to local_whisper_not_configured", async () => {
  const provider = createLocalWhisperProvider({
    config: baseConfig({ command: "" }),
    processRunner: { spawn: () => { throw new Error("should not be called"); } },
    convertToWav: passthroughConvertToWav
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/x.m4a"));
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.reason, "local_whisper_not_configured");
});

test("missing model path short-circuits to local_whisper_not_configured", async () => {
  const provider = createLocalWhisperProvider({
    config: baseConfig({ modelPath: "" }),
    processRunner: { spawn: () => { throw new Error("should not be called"); } },
    convertToWav: passthroughConvertToWav
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/x.m4a"));
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.reason, "local_whisper_not_configured");
});

test("happy path reads transcript and surfaces it via outcome", async () => {
  let lastArgs;
  let wavCalls = 0;
  const provider = createLocalWhisperProvider({
    config: baseConfig({ modelPath: "/m/ggml-base.en.bin" }),
    processRunner: {
      spawn(_command, args) {
        lastArgs = args;
        // outputBase is the `-of` argv that follows. Find it.
        const outputBaseIdx = args.indexOf("-of") + 1;
        return fakeChildSuccess(" Hello from local whisper ", args[outputBaseIdx]);
      }
    },
    convertToWav: async (path) => {
      wavCalls += 1;
      return path.replace(/\.[^./]+$/, ".wav");
    }
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/voice.m4a"));
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.result.text, "Hello from local whisper");
  // The provider tags rows with the basename so the operator can see in
  // the DB which model produced a given transcript.
  assert.equal(outcome.result.model, "ggml-base.en.bin");
  assert.ok(lastArgs.includes("-m"), "argv should include -m");
  // whisper-cli must be given the converted WAV, not the original m4a.
  assert.equal(wavCalls, 1, "wav converter should run once");
  assert.ok(lastArgs.includes("/tmp/voice.wav"), "argv should reference the WAV file");
  assert.ok(
    !lastArgs.includes("/tmp/voice.m4a"),
    "argv must not still reference the source m4a"
  );
});

test("non-zero exit becomes a failed outcome (no leaked stderr)", async () => {
  const provider = createLocalWhisperProvider({
    config: baseConfig(),
    processRunner: {
      spawn: () => fakeChildExit(2, "model file not loadable")
    },
    convertToWav: passthroughConvertToWav
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/voice.m4a"));
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.errorMessage, "local_whisper_command_failed");
});

test("spawn error (command not found) is a skipped local_whisper_command_failed", async () => {
  const provider = createLocalWhisperProvider({
    config: baseConfig(),
    processRunner: {
      spawn: () => fakeChildSpawnError("ENOENT")
    },
    convertToWav: passthroughConvertToWav
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/voice.m4a"));
  // ENOENT comes through as `error` event (vs synchronous throw); the
  // provider routes it to skipped so the operator can retry after
  // installing whisper.cpp.
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.reason, "local_whisper_command_failed");
});

test("timeout kills the process and surfaces local_whisper_timeout", async () => {
  let child;
  const provider = createLocalWhisperProvider({
    config: baseConfig({ timeoutMs: 20 }),
    processRunner: {
      spawn: () => {
        child = fakeChildHang();
        return child;
      }
    },
    convertToWav: passthroughConvertToWav
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/voice.m4a"));
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.errorMessage, "local_whisper_timeout");
  assert.equal(child.killed, true, "child should have been killed");
});

test("empty transcript becomes skipped local_whisper_empty_output", async () => {
  const provider = createLocalWhisperProvider({
    config: baseConfig(),
    processRunner: {
      spawn(_command, args) {
        const outputBase = args[args.indexOf("-of") + 1];
        // Whisper exits 0 but writes only whitespace.
        return fakeChildSuccess("   \n  ", outputBase);
      }
    },
    convertToWav: passthroughConvertToWav
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/voice.m4a"));
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.reason, "local_whisper_empty_output");
});

test("WAV conversion failure becomes skipped local_whisper_conversion_failed", async () => {
  // afconvert refused the container (corrupted CAF, unsupported codec).
  // Provider should never invoke whisper-cli — there's nothing to read.
  const provider = createLocalWhisperProvider({
    config: baseConfig(),
    processRunner: {
      spawn: () => { throw new Error("should not be called"); }
    },
    convertToWav: async () => null
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/voice.m4a"));
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.reason, "local_whisper_conversion_failed");
});

test("temp dir is cleaned up after a successful run", async () => {
  // Watch tmpdir before/after to confirm the per-call directory is gone.
  const before = mkdtempSync(join(tmpdir(), "inbox-os-whisper-anchor-"));
  // Capture the temp dir used by the provider via the args.
  let capturedOutputDir;
  const provider = createLocalWhisperProvider({
    config: baseConfig(),
    processRunner: {
      spawn(_command, args) {
        const outputBase = args[args.indexOf("-of") + 1];
        capturedOutputDir = outputBase.replace(/\/transcript$/, "");
        return fakeChildSuccess("done.", outputBase);
      }
    },
    convertToWav: passthroughConvertToWav
  });
  const outcome = await provider.transcribe(makeRequest("/tmp/voice.m4a"));
  assert.equal(outcome.kind, "ok");
  assert.ok(capturedOutputDir, "expected an output dir");
  assert.equal(
    existsSync(capturedOutputDir),
    false,
    "provider should have cleaned up its temp dir"
  );
  // Anchor still around (we never asked the provider to touch it).
  assert.equal(existsSync(before), true);
});
