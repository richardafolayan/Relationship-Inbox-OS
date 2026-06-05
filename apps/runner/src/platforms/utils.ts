import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "patchright";
import type { PlatformName } from "@inbox-os/core";

export type AdapterFailureKind =
  | "AUTH_REQUIRED"
  | "SELECTOR_MISMATCH"
  | "THREAD_FETCH_FAILED"
  | "NAVIGATION_FAILED";

export type AdapterStage = "connect" | "navigate" | "collect_threads" | "open_thread" | "parse" | "persist";

interface AdapterFailureOptions {
  kind?: AdapterFailureKind;
  stage?: AdapterStage;
  platform?: PlatformName;
  threadId?: string;
  platformThreadId?: string;
  screenshotFile?: string;
  domDumpFile?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const rawCause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: rawCause === undefined ? undefined : serializeError(rawCause)
    };
  }

  return {
    message: String(error)
  };
}

function isSafePageForDiagnostics(page: Page | undefined): page is Page {
  if (!page) {
    return false;
  }
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

export class AdapterFailure extends Error {
  kind?: AdapterFailureKind;
  stage?: AdapterStage;
  platform?: PlatformName;
  threadId?: string;
  platformThreadId?: string;
  screenshotFile?: string;
  domDumpFile?: string;
  details?: Record<string, unknown>;

  constructor(message: string, options?: AdapterFailureOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AdapterFailure";
    this.kind = options?.kind;
    this.stage = options?.stage;
    this.platform = options?.platform;
    this.threadId = options?.threadId;
    this.platformThreadId = options?.platformThreadId;
    this.screenshotFile = options?.screenshotFile;
    this.domDumpFile = options?.domDumpFile;
    this.details = options?.details;
  }
}

export function inferAdapterFailureKindFromMessage(message: string): AdapterFailureKind | undefined {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("auth required") ||
    normalized.includes("/uas/login") ||
    normalized.includes("login required") ||
    normalized.includes("sign in") ||
    normalized.includes("log in with qr code")
  ) {
    return "AUTH_REQUIRED";
  }
  if (normalized.includes("fetch thread") || normalized.includes("thread messages")) {
    return "THREAD_FETCH_FAILED";
  }
  if (
    normalized.includes("navigation") ||
    normalized.includes("net::") ||
    normalized.includes("err_") ||
    normalized.includes("failed to load")
  ) {
    return "NAVIGATION_FAILED";
  }
  if (normalized.includes("selector") || normalized.includes("waiting for selector")) {
    return "SELECTOR_MISMATCH";
  }

  return undefined;
}

export async function captureDiagnostics(input: {
  page: Page;
  platform: PlatformName;
  action: string;
  screenshotDir: string;
  domDumpDir: string;
}): Promise<{ screenshotFile?: string; domDumpFile?: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `${input.platform.toLowerCase()}-${input.action}-${stamp}`;

  let screenshotFile: string | undefined;
  let domDumpFile: string | undefined;

  try {
    screenshotFile = `${prefix}.png`;
    await input.page.screenshot({ path: join(input.screenshotDir, screenshotFile), fullPage: true });
  } catch {
    screenshotFile = undefined;
  }

  try {
    domDumpFile = `${prefix}.html`;
    const html = await input.page.content();
    await writeFile(join(input.domDumpDir, domDumpFile), html, "utf-8");
  } catch {
    domDumpFile = undefined;
  }

  return { screenshotFile, domDumpFile };
}

