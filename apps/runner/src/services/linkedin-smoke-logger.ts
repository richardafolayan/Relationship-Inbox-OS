import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunLogger } from "./run-logger.js";

function isEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function shouldLogToTerminal(): boolean {
  return isEnabled(process.env.DEV_LOG, process.env.NODE_ENV !== "production");
}

function shouldAllowPii(): boolean {
  return isEnabled(process.env.DEV_LOG_PII, false);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function redactString(value: string, piiEnabled: boolean, keyHint: string): string {
  if (piiEnabled) {
    return value;
  }

  const key = keyHint.toLowerCase();
  const shouldRedact =
    key.includes("text") ||
    key.includes("name") ||
    key.includes("preview") ||
    key.includes("snippet") ||
    key.includes("sender") ||
    key.includes("message");

  if (!shouldRedact) {
    return value;
  }

  return `[redacted:${value.length}]`;
}

function sanitizeDetails(value: unknown, piiEnabled: boolean, keyHint = ""): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, piiEnabled, keyHint);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDetails(entry, piiEnabled, keyHint));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      next[key] = sanitizeDetails(entry, piiEnabled, key);
    }
    return next;
  }
  return String(value);
}

export interface LinkedInSmokeLogger {
  readonly requestId: string;
  readonly logDir: string;
  readonly prettyLogPath: string;
  logLine(message: string): Promise<void>;
  logStep(input: {
    step: number;
    totalSteps: number;
    stepName: string;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  logLogDir(): Promise<void>;
}

export async function createLinkedInSmokeLogger(input: {
  requestId: string;
  logDir: string;
  runLogger?: RunLogger;
}): Promise<LinkedInSmokeLogger> {
  const requestId = input.requestId;
  const logDir = resolve(input.logDir);
  const prettyLogPath = join(logDir, "pretty.log");
  const terminalEnabled = shouldLogToTerminal();
  const piiEnabled = shouldAllowPii();

  await mkdir(logDir, { recursive: true });
  await writeFile(prettyLogPath, "", "utf8");

  let writeQueue = Promise.resolve();

  const emit = async (line: string): Promise<void> => {
    if (terminalEnabled) {
      // eslint-disable-next-line no-console
      console.info(line);
    }
    writeQueue = writeQueue.then(() => appendFile(prettyLogPath, `${line}\n`, "utf8"));
    await writeQueue;
  };

  return {
    requestId,
    logDir,
    prettyLogPath,
    logLine: (message: string) => emit(message),
    logStep: async ({ step, totalSteps, stepName, message, details }) => {
      const safeDetails = details ? (sanitizeDetails(details, piiEnabled) as Record<string, unknown>) : undefined;
      const suffix = safeDetails ? ` details=${stringifyJson(safeDetails)}` : "";
      const line = `[LI][SMOKE][req=${requestId}][step=${step}/${totalSteps}] ${stepName}: ${message}${suffix}`;
      await emit(line);
      input.runLogger?.logEvent({
        level: "info",
        component: "linkedin-smoke",
        stage: stepName,
        action: "step",
        details: {
          step,
          totalSteps,
          message,
          ...(safeDetails ?? {})
        }
      });
    },
    logLogDir: () => emit(`[LI][SMOKE][req=${requestId}] LOG_DIR: ${logDir}`)
  };
}

export async function writeLatestLinkedInSmokePointer(input: {
  runTraceBaseDir: string;
  requestId: string;
  logDir: string;
}): Promise<string> {
  const pointerPath = resolve(input.runTraceBaseDir, "LATEST_LINKEDIN_SMOKE.txt");
  await mkdir(resolve(input.runTraceBaseDir), { recursive: true });
  await writeFile(pointerPath, `LOG_DIR=${resolve(input.logDir)}\nrequestId=${input.requestId}\n`, "utf8");
  return pointerPath;
}
