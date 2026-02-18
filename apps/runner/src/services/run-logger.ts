import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import type { PlatformName } from "@inbox-os/core";

export type RunTraceLevel = "debug" | "info" | "warn" | "error";

export interface RunTraceEvent {
  ts: string;
  level: RunTraceLevel;
  requestId: string;
  platform: PlatformName | string;
  component: string;
  stage: string | null;
  action: string | null;
  details: Record<string, unknown>;
  url?: string;
  pageId?: string;
  attempt?: number;
  elapsedMs?: number;
}

export interface RunTraceSummary {
  requestId: string;
  platform: PlatformName | string;
  runType: string;
  startedAt: string;
  completedAt: string;
  success: boolean;
  stopReason?: string;
  runDir?: string;
  eventsPath?: string;
  actionsPath?: string;
  playwrightTracePath?: string;
  failureScreenshotPath?: string;
  failureDomDumpPath?: string;
  counters: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface RunLogger {
  readonly enabled: boolean;
  readonly requestId: string;
  readonly platform: PlatformName | string;
  readonly runDir?: string;
  logEvent(event: Omit<RunTraceEvent, "ts" | "requestId" | "platform"> & { ts?: string }): void;
  logAction(action: {
    ts?: string;
    stage?: string | null;
    action: string;
    selector?: string;
    url?: string;
    result: string;
    elapsedMs?: number;
    counts?: Record<string, unknown>;
    note?: string;
  }): void;
  logStage(stage: {
    ts?: string;
    stage: string;
    phase: "start" | "end";
    details?: Record<string, unknown>;
    elapsedMs?: number;
    attempt?: number;
  }): void;
  logDecision(decision: {
    ts?: string;
    stage?: string | null;
    decision: string;
    details?: Record<string, unknown>;
    level?: RunTraceLevel;
    attempt?: number;
  }): void;
  logError(input: {
    ts?: string;
    component: string;
    stage?: string | null;
    action?: string | null;
    error: unknown;
    details?: Record<string, unknown>;
    elapsedMs?: number;
    attempt?: number;
    url?: string;
    pageId?: string;
  }): void;
  mergeCounters(counters: Record<string, unknown>): void;
  setStopReason(reason: string): void;
  attachArtifact(input: {
    playwrightTracePath?: string;
    failureScreenshotPath?: string;
    failureDomDumpPath?: string;
  }): void;
  copyFailureArtifacts(input: {
    screenshotPath?: string;
    domDumpPath?: string;
  }): {
    failureScreenshotPath?: string;
    failureDomDumpPath?: string;
  };
  flush(input?: {
    success?: boolean;
    stopReason?: string;
    counters?: Record<string, unknown>;
    error?: unknown;
  }): RunTraceSummary;
}

const csvHeaders = [
  "ts",
  "requestId",
  "platform",
  "stage",
  "action",
  "selector",
  "url",
  "result",
  "elapsedMs",
  "counts_json",
  "note"
].join(",");

const defaultOutDir = "./logs/runs";
const redactThreshold = 80;
const redactedTag = "[redacted]";

function isEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function nowIso(): string {
  return new Date().toISOString();
}

function dateFolder(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function resolveReason(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("repeated_reload_guard_triggered") || normalized.includes("reload suppressed")) {
    return "repeated_reload_guard_triggered";
  }
  if (normalized.includes("execution context was destroyed")) {
    return "transient_context_destroyed";
  }
  if (normalized.includes("detached")) {
    return "element_detached";
  }
  if (normalized.includes("target page, context or browser has been closed")) {
    return "page_closed_mid_stage";
  }
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("checkpoint")) {
    return "checkpoint_required";
  }
  if (normalized.includes("login") || normalized.includes("sign in")) {
    return "login_required";
  }
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return "rate_limited";
  }
  return "unknown";
}

function sanitizeString(raw: string, piiEnabled: boolean, keyHint: string): string {
  if (piiEnabled) {
    return raw;
  }

  const lowerKey = keyHint.toLowerCase();
  const likelyMessageText =
    lowerKey.includes("text") ||
    lowerKey.includes("message") ||
    lowerKey.includes("body") ||
    lowerKey.includes("content") ||
    lowerKey.includes("preview");

  if (raw.length > redactThreshold || (likelyMessageText && raw.length > 24)) {
    const preview = raw.slice(0, Math.min(24, raw.length));
    return `${preview}…${redactedTag}:${raw.length}`;
  }

  return raw;
}