export async function toStageFailure(input: {
  platform: PlatformName;
  stage: AdapterStage;
  message: string;
  action: string;
  error: unknown;
  kind: AdapterFailureKind;
  page?: Page;
  screenshotDir: string;
  domDumpDir: string;
  threadId?: string;
  platformThreadId?: string;
  details?: Record<string, unknown>;
}): Promise<AdapterFailure> {
  const files =
    isSafePageForDiagnostics(input.page)
      ? await captureDiagnostics({
          page: input.page,
          platform: input.platform,
          action: input.action,
          screenshotDir: input.screenshotDir,
          domDumpDir: input.domDumpDir
        })
      : {};

  return new AdapterFailure(input.message, {
    kind: input.kind,
    platform: input.platform,
    stage: input.stage,
    threadId: input.threadId,
    platformThreadId: input.platformThreadId,
    screenshotFile: files.screenshotFile,
    domDumpFile: files.domDumpFile,
    details: {
      ...input.details,
      stage: input.stage,
      platform: input.platform,
      threadId: input.threadId ?? null,
      platformThreadId: input.platformThreadId ?? null,
      error: serializeError(input.error)
    },
    cause: input.error
  });
}

export async function retryWithBackoff<T>(input: {
  attempts: number;
  baseDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  run: (attempt: number) => Promise<T>;
}): Promise<T> {
  const safeAttempts = Math.max(1, input.attempts);
  let attempt = 0;
  let lastError: unknown;

  while (attempt < safeAttempts) {
    try {
      return await input.run(attempt + 1);
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= safeAttempts || !input.isRetryable(error)) {
        break;
      }
      const waitMs = input.baseDelayMs * attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

export function isTransientPageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /target page, context or browser has been closed/i.test(message) ||
    /execution context was destroyed/i.test(message) ||
    /navigation.*interrupted/i.test(message) ||
    /timeout/i.test(message)
  );
}

export async function humanDelay(minMs = 250, maxMs = 900): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanText(value: string): string {
  return stripUnpairedSurrogates(value).replace(/\s+/g, " ").trim();
}

export function cleanMessageText(value: string): string {
  return stripUnpairedSurrogates(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Truncate `text` to at most `maxCodePoints` Unicode code points, splitting
 * on grapheme/surrogate-pair boundaries rather than UTF-16 code units. Plain
 * `string.slice(0, n)` cuts a surrogate pair in half when `n` lands between
 * the high and low surrogate of an emoji, producing an unpaired surrogate.
 * Prisma's SQLite driver then rejects the resulting string with
 * `unexpected end of hex escape`, which silently breaks `thread.update` and
 * leaves stale row metadata in the DB.
 */
export function safeTruncate(text: string, maxCodePoints: number): string {
  if (typeof text !== "string" || text.length <= maxCodePoints) {
    return text ?? "";
  }
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) {
    return text;
  }
  return codePoints.slice(0, maxCodePoints).join("");
}

/**
 * Truncate `text` to at most `maxCodePoints` code points WITHOUT ending
 * mid-word. Backs `safeTruncate` up to the last whole-word boundary and drops
 * any dangling separator, so the result reads cleanly ("...current skills")
 * instead of bisecting a word ("...current skills fo"). Falls back to the hard
 * `safeTruncate` only when there is no word boundary to retreat to (a single
 * oversized token). Trailing sentence punctuation (. ! ?) is preserved.
 */
export function truncateAtWord(text: string, maxCodePoints: number): string {
  if (typeof text !== "string") {
    return "";
  }
  const trimmed = text.trim();
  if (Array.from(trimmed).length <= maxCodePoints) {
    return trimmed;
  }
  const cut = safeTruncate(trimmed, maxCodePoints).replace(/\s+$/u, "");
  const match = cut.match(/^(.*\S)\s+\S+$/u);
  const atWord = match?.[1] ?? cut;
  return atWord.replace(/[\s,;:–—-]+$/u, "").trim();
}

/**
 * Drop any unpaired UTF-16 surrogates that sneak through from page
 * scraping or AI output. The defensive last line for every string we write
 * to Prisma — see `safeTruncate` for the full motivation.
 */
export function stripUnpairedSurrogates(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return value ?? "";
  }
  // High surrogate (0xD800–0xDBFF) not followed by a low surrogate, OR
  // a low surrogate (0xDC00–0xDFFF) not preceded by a high surrogate.
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
