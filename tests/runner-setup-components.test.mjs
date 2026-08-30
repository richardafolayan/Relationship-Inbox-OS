import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  defaultSetupPreferences,
  normalizeSetupPreferences
} = await import("../apps/runner/dist/services/setup-preferences.js");
const {
  createTranscriptionSetupManager,
  transcriptionModeForModel,
  TRANSCRIPTION_MODELS
} = await import("../apps/runner/dist/services/transcription-setup.js");

test("setup preferences accept only supported pilot sources and explicit options", () => {
  assert.deepEqual(normalizeSetupPreferences({
    selectedPlatforms: ["LINKEDIN", "INSTAGRAM", "TIKTOK", "WHATSAPP", "LINKEDIN", 7],
    aiEnabled: true,
    transcriptionMode: "enhanced",
    startedAt: "start",
    completedAt: "done"
  }), {
    selectedPlatforms: ["LINKEDIN", "INSTAGRAM", "WHATSAPP"],
    aiEnabled: true,
    transcriptionMode: "enhanced",
    startedAt: "start",
    completedAt: "done",
    revision: 0
  });
});

test("unknown setup values safely become an optional, empty setup", () => {
  assert.deepEqual(normalizeSetupPreferences({
    selectedPlatforms: "all",
    aiEnabled: "yes",
    transcriptionMode: "large-v3"
  }), defaultSetupPreferences);
});

test("known local models map to the setup choices", () => {
  assert.equal(transcriptionModeForModel(TRANSCRIPTION_MODELS.standard.modelId), "standard");
  assert.equal(transcriptionModeForModel(TRANSCRIPTION_MODELS.enhanced.modelId), "enhanced");
  assert.equal(transcriptionModeForModel("openai/whisper-large-v3"), "off");
});

test("transcription setup stays off until a download succeeds, then can remove it", async () => {
  const modelDir = mkdtempSync(join(tmpdir(), "tovi-transcription-"));
  let enabled = false;
  let modelId = TRANSCRIPTION_MODELS.standard.modelId;
  const persisted = [];
  const manager = createTranscriptionSetupManager({
    modelDir,
    downloadScript: "/unused",
    initialEnabled: () => enabled,
    initialModelId: () => modelId,
    persist: (mode, nextEnabled, nextModelId) => persisted.push([mode, nextEnabled, nextModelId]),
    applyRuntime: (_mode, nextEnabled, nextModelId) => {
      enabled = nextEnabled;
      modelId = nextModelId;
    },
    download: async (nextModelId, dir) => {
      writeFileSync(join(dir, "model.onnx"), "model");
      writeFileSync(join(dir, ".tovi-transcription-model.json"), JSON.stringify({
        modelId: nextModelId,
        downloadedAt: new Date().toISOString(),
        bytes: 5
      }));
    }
  });
  try {
    assert.equal(manager.configure("enhanced").phase, "downloading");
    assert.equal(enabled, false);
    for (let attempt = 0; attempt < 20 && manager.status().phase === "downloading"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.status().phase, "idle");
    assert.equal(manager.status().installedMode, "enhanced");
    assert.equal(enabled, true);
    assert.deepEqual(persisted.at(-1), ["enhanced", true, TRANSCRIPTION_MODELS.enhanced.modelId]);

    const off = manager.configure("off", true);
    assert.equal(off.mode, "off");
    assert.equal(off.installedMode, "off");
    assert.equal(off.downloadedBytes, 0);
    assert.equal(enabled, false);
  } finally {
    rmSync(modelDir, { recursive: true, force: true });
  }
});

test("a failed model download never enables transcription", async () => {
  const modelDir = mkdtempSync(join(tmpdir(), "tovi-transcription-"));
  let enabled = false;
  const manager = createTranscriptionSetupManager({
    modelDir,
    downloadScript: "/unused",
    initialEnabled: () => enabled,
    initialModelId: () => TRANSCRIPTION_MODELS.standard.modelId,
    persist: () => undefined,
    applyRuntime: (_mode, nextEnabled) => { enabled = nextEnabled; },
    download: async () => { throw new Error("network unavailable"); }
  });
  try {
    manager.configure("standard");
    for (let attempt = 0; attempt < 20 && manager.status().phase === "downloading"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.status().phase, "error");
    assert.match(manager.status().error, /network unavailable/);
    assert.equal(enabled, false);
  } finally {
    rmSync(modelDir, { recursive: true, force: true });
  }
});
