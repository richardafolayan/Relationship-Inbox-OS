import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformName, SelectorRegistry, SelectorTestReport, SelectorTestResult } from "@inbox-os/core";
import { v4 as uuid } from "uuid";
import type { ElementHandle, Page } from "playwright";
import type { SessionManager } from "./session-manager";

interface SelectorTestServiceDeps {
  resolveSelectors: (platform: PlatformName) => Promise<SelectorRegistry>;
  sessionManager: SessionManager;
  screenshotDir: string;
  domDumpDir: string;
}

const baseSelectorKeys: Array<keyof SelectorRegistry> = [
  "thread_list",
  "thread_item",
  "unread_badge",
  "message_container",
  "message_item",
  "message_text",
  "composer_input",
  "send_button"
];
const linkedInSelectorKeys: Array<keyof SelectorRegistry> = [...baseSelectorKeys, "thread_snippet"];
const selectorMinCounts: Partial<Record<keyof SelectorRegistry, number>> = {
  unread_badge: 0
};
const defaultSelectorMinCount = 1;

const conversationKeys = new Set<keyof SelectorRegistry>([
  "message_item",
  "message_text",
  "composer_input",
  "send_button"
]);

const adaptiveConversationProbeLimit = 8;
const linkedInUnreadPillSelector = "button[data-test-messaging-inbox-filters__filter-pill='UNREAD']";
const linkedInShellProbeSelectors = [
  "main",
  "#main",
  ".scaffold-layout__main",
  ".msg-overlay-list-bubble__content",
  ".msg-conversations-container",
  "[class*='msg-conversations-container']"
];

type SelectorTestStage = "connect" | "navigate" | "auth_check" | "open_thread" | "evaluate" | "screenshot" | "persist";

function selectorKeysForPlatform(platform: PlatformName): Array<keyof SelectorRegistry> {
  return platform === "LINKEDIN" ? linkedInSelectorKeys : baseSelectorKeys;
}

function selectorMinCountForKey(key: keyof SelectorRegistry): number {
  return selectorMinCounts[key] ?? defaultSelectorMinCount;
}

export interface SelectorTestReceipt {
  stage: SelectorTestStage;
  status: "OK" | "FAIL";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface SelectorTestFailurePayload {
  ok: false;
  platform: PlatformName;
  stage: SelectorTestStage;
  error: string;
  requestId: string;
  reason?: string;
  receipts: SelectorTestReceipt[];
  artifacts?: {
    screenshot?: string;
    domDump?: string;
  };
}

export interface SelectorTestRunReport extends SelectorTestReport {
  receipts: SelectorTestReceipt[];
}

class SelectorAuthRequiredError extends Error {
  constructor(
    readonly reason: string,
    readonly details?: Record<string, unknown>
  ) {
    super("Platform authentication is required before selector tests can run.");
    this.name = "SelectorAuthRequiredError";
  }
}

export class SelectorTestServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly payload: SelectorTestFailurePayload,
    options?: { cause?: unknown }
  ) {
    super(payload.error, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SelectorTestServiceError";
  }
}

export function isSelectorTestServiceError(error: unknown): error is SelectorTestServiceError {
  return error instanceof SelectorTestServiceError;
}

export function buildAdaptiveProbeIndices(threadCount: number, maxProbeThreads = adaptiveConversationProbeLimit): number[] {
  const safeCount = Number.isFinite(threadCount) ? Math.max(0, Math.floor(threadCount)) : 0;
  const limit = Number.isFinite(maxProbeThreads) ? Math.max(0, Math.floor(maxProbeThreads)) : 0;
  const max = Math.min(safeCount, limit);
  return Array.from({ length: max }, (_value, index) => index);
}

export async function findFirstPassingProbeIndex(
  indices: number[],
  matcher: (index: number) => Promise<boolean>
): Promise<number> {
  for (const index of indices) {
    if (await matcher(index)) {
      return index;
    }
  }

  return -1;
}

export function buildSelectorCountEvaluateSource(): string {
  return ((selectorList: string[]) =>
    selectorList.map((selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    })).toString();
}

