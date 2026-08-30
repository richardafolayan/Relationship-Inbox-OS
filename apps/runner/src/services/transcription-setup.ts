import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  applyRuntime: (mode: SetupTranscriptionMode, enabled: boolean, modelId: string) => void;
  download?: (modelId: string, modelDir: string) => Promise<void>;
  prepareDownloadDirectory?: (modelDir: string) => string;
  activateDownloadedModel?: (stagedDir: string, modelDir: string) => void;
}

export class TranscriptionSetupBusyError extends Error {
  constructor(readonly status: TranscriptionSetupStatus) {
    super("A transcription model change is already in progress.");
    this.name = "TranscriptionSetupBusyError";
  }
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

  const prepareDownloadDirectory =
    deps.prepareDownloadDirectory ??
    ((modelDir: string) => {
      const target = resolve(modelDir);
      const parent = dirname(target);
      mkdirSync(parent, { recursive: true });
      return mkdtempSync(join(parent, `.${basename(target)}-download-`));
    });

  const activateDownloadedModel =
    deps.activateDownloadedModel ??
    ((stagedDir: string, modelDir: string) => {
      const target = resolve(modelDir);
      if (target === "/" || target.length < 6) {
        throw new Error("Refusing to replace an unsafe model directory.");
      }
      const backup = `${target}.previous-${Date.now()}`;
      const hadTarget = existsSync(target);
      if (hadTarget) renameSync(target, backup);
      try {
        renameSync(stagedDir, target);
      } catch (error) {
        if (hadTarget && existsSync(backup) && !existsSync(target)) {
          renameSync(backup, target);
        }
        throw error;
      }
      if (hadTarget) rmSync(backup, { recursive: true, force: true });
    });

  function installedMode(): SetupTranscriptionMode {
    return transcriptionModeForModel(readMarker(deps.modelDir)?.modelId);
  }

  function currentMode(): SetupTranscriptionMode {
    if (targetMode !== null) return targetMode;
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

  function prepare(mode: SetupTranscriptionMode, removeDownloadedModels = false) {
    if (phase === "downloading") {
      throw new TranscriptionSetupBusyError(status());
    }

    const model = mode === "off" ? null : TRANSCRIPTION_MODELS[mode];
    const stagedDir = model && installedMode() !== mode
      ? prepareDownloadDirectory(deps.modelDir)
      : null;
    let settled = false;

    const discard = (): void => {
      if (settled) return;
      settled = true;
      if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
    };

    const commit = (): TranscriptionSetupStatus => {
      if (settled) throw new Error("Prepared transcription change already settled.");
      settled = true;
      lastError = null;
      targetMode = mode;

      if (mode === "off") {
        try {
          deps.applyRuntime(mode, false, deps.initialModelId());
          if (removeDownloadedModels) clearDownloads();
          phase = "idle";
        } catch (error) {
          phase = "error";
          lastError = error instanceof Error ? error.message : "The local model could not be removed.";
        }
        targetMode = null;
        return status();
      }
      const selectedModel = TRANSCRIPTION_MODELS[mode];

      if (!stagedDir) {
        try {
          deps.applyRuntime(mode, true, selectedModel.modelId);
          phase = "idle";
          targetMode = null;
        } catch (error) {
          phase = "error";
          lastError = error instanceof Error ? error.message : "Transcription could not be enabled.";
        }
        return status();
      }

      try {
        deps.applyRuntime(mode, false, selectedModel.modelId);
      } catch (error) {
        rmSync(stagedDir, { recursive: true, force: true });
        phase = "error";
        lastError = error instanceof Error ? error.message : "Transcription could not be prepared.";
        return status();
      }

      phase = "downloading";
      void Promise.resolve()
        .then(() => download(selectedModel.modelId, stagedDir))
        .then(() => {
          activateDownloadedModel(stagedDir, deps.modelDir);
          deps.applyRuntime(mode, true, selectedModel.modelId);
          phase = "idle";
          targetMode = null;
        })
        .catch((error) => {
          rmSync(stagedDir, { recursive: true, force: true });
          phase = "error";
          lastError = error instanceof Error ? error.message : "The model download failed.";
        });
      return status();
    };

    return { commit, discard };
  }

  function restore(mode: SetupTranscriptionMode): TranscriptionSetupStatus {
    lastError = null;
    targetMode = mode;
    if (mode === "off") {
      deps.applyRuntime(mode, false, deps.initialModelId());
      phase = "idle";
      targetMode = null;
      return status();
    }

    const model = TRANSCRIPTION_MODELS[mode];
    if (installedMode() === mode) {
      deps.applyRuntime(mode, true, model.modelId);
      phase = "idle";
      targetMode = null;
      return status();
    }

    deps.applyRuntime(mode, false, model.modelId);
    phase = "error";
    lastError = "The selected local model is not installed. Choose it again to resume the download.";
    return status();
  }

  return { status, prepare, restore };
}

export async function applyPreparedTranscriptionSetup<TPreferences>(input: {
  manager: Pick<ReturnType<typeof createTranscriptionSetupManager>, "prepare">;
  mode: SetupTranscriptionMode;
  removeDownloadedModels?: boolean;
  persistPreferences: () => Promise<TPreferences>;
}): Promise<{ preferences: TPreferences; status: TranscriptionSetupStatus }> {
  const prepared = input.manager.prepare(input.mode, input.removeDownloadedModels === true);
  let preferences: TPreferences;
  try {
    preferences = await input.persistPreferences();
  } catch (error) {
    prepared.discard();
    throw error;
  }
  return {
    preferences,
    status: prepared.commit()
  };
}