function sanitizeValue(value: unknown, piiEnabled: boolean, keyHint = ""): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeString(value, piiEnabled, keyHint);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message, piiEnabled, "message"),
      stack: sanitizeString(value.stack ?? "", piiEnabled, "stack")
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, piiEnabled, keyHint));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      sanitized[key] = sanitizeValue(entry, piiEnabled, key);
    }
    return sanitized;
  }
  return String(value);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function appendLine(path: string, line: string): void {
  appendFileSync(path, `${line}\n`, "utf8");
}

function prettyPrint(event: RunTraceEvent): void {
  const stage = event.stage ?? "-";
  const action = event.action ?? "-";
  const elapsed = typeof event.elapsedMs === "number" ? ` elapsedMs=${event.elapsedMs}` : "";
  const attempt = typeof event.attempt === "number" ? ` attempt=${event.attempt}` : "";
  const url = event.url ? ` url=${event.url}` : "";
  // eslint-disable-next-line no-console
  console.info(
    `[run-trace:${event.platform}:${event.requestId}] ${event.level.toUpperCase()} ${event.component} stage=${stage} action=${action}${attempt}${elapsed}${url} details=${stringifyJson(event.details)}`
  );
}

function noOpLogger(input: {
  requestId: string;
  platform: PlatformName | string;
  runType: string;
}): RunLogger {
  const summaryFactory = (success: boolean): RunTraceSummary => ({
    requestId: input.requestId,
    platform: input.platform,
    runType: input.runType,
    startedAt: nowIso(),
    completedAt: nowIso(),
    success,
    counters: {}
  });
  return {
    enabled: false,
    requestId: input.requestId,
    platform: input.platform,
    logEvent: () => undefined,
    logAction: () => undefined,
    logStage: () => undefined,
    logDecision: () => undefined,
    logError: () => undefined,
    mergeCounters: () => undefined,
    setStopReason: () => undefined,
    attachArtifact: () => undefined,
    copyFailureArtifacts: () => ({}),
    flush: (flushInput) => summaryFactory(flushInput?.success ?? true)
  };
}