export async function evaluateSelectorCounts(page: Page, selectorList: string[]): Promise<number[]> {
  return page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        try {
          return document.querySelectorAll(selector).length;
        } catch {
          return 0;
        }
      }),
    selectorList
  );
}

async function resolveLinkedInShellForSelectorDiagnostics(page: Page): Promise<{
  handle: ElementHandle<Element>;
  selector: string;
  index: number;
  summary: { tag: string; id: string; className: string };
} | null> {
  const resolution = await page
    .evaluate((selectors) => {
      const candidates: Array<{
        selector: string;
        index: number;
        score: number;
        summary: { tag: string; id: string; className: string };
      }> = [];
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index];
          if (!node) {
            continue;
          }
          const rowSignalCount = node.querySelectorAll("li.msg-conversation-listitem, div.msg-conversation-listitem__link").length;
          const messagePaneCount = node.querySelectorAll(".msg-s-message-list, [class*='msg-s-message']").length;
          const filterCount = node.querySelectorAll("button[data-test-messaging-inbox-filters__filter-pill]").length;
          const score = rowSignalCount * 4 + messagePaneCount + filterCount;
          const asElement = node as HTMLElement;
          candidates.push({
            selector,
            index,
            score,
            summary: {
              tag: asElement.tagName.toLowerCase(),
              id: (asElement.id ?? "").trim(),
              className: (asElement.className ?? "").toString().replace(/\s+/g, " ").trim()
            }
          });
        }
      }
      candidates.sort((left, right) => right.score - left.score);
      return candidates[0] ?? null;
    }, linkedInShellProbeSelectors)
    .catch(() => null);
  if (!resolution) {
    return null;
  }
  const handle = await page.locator(resolution.selector).nth(resolution.index).elementHandle().catch(() => null);
  if (!handle) {
    return null;
  }
  return {
    handle,
    selector: resolution.selector,
    index: resolution.index,
    summary: resolution.summary
  };
}

async function countSelectorWithinShell(shell: ElementHandle<Element>, selector: string): Promise<number> {
  return shell
    .evaluate((shellNode, selectorInput) => {
      try {
        return shellNode.querySelectorAll(selectorInput).length;
      } catch {
        return 0;
      }
    }, selector)
    .catch(() => 0);
}

async function captureSelectorFailureArtifacts(input: {
  page?: Page;
  stage: SelectorTestStage;
  platform: PlatformName;
  requestId: string;
  screenshotDir: string;
  domDumpDir: string;
}): Promise<{ screenshot?: string; domDump?: string }> {
  const page = input.page;
  if (!page) {
    return {};
  }

  try {
    if (page.isClosed()) {
      return {};
    }
  } catch {
    return {};
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `${input.platform.toLowerCase()}-selector-${input.stage}-${input.requestId}-${stamp}`;

  let screenshot: string | undefined;
  let domDump: string | undefined;

  try {
    screenshot = `${prefix}.png`;
    await page.screenshot({ path: join(input.screenshotDir, screenshot), fullPage: true });
  } catch {
    screenshot = undefined;
  }

  try {
    domDump = `${prefix}.html`;
    const html = await page.content();
    await writeFile(join(input.domDumpDir, domDump), html, "utf8");
  } catch {
    domDump = undefined;
  }

  return {
    screenshot,
    domDump
  };
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function classifySelectorFailureReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/target page, context or browser has been closed/i.test(message)) {
    return "page_closed_mid_stage";
  }
  if (/failed to open a new tab|target\.createtarget/i.test(message)) {
    return "page_closed_mid_stage";
  }
  if (/timeouterror|timeout/i.test(message)) {
    return "timeout";
  }
  if (/detached/i.test(message)) {
    return "element_detached";
  }
  if (/execution context was destroyed/i.test(message)) {
    return "transient_context_destroyed";
  }
  return undefined;
}

function selectorTestFailureStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SelectorAuthRequiredError) {
    return 401;
  }
  if (/profile.*in use|already in use|singleton|session.*busy|locked/i.test(message)) {
    return 409;
  }
  return 500;
}

