import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  TranscriptionOutcome,
  TranscriptionProvider,
  TranscriptionRequest
} from "./provider";

export interface LocalWhisperProviderConfig {
  /** CLI binary name or absolute path. `whisper-cli` from a vanilla whisper.cpp build. */
  command: string;
  /** Absolute path to a `ggml-*.bin` model file. */
  modelPath: string;
  /** Per-call wall-clock budget. Kills the process when exceeded. */
  timeoutMs: number;
  /** Thread count passed to whisper.cpp's `-t`. */
  threads: number;
  /** Extra argv passed verbatim after the standard flags. */
  extraArgs: string[];
}

/**
 * Indirection so tests can stub the process spawn without touching the
 * macOS file system. Production wires this to `node:child_process.spawn`.
 */
export interface ProcessRunner {
  spawn(
    command: string,
    args: string[],
    options?: { timeoutMs?: number }
  ): ChildProcess;
}

const defaultProcessRunner: ProcessRunner = {
  spawn(command, args) {
    // Stdio is "ignore" / "pipe" so we never accidentally leak whisper's
    // verbose stdout (it can echo file paths) into the runner logs. We
    // do collect stderr for short error messages on non-zero exit.
    return spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });
  }
};

/**
 * Local Whisper provider via the `whisper.cpp` CLI. Runs the binary as
 * a child process — no shell, no string interpolation — writes the
 * transcript to a temp directory, reads it back, then cleans up.
 *
 * Designed to be a near-zero-cost alternative to the OpenAI provider:
 * once whisper.cpp is built and a model file is downloaded, the only
 * per-call cost is local compute.
 *
 * Failure modes are surfaced as `skipped` outcomes with stable reason
 * codes so the dashboard can render calm hints and the operator can
 * later retry after fixing the configuration. The reasons map cleanly
 * to retryable states in transcription-service.ts.
 */
export function createLocalWhisperProvider(input: {
  config: LocalWhisperProviderConfig;
  /** Override for tests; defaults to the real `spawn`. */
  processRunner?: ProcessRunner;
}): TranscriptionProvider {
  const runner = input.processRunner ?? defaultProcessRunner;
  const { config } = input;

  return {
    id: "local-whisper",
    modelLabel: basename(config.modelPath) || "whisper.cpp",
    async transcribe(request: TranscriptionRequest): Promise<TranscriptionOutcome> {
      if (!config.command) {
        return { kind: "skipped", reason: "local_whisper_not_configured" };
      }
      if (!config.modelPath) {
        return { kind: "skipped", reason: "local_whisper_not_configured" };
      }

      // Whisper writes its output to `<output-base>.txt`. Put the base
      // inside a per-call temp dir so concurrent calls never collide
      // on the filename, and so cleanup is a single rmSync at the end.
      let tempDir: string;
      try {
        tempDir = mkdtempSync(join(tmpdir(), "inbox-os-whisper-"));
      } catch (error) {
        return {
          kind: "failed",
          errorMessage: shortenError(error)
        };
      }

      const outputBase = join(tempDir, "transcript");
      const outputTxt = `${outputBase}.txt`;

      const args = buildWhisperArgs({
        modelPath: config.modelPath,
        audioPath: request.filePath,
        language: request.language,
        threads: config.threads,
        outputBase,
        extraArgs: config.extraArgs
      });

      try {
        const result = await runProcess(runner, config.command, args, {
          timeoutMs: config.timeoutMs
        });
        if (result.kind === "timeout") {
          return { kind: "failed", errorMessage: "local_whisper_timeout" };
        }
        if (result.kind === "spawn_error") {
          return {
            kind: "skipped",
            reason: "local_whisper_command_failed"
          };
        }
        if (result.exitCode !== 0) {
          return {
            kind: "failed",
            errorMessage: "local_whisper_command_failed"
          };
        }

        let text: string;
        try {
          text = readFileSync(outputTxt, "utf8").trim();
        } catch {
          // whisper.cpp succeeded but wrote no output we can read. Treat
          // as a soft skip so the dashboard offers a retry rather than
          // surfacing a misleading "failed" state.
          return { kind: "skipped", reason: "local_whisper_empty_output" };
        }
        if (text.length === 0) {
          return { kind: "skipped", reason: "local_whisper_empty_output" };
        }
        return {
          kind: "ok",
          result: {
            text,
            model: this.modelLabel
          }
        };
      } finally {
        // Best-effort cleanup. Failure to delete the temp dir is a
        // disk-hygiene concern, not a transcription concern; we
        // swallow the error rather than mask the actual outcome.
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  };
}

/**
 * Construct the argv for a vanilla whisper.cpp `whisper-cli` invocation.
 * Exposed for tests; production callers use `transcribe` directly.
 */
export function buildWhisperArgs(input: {
  modelPath: string;
  audioPath: string;
  language?: string;
  threads: number;
  outputBase: string;
  extraArgs: string[];
}): string[] {
  const args = [
    "-m",
    input.modelPath,
    "-f",
    input.audioPath,
    // `-otxt` writes a plain .txt; `-of` controls the output base so
    // we know exactly where to read from.
    "-otxt",
    "-of",
    input.outputBase,
    // `-nt` suppresses timestamps; we want the prose only.
    "-nt",
    "-t",
    String(input.threads)
  ];
  if (input.language && input.language.trim().length > 0) {
    args.push("-l", input.language.trim());
  }
  for (const arg of input.extraArgs) {
    args.push(arg);
  }
  return args;
}

type ProcessResult =
  | { kind: "ok"; exitCode: number; stderr: string }
  | { kind: "timeout" }
  | { kind: "spawn_error"; errorMessage: string };

async function runProcess(
  runner: ProcessRunner,
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = runner.spawn(command, args, { timeoutMs: options.timeoutMs });
    } catch (error) {
      resolve({ kind: "spawn_error", errorMessage: shortenError(error) });
      return;
    }

    let timeoutFired = false;
    const timer = setTimeout(() => {
      timeoutFired = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ kind: "timeout" });
    }, options.timeoutMs);

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      // Cap collected stderr so a chatty CLI doesn't balloon memory.
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    child.on("error", (error) => {
      if (timeoutFired) return;
      clearTimeout(timer);
      resolve({ kind: "spawn_error", errorMessage: shortenError(error) });
    });

    child.on("close", (code) => {
      if (timeoutFired) return;
      clearTimeout(timer);
      resolve({ kind: "ok", exitCode: code ?? 0, stderr });
    });
  });
}

function shortenError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 200 ? `${error.message.slice(0, 200)}...` : error.message;
  }
  const text = String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}