export function createRunLogger(input: {
  requestId: string;
  platform: PlatformName | string;
  runType: string;
  outDirBase?: string;
}): RunLogger {
  const traceEnabled = isEnabled(process.env.RUN_TRACE);
  if (!traceEnabled) {
    return noOpLogger({
      requestId: input.requestId,
      platform: input.platform,
      runType: input.runType
    });
  }

  const piiEnabled = isEnabled(process.env.RUN_TRACE_PII);
  const startedAt = nowIso();
  const outDirBase = resolve(input.outDirBase ?? process.env.RUN_TRACE_DIR ?? defaultOutDir);
  const runDir = resolve(outDirBase, dateFolder(new Date(startedAt)), String(input.platform).toLowerCase(), input.requestId);
  const eventsPath = join(runDir, "events.ndjson");
  const actionsPath = join(runDir, "actions.csv");
  const summaryPath = join(runDir, "summary.json");
  const defaultFailureScreenshotPath = join(runDir, "failure.png");
  const defaultFailureDomDumpPath = join(runDir, "dom.html");
  const defaultPlaywrightTracePath = join(runDir, "playwright-trace.zip");

  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(eventsPath, "", "utf8");
    writeFileSync(actionsPath, `${csvHeaders}\n`, "utf8");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[run-trace:${input.platform}:${input.requestId}] failed to initialize trace files: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return noOpLogger({
      requestId: input.requestId,
      platform: input.platform,
      runType: input.runType
    });
  }

  const counters: Record<string, unknown> = {};
  const artifacts: {
    playwrightTracePath?: string;
    failureScreenshotPath?: string;
    failureDomDumpPath?: string;
  } = {};
  let stopReason: string | undefined;
  let flushed = false;

  function writeEvent(event: Omit<RunTraceEvent, "requestId" | "platform">): void {
    const normalizedEvent: RunTraceEvent = {
      ...event,
      requestId: input.requestId,
      platform: input.platform,
      details: sanitizeValue(event.details ?? {}, piiEnabled, "details") as Record<string, unknown>
    };
    appendLine(eventsPath, stringifyJson(normalizedEvent));
    prettyPrint(normalizedEvent);
  }

  function summarizeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: sanitizeString(error.message, piiEnabled, "message"),
        stack: sanitizeString(error.stack ?? "", piiEnabled, "stack"),
        reason: resolveReason(error.message)
      };
    }
    const message = String(error);
    return {
      message: sanitizeString(message, piiEnabled, "message"),
      reason: resolveReason(message)
    };
  }

  function writeAction(action: {
    ts?: string;
    stage?: string | null;
    action: string;
    selector?: string;
    url?: string;
    result: string;
    elapsedMs?: number;
    counts?: Record<string, unknown>;
    note?: string;
  }): void {
    const countsJson = stringifyJson(sanitizeValue(action.counts ?? {}, piiEnabled, "counts"));
    const row = [
      csvEscape(action.ts ?? nowIso()),
      csvEscape(input.requestId),
      csvEscape(input.platform),
      csvEscape(action.stage ?? ""),
      csvEscape(action.action),
      csvEscape(action.selector ?? ""),
      csvEscape(action.url ?? ""),
      csvEscape(action.result),
      csvEscape(action.elapsedMs ?? ""),
      csvEscape(countsJson),
      csvEscape(sanitizeString(action.note ?? "", piiEnabled, "note"))
    ].join(",");
    appendLine(actionsPath, row);
  }

  const logger: RunLogger = {
    enabled: true,
    requestId: input.requestId,
    platform: input.platform,
    runDir,
    logEvent: (event) => {
      writeEvent({
        ts: event.ts ?? nowIso(),
        level: event.level,
        component: event.component,
        stage: event.stage,
        action: event.action,
        details: event.details,
        url: event.url,
        pageId: event.pageId,
        attempt: event.attempt,
        elapsedMs: event.elapsedMs
      });
    },
    logAction: (action) => {
      writeAction(action);
    },
    logStage: (stage) => {
      writeEvent({
        ts: stage.ts ?? nowIso(),
        level: "info",
        component: "runner",
        stage: stage.stage,
        action: stage.phase === "start" ? "stage_start" : "stage_end",
        details: {
          phase: stage.phase,
          ...(stage.details ?? {})
        },
        attempt: stage.attempt,
        elapsedMs: stage.elapsedMs
      });
    },
    logDecision: (decision) => {
      writeEvent({
        ts: decision.ts ?? nowIso(),
        level: decision.level ?? "info",
        component: "runner",
        stage: decision.stage ?? null,
        action: "decision",
        details: {
          decision: decision.decision,
          ...(decision.details ?? {})
        },
        attempt: decision.attempt
      });
    },
    logError: (errorInput) => {
      const normalized = summarizeError(errorInput.error);
      writeEvent({
        ts: errorInput.ts ?? nowIso(),
        level: "error",
        component: errorInput.component,
        stage: errorInput.stage ?? null,
        action: errorInput.action ?? "error",
        details: {
          ...normalized,
          ...(errorInput.details ?? {})
        },
        elapsedMs: errorInput.elapsedMs,
        attempt: errorInput.attempt,
        url: errorInput.url,
        pageId: errorInput.pageId
      });
    },
    mergeCounters: (nextCounters) => {
      for (const [key, value] of Object.entries(nextCounters)) {
        counters[key] = sanitizeValue(value, piiEnabled, key);
      }
    },
    setStopReason: (reason) => {
      stopReason = reason;
    },
    attachArtifact: (artifactInput) => {
      if (artifactInput.playwrightTracePath) {
        artifacts.playwrightTracePath = artifactInput.playwrightTracePath;
      }
      if (artifactInput.failureScreenshotPath) {
        artifacts.failureScreenshotPath = artifactInput.failureScreenshotPath;
      }
      if (artifactInput.failureDomDumpPath) {
        artifacts.failureDomDumpPath = artifactInput.failureDomDumpPath;
      }
    },
    copyFailureArtifacts: (artifactInput) => {
      const copied: {
        failureScreenshotPath?: string;
        failureDomDumpPath?: string;
      } = {};
      if (artifactInput.screenshotPath && existsSync(artifactInput.screenshotPath)) {
        copyFileSync(artifactInput.screenshotPath, defaultFailureScreenshotPath);
        copied.failureScreenshotPath = defaultFailureScreenshotPath;
      }
      if (artifactInput.domDumpPath && existsSync(artifactInput.domDumpPath)) {
        copyFileSync(artifactInput.domDumpPath, defaultFailureDomDumpPath);
        copied.failureDomDumpPath = defaultFailureDomDumpPath;
      }
      logger.attachArtifact(copied);
      return copied;
    },
    flush: (flushInput) => {
      if (flushed) {
        return {
          requestId: input.requestId,
          platform: input.platform,
          runType: input.runType,
          startedAt,
          completedAt: nowIso(),
          success: flushInput?.success ?? true,
          stopReason: stopReason ?? flushInput?.stopReason,
          runDir,
          eventsPath,
          actionsPath,
          playwrightTracePath: artifacts.playwrightTracePath,
          failureScreenshotPath: artifacts.failureScreenshotPath,
          failureDomDumpPath: artifacts.failureDomDumpPath,
          counters,
          error: flushInput?.error ? summarizeError(flushInput.error) : undefined
        };
      }
      flushed = true;
      if (flushInput?.stopReason) {
        stopReason = flushInput.stopReason;
      }
      if (flushInput?.counters) {
        logger.mergeCounters(flushInput.counters);
      }
      const completion = nowIso();
      const success = flushInput?.success ?? true;
      const summary: RunTraceSummary = {
        requestId: input.requestId,
        platform: input.platform,
        runType: input.runType,
        startedAt,
        completedAt: completion,
        success,
        stopReason,
        runDir,
        eventsPath,
        actionsPath,
        playwrightTracePath: artifacts.playwrightTracePath ?? (existsSync(defaultPlaywrightTracePath) ? defaultPlaywrightTracePath : undefined),
        failureScreenshotPath:
          artifacts.failureScreenshotPath ?? (existsSync(defaultFailureScreenshotPath) ? defaultFailureScreenshotPath : undefined),
        failureDomDumpPath:
          artifacts.failureDomDumpPath ?? (existsSync(defaultFailureDomDumpPath) ? defaultFailureDomDumpPath : undefined),
        counters,
        error: flushInput?.error ? summarizeError(flushInput.error) : undefined
      };
      writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

      // eslint-disable-next-line no-console
      console.info(
        `[run-trace:${input.platform}:${input.requestId}] summary success=${summary.success} stopReason=${
          summary.stopReason ?? "none"
        } runDir=${runDir} events=${eventsPath} actions=${actionsPath} trace=${summary.playwrightTracePath ?? "n/a"} failurePng=${
          summary.failureScreenshotPath ?? "n/a"
        } failureDom=${summary.failureDomDumpPath ?? "n/a"} counters=${stringifyJson(summary.counters)}`
      );
      return summary;
    }
  };

  logger.logEvent({
    level: "info",
    component: "runner",
    stage: "run_init",
    action: "trace_enabled",
    details: {
      runDir,
      eventsPath,
      actionsPath,
      piiEnabled
    }
  });

  return logger;
}