async function detectAuthRequired(page: Page, platform: PlatformName): Promise<{ required: boolean; reason?: string }> {
  const url = page.url().toLowerCase();

  if (platform === "LINKEDIN") {
    const linkedInUrlGate = /\/uas\/login|\/checkpoint\//i.test(url);
    if (linkedInUrlGate) {
      return { required: true, reason: "login_required" };
    }

    const usernameCount = await page.locator("#username").count().catch(() => 0);
    const passwordCount = await page.locator("#password").count().catch(() => 0);
    if (usernameCount > 0 || passwordCount > 0) {
      return { required: true, reason: "login_required" };
    }
  }

  if (platform === "INSTAGRAM") {
    if (/\/accounts\/login/i.test(url)) {
      return { required: true, reason: "login_required" };
    }

    const usernameCount = await page.locator("input[name='username']").count().catch(() => 0);
    const passwordCount = await page.locator("input[name='password']").count().catch(() => 0);
    if (usernameCount > 0 || passwordCount > 0) {
      return { required: true, reason: "login_required" };
    }
  }

  if (platform === "TIKTOK") {
    if (/\/login|\/signup/i.test(url)) {
      return { required: true, reason: "login_required" };
    }

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const hasQrGate = bodyText.includes("log in with qr code") || bodyText.includes("scan with your mobile device");
    const hasAuthPrompt = bodyText.includes("log in") || bodyText.includes("sign up");
    if (hasQrGate || hasAuthPrompt) {
      return { required: true, reason: hasQrGate ? "qr_login_required" : "login_required" };
    }
  }

  return {
    required: false
  };
}

