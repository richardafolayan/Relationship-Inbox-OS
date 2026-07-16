import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SetupTranscriptionMode } from "./setup-preferences";

export const TRANSCRIPTION_MODELS = {
  standard: {
    modelId: "Xenova/whisper-base.en",
    approximateBytes: 150 * 1024 * 1024
  },
  enhanced: {
    modelId: "Xenova/whisper-small.en",
    approximateBytes: 500 * 1024 * 1024
  }
} as const;

const MARKER_FILE = ".tovi-transcription-model.json";

interface ModelMarker {
  modelId: string;
  downloadedAt: string;
  bytes: number;
}

export interface TranscriptionSetupStatus {
  mode: SetupTranscriptionMode;
  phase: "idle" | "downloading" | "error";
  installedMode: SetupTranscriptionMode;
  modelId: string | null;
  downloadedBytes: number;
  approximateDownloadBytes: number;
  error: string | null;
}

export interface TranscriptionSetupManagerDeps {
  modelDir: string;
  downloadScript: string;
  initialEnabled: () => boolean;
  initialModelId: () => string;
  persist: (mode: SetupTranscriptionMode, enabled: boolean, modelId: string) => void;
  applyRuntime: (mode: SetupTranscriptionMode, enabled: boolean, modelId: string) => void;
  download?: (modelId: string, modelDir: string) => Promise<void>;
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

function readMarker(modelDir: string): ModelMarker | null {
  try {
    const value = JSON.parse(readFileSync(join(modelDir, MARKER_FILE), "utf8")) as ModelMarker;
    return typeof value.modelId === "string" ? value : null;
  } catch {
    return null;
  }
}

export function transcriptionModeForModel(modelId: string | null | undefined): SetupTranscriptionMode {
  if (modelId === TRANSCRIPTION_MODELS.standard.modelId) return "standard";
  if (modelId === TRANSCRIPTION_MODELS.enhanced.modelId) return "enhanced";
  return "off";
}

export function createTranscriptionSetupManager(deps: TranscriptionSetupManagerDeps) {
  const run = promisify(execFile);
  let phase: TranscriptionSetupStatus["phase"] = "idle";
  let targetMode: SetupTranscriptionMode | null = null;
  let lastError: string | null = null;

  const download =
    deps.download ??
    (async (modelId: string, modelDir: string) => {
      await run(process.execPath, [deps.downloadScript, "--model", modelId, "--dir", modelDir], {
        timeout: 30 * 60 * 1000,
        maxBuffer: 1024 * 1024
      });
    });

  function installedMode(): SetupTranscriptionMode {
    return transcriptionModeForModel(readMarker(deps.modelDir)?.modelId);
  }

  function currentMode(): SetupTranscriptionMode {
    if (targetMode) return targetMode;
    if (!deps.initialEnabled()) return "off";
    return transcriptionModeForModel(deps.initialModelId());
  }

  function status(): TranscriptionSetupStatus {
    const mode = currentMode();
    const marker = readMarker(deps.modelDir);
    const target = mode === "off" ? null : TRANSCRIPTION_MODELS[mode];
    return {
      mode,
      phase,
      installedMode: installedMode(),
      modelId: marker?.modelId ?? null,
      downloadedBytes: marker?.bytes ?? directoryBytes(deps.modelDir),
      approximateDownloadBytes: target?.approximateBytes ?? 0,
      error: lastError
    };
  }

  function clearDownloads(): void {
    const modelDir = resolve(deps.modelDir);
    if (modelDir === "/" || modelDir.length < 6) {
      throw new Error("Refusing to remove an unsafe model directory.");
    }
    rmSync(modelDir, { recursive: true, force: true });
    mkdirSync(modelDir, { recursive: true });
  }

  function configure(mode: SetupTranscriptionMode, removeDownloadedModels = false): TranscriptionSetupStatus {
    if (phase === "downloading") return status();
    lastError = null;
    targetMode = mode;

    if (mode === "off") {
      deps.persist(mode, false, deps.initialModelId());
      deps.applyRuntime(mode, false, deps.initialModelId());
      if (removeDownloadedModels) clearDownloads();
      targetMode = null;
      return status();
    }

    const model = TRANSCRIPTION_MODELS[mode];
    if (installedMode() === mode) {
      deps.persist(mode, true, model.modelId);
      deps.applyRuntime(mode, true, model.modelId);
      targetMode = null;
      return status();
    }

    clearDownloads();
    deps.persist(mode, false, model.modelId);
    deps.applyRuntime(mode, false, model.modelId);
    phase = "downloading";
    void download(model.modelId, deps.modelDir)
      .then(() => {
        deps.persist(mode, true, model.modelId);
        deps.applyRuntime(mode, true, model.modelId);
        phase = "idle";
        targetMode = null;
      })
      .catch((error) => {
        phase = "error";
        lastError = error instanceof Error ? error.message : "The model download failed.";
      });
    return status();
  }

  return { status, configure };
}
