import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { PlatformName } from "@inbox-os/core";

export type AdapterFailureKind =
  | "AUTH_REQUIRED"
  | "SELECTOR_MISMATCH"
  | "THREAD_FETCH_FAILED"
  | "NAVIGATION_FAILED";

interface AdapterFailureOptions {
  kind?: AdapterFailureKind;
  screenshotFile?: string;
  domDumpFile?: string;
  details?: Record<string, unknown>;
}

export class AdapterFailure extends Error {
  kind?: AdapterFailureKind;
  screenshotFile?: string;
  domDumpFile?: string;
  details?: Record<string, unknown>;

  constructor(message: string, options?: AdapterFailureOptions) {
    super(message);
    this.name = "AdapterFailure";
    this.kind = options?.kind;
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
    normalized.includes("sign in")
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

export async function humanDelay(minMs = 250, maxMs = 900): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