export function createSelectorTestService(deps: SelectorTestServiceDeps) {
  async function run(input: {
    platform: PlatformName;
    key?: keyof SelectorRegistry;
    selector?: string;
  }): Promise<SelectorTestRunReport> {
    const requestId = uuid();
    const reportId = uuid();
    const startedAt = new Date().toISOString();

    const selectors = await deps.resolveSelectors(input.platform);
    if (input.key && input.selector) {
      selectors[input.key] = input.selector;
    }

    const receipts: SelectorTestReceipt[] = [];
    let page: Page | undefined;

    const runStage = async <T>(
      stage: SelectorTestStage,
      action: () => Promise<T>,
      details?: Record<string, unknown>
    ): Promise<T> => {
      const started = Date.now();
      const startedIso = new Date(started).toISOString();

      try {
        const value = await action();
        receipts.push({
          stage,
          status: "OK",
          startedAt: startedIso,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          details
        });
        return value;
      } catch (error) {
        const artifacts = await captureSelectorFailureArtifacts({
          page,
          stage,
          platform: input.platform,
          requestId,
          screenshotDir: deps.screenshotDir,
          domDumpDir: deps.domDumpDir
        });

        const authReason = error instanceof SelectorAuthRequiredError ? error.reason : undefined;
        const classifiedReason = classifySelectorFailureReason(error);
        const payload: SelectorTestFailurePayload = {
          ok: false,
          platform: input.platform,
          stage,
          error: error instanceof Error ? error.message : String(error),
          requestId,
          reason: authReason ?? classifiedReason,
          receipts: receipts.concat([
            {
              stage,
              status: "FAIL",
              startedAt: startedIso,
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - started,
              details: {
                ...(details ?? {}),
                ...summarizeError(error),
                ...(error instanceof SelectorAuthRequiredError && error.details ? error.details : {})
              }
            }
          ]),
          artifacts
        };

        throw new SelectorTestServiceError(selectorTestFailureStatus(error), payload, {
          cause: error
        });
      }
    };

    page = await runStage("connect", async () => {
      return deps.sessionManager.getManagedPage({
        platform: input.platform,
        personKey: "default"
      });
    });

    const navigateDetails: Record<string, unknown> = {
      inboxUrl: selectors.inbox_url,
      effectiveSelectors: {
        thread_list: selectors.thread_list,
        thread_item: selectors.thread_item
      }
    };
    await runStage("navigate", async () => {
      await page!.bringToFront();
      await page!.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
      await page!.waitForTimeout(400);
      if (input.platform === "LINKEDIN") {
        const globalThreadListCount = await page!.locator(selectors.thread_list).count().catch(() => 0);
        const globalThreadItemCount = await page!.locator(selectors.thread_item).count().catch(() => 0);
        const shellResolution = await resolveLinkedInShellForSelectorDiagnostics(page!);
        let shellThreadListCount = 0;
        let shellThreadItemCount = 0;
        if (shellResolution) {
          shellThreadListCount = await countSelectorWithinShell(shellResolution.handle, selectors.thread_list);
          shellThreadItemCount = await countSelectorWithinShell(shellResolution.handle, selectors.thread_item);
        }
        navigateDetails["shellSummary"] = shellResolution
          ? {
              selector: shellResolution.selector,
              index: shellResolution.index,
              ...shellResolution.summary
            }
          : null;
        navigateDetails["counts"] = {
          global: {
            thread_list: globalThreadListCount,
            thread_item: globalThreadItemCount
          },
          shell: {
            thread_list: shellThreadListCount,
            thread_item: shellThreadItemCount
          }
        };
      }
    }, navigateDetails);

    await runStage("auth_check", async () => {
      const authState = await detectAuthRequired(page!, input.platform);
      if (authState.required) {
        throw new SelectorAuthRequiredError(authState.reason ?? "login_required", {
          url: page!.url()
        });
      }
    });

    const keys = input.key ? [input.key] : selectorKeysForPlatform(input.platform);
    const results: SelectorTestResult[] = [];
    let conversationOpened = false;
    let adaptiveProbeAttempted = false;
    let replyCapableConversationFound = false;

    async function countWithRetry(selector: string, attempts = 4, delayMs = 300): Promise<number> {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const counts = await evaluateSelectorCounts(page!, [selector]);
        const count = counts[0] ?? 0;
        if (count > 0) {
          return count;
        }

        if (attempt < attempts - 1) {
          await page!.waitForTimeout(delayMs);
        }
      }

      return 0;
    }

    async function openThreadAtIndex(index: number): Promise<boolean> {
      const thread = page!.locator(selectors.thread_item).nth(index);
      if ((await thread.count()) === 0) {
        return false;
      }

      await thread.click({ timeout: 5000 }).catch(() => undefined);
      await page!.waitForTimeout(700);
      return true;
    }

    async function probeReplyCapableConversation(): Promise<boolean> {
      const threadCount = await page!.locator(selectors.thread_item).count();
      const indices = buildAdaptiveProbeIndices(threadCount);
      const matchIndex = await findFirstPassingProbeIndex(indices, async (index) => {
        const clicked = await openThreadAtIndex(index);
        if (!clicked) {
          return false;
        }

        const composerCount = await countWithRetry(selectors.composer_input, 2, 200);
        const sendCount = await countWithRetry(selectors.send_button, 2, 200);
        const containerCount = await countWithRetry(selectors.message_container, 2, 200);

        if (containerCount > 0) {
          conversationOpened = true;
        }

        return composerCount > 0 || sendCount > 0;
      });

      if (matchIndex >= 0) {
        conversationOpened = true;
        replyCapableConversationFound = true;
        return true;
      }

      return false;
    }

    async function ensureConversationContext(key: keyof SelectorRegistry): Promise<void> {
      if (!conversationKeys.has(key)) {
        return;
      }

      if (input.platform === "LINKEDIN") {
        const unreadPill = page!.locator(linkedInUnreadPillSelector).first();
        if ((await unreadPill.count()) > 0) {
          const isActive = ((await unreadPill.getAttribute("aria-pressed")) ?? "").toLowerCase() === "true";
          if (isActive) {
            await unreadPill.click({ timeout: 3000 }).catch(() => undefined);
            await page!.waitForTimeout(250);
          }
        }
      }

      const hasMessages = (await page!.locator(selectors.message_item).count()) > 0;
      const hasComposer = (await page!.locator(selectors.composer_input).count()) > 0;
      const hasContainer = (await page!.locator(selectors.message_container).count()) > 0;
      const needsReplyCapableProbe = key === "composer_input" || key === "send_button";

      if (hasMessages || hasComposer || hasContainer) {
        conversationOpened = true;
        if (hasComposer) {
          replyCapableConversationFound = true;
        }
      }

      if (needsReplyCapableProbe && !replyCapableConversationFound && !adaptiveProbeAttempted) {
        adaptiveProbeAttempted = true;
        const foundReplyCapableConversation = await probeReplyCapableConversation();
        if (foundReplyCapableConversation) {
          return;
        }
      }

      if (conversationOpened) {
        return;
      }

      const openedFirstThread = await openThreadAtIndex(0);
      if (!openedFirstThread) {
        return;
      }

      const nowHasMessages = (await page!.locator(selectors.message_item).count()) > 0;
      const nowHasComposer = (await page!.locator(selectors.composer_input).count()) > 0;
      const nowHasContainer = (await page!.locator(selectors.message_container).count()) > 0;

      conversationOpened = nowHasMessages || nowHasComposer || nowHasContainer;
      if (nowHasComposer) {
        replyCapableConversationFound = true;
      }
    }

    for (const key of keys) {
      const selectorRaw = selectors[key];
      const selector =
        typeof selectorRaw === "string" && selectorRaw.trim().length > 0
          ? selectorRaw.trim()
          : key === "thread_snippet"
            ? "p.msg-conversation-card__message-snippet"
            : "";
      let count = 0;
      let status: "PASS" | "FAIL" = "FAIL";
      let screenshotFile: string | undefined;
      const minCount = selectorMinCountForKey(key);

      if (conversationKeys.has(key)) {
        const started = Date.now();
        const startedAtValue = new Date(started).toISOString();
        try {
          await ensureConversationContext(key);
          receipts.push({
            stage: "open_thread",
            status: "OK",
            startedAt: startedAtValue,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            details: { key }
          });
        } catch (error) {
          receipts.push({
            stage: "open_thread",
            status: "FAIL",
            startedAt: startedAtValue,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            details: {
              key,
              ...summarizeError(error)
            }
          });
        }
      }

      const evalStarted = Date.now();
      const evalStartedAt = new Date(evalStarted).toISOString();
      try {
        if (!selector) {
          count = 0;
          status = minCount <= 0 ? "PASS" : "FAIL";
        } else {
          count = await countWithRetry(selector);
          status = count >= minCount ? "PASS" : "FAIL";
        }

        if (status === "FAIL" && key === "message_item") {
          const composerCount = await countWithRetry(selectors.composer_input, 2, 200);
          if (composerCount > 0) {
            status = "PASS";
          }
        }

        if (status === "FAIL" && key === "send_button") {
          const composerCount = await countWithRetry(selectors.composer_input, 2, 200);
          if (composerCount > 0) {
            status = "PASS";
          }
        }

        receipts.push({
          stage: "evaluate",
          status: "OK",
          startedAt: evalStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - evalStarted,
          details: { key, selector, count, minCount }
        });
      } catch (error) {
        receipts.push({
          stage: "evaluate",
          status: "FAIL",
          startedAt: evalStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - evalStarted,
          details: {
            key,
            selector,
            ...summarizeError(error)
          }
        });
        status = "FAIL";
      }

      const screenshotStarted = Date.now();
      const screenshotStartedAt = new Date(screenshotStarted).toISOString();
      try {
        screenshotFile = `${input.platform.toLowerCase()}-${key}-${Date.now()}.png`;
        await page.screenshot({ path: join(deps.screenshotDir, screenshotFile), fullPage: true });

        receipts.push({
          stage: "screenshot",
          status: "OK",
          startedAt: screenshotStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - screenshotStarted,
          details: {
            key,
            selector,
            screenshotFile
          }
        });
      } catch (error) {
        screenshotFile = undefined;
        receipts.push({
          stage: "screenshot",
          status: "FAIL",
          startedAt: screenshotStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - screenshotStarted,
          details: {
            key,
            selector,
            ...summarizeError(error)
          }
        });
      }

      results.push({
        key,
        selector,
        count,
        status,
        screenshotFile
      });
    }

    await runStage("persist", async () => undefined, {
      reportId,
      resultCount: results.length,
      failedCount: results.filter((result) => result.status === "FAIL").length
    });

    return {
      reportId,
      platform: input.platform,
      startedAt,
      completedAt: new Date().toISOString(),
      results,
      receipts
    };
  }

  return {
    run
  };
}