export async function executeTracedOperation<T>(input: {
  logger: RunLogger;
  component: string;
  stage?: string | null;
  action: string;
  selector?: string;
  url?: string;
  note?: string;
  counts?: Record<string, unknown>;
  attempt?: number;
  details?: Record<string, unknown>;
  run: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  input.logger.logEvent({
    level: "debug",
    component: input.component,
    stage: input.stage ?? null,
    action: `${input.action}_start`,
    details: {
      selector: input.selector,
      note: input.note,
      ...(input.details ?? {})
    },
    url: input.url,
    attempt: input.attempt
  });

  try {
    const value = await input.run();
    const elapsedMs = Date.now() - startedAt;
    input.logger.logAction({
      stage: input.stage ?? null,
      action: input.action,
      selector: input.selector,
      url: input.url,
      result: "ok",
      elapsedMs,
      counts: input.counts,
      note: input.note
    });
    input.logger.logEvent({
      level: "info",
      component: input.component,
      stage: input.stage ?? null,
      action: `${input.action}_end`,
      details: {
        ...(input.details ?? {})
      },
      elapsedMs,
      url: input.url,
      attempt: input.attempt
    });
    return value;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    input.logger.logError({
      component: input.component,
      stage: input.stage ?? null,
      action: input.action,
      error,
      elapsedMs,
      attempt: input.attempt,
      url: input.url,
      details: {
        selector: input.selector,
        note: input.note,
        ...(input.details ?? {})
      }
    });
    input.logger.logAction({
      stage: input.stage ?? null,
      action: input.action,
      selector: input.selector,
      url: input.url,
      result: "error",
      elapsedMs,
      counts: input.counts,
      note: input.note
    });
    throw error;
  }
}
