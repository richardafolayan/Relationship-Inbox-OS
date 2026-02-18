import type { Locator, Page } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  NormalizedMessage,
  PlatformAdapter,
  SelectorRegistry,
  SendReceipt,
  ThreadStub,
  VerificationMethod
} from "@inbox-os/core";
import {
  cleanText,
  AdapterFailure,
  toStageFailure,
  humanDelay,
  inferAdapterFailureKindFromMessage,
  retryWithBackoff,
  isTransientPageError
} from "./utils.js";
import type { AdapterFailureKind } from "./utils.js";
import type { SessionManager } from "../services/session-manager";
import {
  executeTracedOperation,
  type RunLogger
} from "../services/run-logger.js";

interface LinkedInAdapterDependencies {
  screenshotDir: string;
  domDumpDir: string;
  resolveSelectors: () => Promise<SelectorRegistry>;
  sessionManager: SessionManager;
  personKey?: string;
  scanMaxThreads: number;
  scanStableIterations: number;
  scanScrollWaitMs: number;
  messageBackfillAttempts: number;
}

interface LinkedInThreadSnapshot {
  stableKey: string;
  displayName: string;
  unreadCount: number;
  lastMessagePreview: string;
  lastMessageAt?: string;
  threadUrl?: string;
  avatarUrl?: string;
}

interface LinkedInThreadCollectionIteration {
  rows: LinkedInThreadSnapshot[];
  trailingKey: string | null;
  didScroll: boolean;
  reachedBottom: boolean;
  threadListCount: number;
  threadItemCount: number;
  spinnerCount: number;
}

interface LinkedInMessageSnapshot {
  platformMessageKey: string;
  direction: "IN" | "OUT";
  timestamp: string;
  text: string;
  senderName?: string;
  raw?: Record<string, unknown>;
  attachments: Array<{ type: string; manualReview: boolean; rawLabel?: string }>;
}

interface ActiveThreadDescriptor {
  threadUrl?: string;
  activeKey?: string;
  displayName?: string;
}

interface LinkedInScanRuntimeContext {
  url: string;
  threadListCount: number;
  threadItemCount: number;
  unreadBadgeCount: number;
  unreadPillPresent: boolean;
  unreadPillActive: boolean;
  spinnerCount: number;
  overlayReason?: LinkedInScanFailureReason;
}

interface LinkedInRunCounters {
  unreadViewActive: boolean;
  threadsVisibleCount: number;
  threadsCollectedTotal: number;
  threadsWithUnreadBadgeCount: number;
  candidatesToOpenCount: number;
  openedThreadsCount: number;
  messagesParsedCount: number;
  scrollIterations: number;
  noProgressStreak: number;
  stopReason?: string;
  recoveryAttemptsUsed: number;
  reloadSuppressed: boolean;
}

const linkedInUnreadPillSelector = "button[data-test-messaging-inbox-filters__filter-pill='UNREAD']";
const linkedInLoadingSpinnerSelector = [
  ".artdeco-loader",
  ".artdeco-spinner",
  ".msg-conversations-container__conversations-list-loader",
  ".msg-conversations-container__loading",
  "[aria-label*='Loading']"
].join(", ");

export type LinkedInUnreadRefreshReason =
  | "state_flip"
  | "spinner_cycle"
  | "settle_delay"
  | "already_active"
  | "pill_missing"
  | "click_failed";

export interface LinkedInUnreadFilterActivationResult {
  pillPresent: boolean;
  clicked: boolean;
  waitReason: LinkedInUnreadRefreshReason;
}

export type LinkedInScanFailureReason =
  | "transient_context_destroyed"
  | "element_detached"
  | "evaluate_helper_missing"
  | "evaluate_reference_error"
  | "timeout"
  | "thread_list_not_ready"
  | "page_closed_mid_stage"
  | "login_required"
  | "checkpoint_required"
  | "rate_limited"
  | "linkedin_error_overlay"
  | "manual_refresh_required"
  | "repeated_reload_guard_triggered"
  | "unknown";

export interface LinkedInScanStageReceipt {
  stage: "navigate" | "auth_check" | "unread_filter" | "collect_threads";
  status: "OK" | "FAIL";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export function isRetryableLinkedInCollectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /execution context was destroyed/i.test(message) ||
    /detached/i.test(message) ||
    /navigation.*interrupted/i.test(message) ||
    /timeout/i.test(message)
  );
}

export function resolveLinkedInScanFailureReason(input: {
  message: string;
  url?: string;
  overlayReason?: LinkedInScanFailureReason;
  threadListCount?: number;
  threadItemCount?: number;
  spinnerCount?: number;
}): LinkedInScanFailureReason {
  if (input.overlayReason) {
    return input.overlayReason;
  }

  const message = input.message.toLowerCase();
  const url = (input.url ?? "").toLowerCase();
  if (message.includes("__name is not defined")) {
    return "evaluate_helper_missing";
  }
  if (message.includes("referenceerror")) {
    return "evaluate_reference_error";
  }
  if (message.includes("target page, context or browser has been closed")) {
    return "page_closed_mid_stage";
  }
  if (message.includes("timeouterror") || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("execution context was destroyed")) {
    return "transient_context_destroyed";
  }
  if (message.includes("detached")) {
    return "element_detached";
  }
  if (url.includes("/uas/login") || message.includes("auth required") || message.includes("sign in")) {
    return "login_required";
  }
  if (url.includes("/checkpoint/") || message.includes("checkpoint") || message.includes("verify")) {
    return "checkpoint_required";
  }
  if (message.includes("too many requests") || message.includes("rate limit")) {
    return "rate_limited";
  }
  if (message.includes("something went wrong")) {
    return "linkedin_error_overlay";
  }
  if (message.includes("manual refresh required") || message.includes("refresh linkedin manually")) {
    return "manual_refresh_required";
  }

  if ((input.threadListCount ?? 0) <= 0 || ((input.threadItemCount ?? 0) <= 0 && (input.spinnerCount ?? 0) > 0)) {
    return "thread_list_not_ready";
  }

  return "unknown";
}

export function isLinkedInUnreadPillActive(input: {
  ariaPressed?: string | null;
  ariaChecked?: string | null;
}): boolean {
  const pressed = (input.ariaPressed ?? "").toLowerCase();
  const checked = (input.ariaChecked ?? "").toLowerCase();
  return pressed === "true" || checked === "true";
}

export function shouldClickLinkedInUnreadPill(input: {
  present: boolean;
  ariaPressed?: string | null;
  ariaChecked?: string | null;
}): boolean {
  if (!input.present) {
    return false;
  }
  return !isLinkedInUnreadPillActive({
    ariaPressed: input.ariaPressed,
    ariaChecked: input.ariaChecked
  });
}

export async function waitForLinkedInUnreadRefresh(input: {
  waitForStateFlip: () => Promise<boolean>;
  waitForSpinnerCycle: () => Promise<boolean>;
  waitForTimeout: (ms: number) => Promise<void>;
  settleDelayMs?: number;
}): Promise<LinkedInUnreadRefreshReason> {
  if (await input.waitForStateFlip()) {
    return "state_flip";
  }

  if (await input.waitForSpinnerCycle()) {
    return "spinner_cycle";
  }

  const settleDelayMs = Math.max(250, Math.min(500, input.settleDelayMs ?? 350));
  await input.waitForTimeout(settleDelayMs);
  return "settle_delay";
}

export async function activateLinkedInUnreadFilter(page: Page): Promise<LinkedInUnreadFilterActivationResult> {
  return activateLinkedInUnreadFilterWithHooks(page);
}

async function activateLinkedInUnreadFilterWithHooks(
  page: Page,
  hooks?: {
    clickUnreadPill?: () => Promise<boolean>;
    waitForTimeout?: (ms: number) => Promise<void>;
  }
): Promise<LinkedInUnreadFilterActivationResult> {
  async function readPillState(): Promise<{
    present: boolean;
    active: boolean;
  }> {
    const unreadPill = page.locator(linkedInUnreadPillSelector).first();
    const pillCount = await unreadPill.count().catch(() => 0);
    if (pillCount === 0) {
      return { present: false, active: false };
    }

    const ariaPressed = await unreadPill.getAttribute("aria-pressed").catch(() => null);
    const ariaChecked = await unreadPill.getAttribute("aria-checked").catch(() => null);
    return {
      present: true,
      active: isLinkedInUnreadPillActive({
        ariaPressed,
        ariaChecked
      })
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const initialState = await readPillState();
    if (!initialState.present) {
      return {
        pillPresent: false,
        clicked: false,
        waitReason: "pill_missing"
      };
    }
    if (initialState.active) {
      return {
        pillPresent: true,
        clicked: false,
        waitReason: "already_active"
      };
    }

    const clicked = hooks?.clickUnreadPill
      ? await hooks.clickUnreadPill()
      : await page
          .locator(linkedInUnreadPillSelector)
          .first()
          .click({ timeout: 5000 })
          .then(() => true)
          .catch(() => false);
    if (!clicked) {
      continue;
    }

    const waitReason = await waitForLinkedInUnreadRefresh({
      waitForStateFlip: async () => {
        const deadline = Date.now() + 2_200;
        while (Date.now() < deadline) {
          const state = await readPillState();
          if (state.active) {
            return true;
          }
          await page.waitForTimeout(120);
        }
        return false;
      },
      waitForSpinnerCycle: async () => {
        const spinner = page.locator(linkedInLoadingSpinnerSelector);
        const appearDeadline = Date.now() + 1_600;
        let sawSpinner = false;

        while (Date.now() < appearDeadline) {
          const count = await spinner.count().catch(() => 0);
          if (count > 0) {
            sawSpinner = true;
            break;
          }
          if (hooks?.waitForTimeout) {
            await hooks.waitForTimeout(100);
          } else {
            await page.waitForTimeout(100);
          }
        }

        if (!sawSpinner) {
          return false;
        }

        const disappearDeadline = Date.now() + 2_200;
        while (Date.now() < disappearDeadline) {
          const count = await spinner.count().catch(() => 0);
          if (count === 0) {
            return true;
          }
          if (hooks?.waitForTimeout) {
            await hooks.waitForTimeout(100);
          } else {
            await page.waitForTimeout(100);
          }
        }

        return false;
      },
      waitForTimeout: (ms) => (hooks?.waitForTimeout ? hooks.waitForTimeout(ms) : page.waitForTimeout(ms))
    });

    const finalState = await readPillState();
    if (finalState.active || waitReason === "spinner_cycle") {
      return {
        pillPresent: true,
        clicked: true,
        waitReason
      };
    }
  }

  return {
    pillPresent: true,
    clicked: false,
    waitReason: "click_failed"
  };
}

export type LinkedInCollectionStopReason =
  | "max_threads"
  | "end_of_list_no_progress"
  | "end_of_list_reached"
  | "max_iterations"
  | "max_duration"
  | "zero_threads_found";

export function updateLinkedInCollectionStability(input: {
  previousCount: number;
  nextCount: number;
  previousTrailingKey: string | null;
  nextTrailingKey: string | null;
  noGrowthIterations: number;
  trailingRepeatIterations: number;
}): { noGrowthIterations: number; trailingRepeatIterations: number } {
  const grew = input.nextCount > input.previousCount;
  const noGrowthIterations = grew ? 0 : input.noGrowthIterations + 1;

  const trailingRepeatIterations =
    input.nextTrailingKey && input.previousTrailingKey === input.nextTrailingKey
      ? input.trailingRepeatIterations + 1
      : 0;

  return {
    noGrowthIterations,
    trailingRepeatIterations
  };
}

export function shouldStopLinkedInCollection(input: {
  uniqueCount: number;
  maxThreads: number;
  noGrowthIterations: number;
  trailingRepeatIterations: number;
  stableIterations: number;
  didScroll: boolean;
  reachedBottom: boolean;
}): boolean {
  if (input.uniqueCount >= input.maxThreads) {
    return true;
  }
  if (input.noGrowthIterations >= input.stableIterations) {
    return true;
  }
  if (input.trailingRepeatIterations >= input.stableIterations) {
    return true;
  }
  if (!input.didScroll && input.reachedBottom) {
    return true;
  }
  return false;
}

export function resolveLinkedInCollectionStopReason(input: {
  uniqueCount: number;
  maxThreads: number;
  noGrowthIterations: number;
  trailingRepeatIterations: number;
  stableIterations: number;
  didScroll: boolean;
  reachedBottom: boolean;
}): LinkedInCollectionStopReason | null {
  if (input.uniqueCount >= input.maxThreads) {
    return "max_threads";
  }
  if (input.noGrowthIterations >= input.stableIterations) {
    return "end_of_list_no_progress";
  }
  if (input.trailingRepeatIterations >= input.stableIterations) {
    return "end_of_list_reached";
  }
  if (!input.didScroll && input.reachedBottom) {
    return "end_of_list_reached";
  }
  return null;
}

export function buildLinkedInPreviewMap(
  threads: Array<Pick<ThreadStub, "platformThreadId" | "lastMessagePreview">>
): Map<string, string> {
  const previewByThread = new Map<string, string>();
  for (const thread of threads) {
    previewByThread.set(thread.platformThreadId, cleanText(thread.lastMessagePreview ?? ""));
  }
  return previewByThread;
}

export class LinkedInAdapter implements PlatformAdapter {
  platform = "LINKEDIN" as const;
  private lastCollectionMetrics: {
    totalFound: number;
    unreadFound: number;
    iterations: number;
    stopReason: LinkedInCollectionStopReason;
  } | null = null;

  private static readonly inboxNavigationTimeoutMs = 10_000;
  private static readonly inboxReadyTimeoutMs = 10_000;
  private runLogger: RunLogger | null = null;
  private activeStage: string | null = null;
  private readonly pageTraceIds = new WeakMap<Page, string>();
  private pageTraceSequence = 0;

  constructor(private readonly deps: LinkedInAdapterDependencies) {}

  setRunLogger(logger: RunLogger | null): void {
    this.runLogger = logger;
  }

  private resolveActiveStage(stage?: string | null): string | null {
    return stage ?? this.activeStage;
  }

  private getPageTraceId(page: Page): string {
    const existing = this.pageTraceIds.get(page);
    if (existing) {
      return existing;
    }
    this.pageTraceSequence += 1;
    const created = `linkedin-page-${this.pageTraceSequence}`;
    this.pageTraceIds.set(page, created);
    return created;
  }

  private logTraceEvent(input: {
    level?: "debug" | "info" | "warn" | "error";
    action: string;
    stage?: string | null;
    details?: Record<string, unknown>;
    url?: string;
    page?: Page;
    attempt?: number;
    elapsedMs?: number;
  }): void {
    if (!this.runLogger?.enabled) {
      return;
    }
    this.runLogger.logEvent({
      level: input.level ?? "info",
      component: "linkedin-adapter",
      stage: this.resolveActiveStage(input.stage),
      action: input.action,
      details: input.details ?? {},
      url: input.url,
      pageId: input.page ? this.getPageTraceId(input.page) : undefined,
      attempt: input.attempt,
      elapsedMs: input.elapsedMs
    });
  }

  private logTraceDecision(input: {
    decision: string;
    details?: Record<string, unknown>;
    stage?: string | null;
    level?: "debug" | "info" | "warn" | "error";
    attempt?: number;
  }): void {
    if (!this.runLogger?.enabled) {
      return;
    }
    this.runLogger.logDecision({
      stage: this.resolveActiveStage(input.stage),
      decision: input.decision,
      details: input.details,
      level: input.level,
      attempt: input.attempt
    });
  }

  private async runTracedPageAction<T>(input: {
    page: Page;
    action: string;
    stage?: string | null;
    selector?: string;
    url?: string;
    note?: string;
    attempt?: number;
    details?: Record<string, unknown>;
    counts?: Record<string, unknown>;
    run: () => Promise<T>;
  }): Promise<T> {
    if (!this.runLogger?.enabled) {
      return input.run();
    }

    return executeTracedOperation({
      logger: this.runLogger,
      component: "linkedin-adapter",
      stage: this.resolveActiveStage(input.stage),
      action: input.action,
      selector: input.selector,
      url: input.url,
      note: input.note,
      counts: input.counts,
      attempt: input.attempt,
      details: {
        pageId: this.getPageTraceId(input.page),
        ...(input.details ?? {})
      },
      run: input.run
    });
  }

  private async tracedClick(
    page: Page,
    selector: string,
    input?: {
      stage?: string | null;
      timeoutMs?: number;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "click",
      selector,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => {
        await page.locator(selector).first().click({
          timeout: input?.timeoutMs
        });
      }
    });
  }

  private async tracedWaitForVisible(
    page: Page,
    selector: string,
    timeoutMs: number,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "wait_for_visible",
      selector,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => {
        await page.waitForSelector(selector, {
          state: "visible",
          timeout: timeoutMs
        });
      }
    });
  }

  private async tracedLocatorCount(
    page: Page,
    selector: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<number> {
    return this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "locator_count",
      selector,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => page.locator(selector).count()
    });
  }

  private async tracedScrollContainer(
    page: Page,
    containerSelector: string,
    delta: number,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "scroll_container",
      selector: containerSelector,
      note: input?.note,
      attempt: input?.attempt,
      details: {
        delta
      },
      run: async () => {
        const target = page.locator(containerSelector).first();
        await target.hover({ force: true }).catch(() => undefined);
        await page.mouse.wheel(0, delta);
      }
    });
  }

  private async tracedScreenshot(
    page: Page,
    filePath: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "screenshot",
      note: input?.note,
      attempt: input?.attempt,
      details: {
        filePath
      },
      run: async () => {
        await page.screenshot({
          path: filePath,
          fullPage: true
        });
      }
    });
  }

  private async tracedDomDump(
    page: Page,
    filePath: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "dom_dump",
      note: input?.note,
      attempt: input?.attempt,
      details: {
        filePath
      },
      run: async () => {
        const html = await page.content();
        await writeFile(filePath, html, "utf8");
      }
    });
  }

  private async tracedGoto(
    page: Page,
    url: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
      timeoutMs?: number;
      waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "goto",
      url,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => {
        await page.goto(url, {
          waitUntil: input?.waitUntil ?? "domcontentloaded",
          timeout: input?.timeoutMs
        });
      }
    });
  }

  private async tracedReload(
    page: Page,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
      timeoutMs?: number;
      waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "reload",
      note: input?.note,
      attempt: input?.attempt,
      url: page.url(),
      run: async () => {
        await page.reload({
          waitUntil: input?.waitUntil ?? "domcontentloaded",
          timeout: input?.timeoutMs
        });
      }
    });
  }

  private async startRunTracing(page: Page): Promise<() => Promise<void>> {
    const cleanup: Array<() => void> = [];
    let tracingStarted = false;

    if (this.runLogger?.enabled) {
      const pageId = this.getPageTraceId(page);
      const onConsole = (msg: any): void => {
        this.logTraceEvent({
          level: "debug",
          stage: "browser_events",
          action: "browser_console",
          details: {
            type: msg.type(),
            text: msg.text()
          },
          page
        });
      };
      const onPageError = (error: any): void => {
        this.logTraceEvent({
          level: "error",
          stage: "browser_events",
          action: "pageerror",
          details: {
            message: error.message,
            stack: error.stack
          },
          page
        });
      };
      const onRequestFailed = (request: any): void => {
        this.logTraceEvent({
          level: "warn",
          stage: "browser_events",
          action: "requestfailed",
          details: {
            url: request.url(),
            method: request.method(),
            failure: request.failure()?.errorText ?? "unknown"
          },
          url: request.url(),
          page
        });
      };
      const onResponse = (response: any): void => {
        const status = response.status();
        if (status < 400) {
          return;
        }
        this.logTraceEvent({
          level: "warn",
          stage: "browser_events",
          action: "http_error",
          details: {
            url: response.url(),
            status
          },
          url: response.url(),
          page
        });
      };
      const onFrameNavigated = (frame: any): void => {
        if (frame !== page.mainFrame()) {
          return;
        }
        this.logTraceEvent({
          level: "info",
          stage: "browser_events",
          action: "navigated",
          details: {
            url: frame.url(),
            pageId
          },
          url: frame.url(),
          page
        });
      };
      const onClose = (): void => {
        this.logTraceEvent({
          level: "warn",
          stage: "browser_events",
          action: "page_closed",
          details: {
            pageId
          }
        });
      };

      page.on("console", onConsole);
      page.on("pageerror", onPageError);
      page.on("requestfailed", onRequestFailed);
      page.on("response", onResponse);
      page.on("framenavigated", onFrameNavigated);
      page.on("close", onClose);
      cleanup.push(() => page.off("console", onConsole));
      cleanup.push(() => page.off("pageerror", onPageError));
      cleanup.push(() => page.off("requestfailed", onRequestFailed));
      cleanup.push(() => page.off("response", onResponse));
      cleanup.push(() => page.off("framenavigated", onFrameNavigated));
      cleanup.push(() => page.off("close", onClose));

      try {
        await page.context().tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true
        });
        tracingStarted = true;
        this.logTraceEvent({
          level: "info",
          stage: "browser_events",
          action: "playwright_trace_started",
          details: {
            pageId
          },
          page
        });
      } catch (error) {
        this.runLogger.logError({
          component: "linkedin-adapter",
          stage: this.resolveActiveStage("browser_events"),
          action: "playwright_trace_start_failed",
          error
        });
      }
    }

    return async () => {
      for (const dispose of cleanup) {
        dispose();
      }
      if (!this.runLogger?.enabled || !tracingStarted || !this.runLogger.runDir) {
        return;
      }

      const tracePath = join(this.runLogger.runDir, "playwright-trace.zip");
      try {
        await page.context().tracing.stop({
          path: tracePath
        });
        this.runLogger.attachArtifact({
          playwrightTracePath: tracePath
        });
        this.logTraceEvent({
          stage: "browser_events",
          action: "playwright_trace_saved",
          details: {
            tracePath
          },
          page
        });
      } catch (error) {
        this.runLogger.logError({
          component: "linkedin-adapter",
          stage: this.resolveActiveStage("browser_events"),
          action: "playwright_trace_stop_failed",
          error
        });
      }
    };
  }

  private async captureRunFailureArtifacts(page: Page): Promise<void> {
    if (!this.runLogger?.enabled || !this.runLogger.runDir || page.isClosed()) {
      return;
    }
    const failureScreenshotPath = join(this.runLogger.runDir, "failure.png");
    const failureDomPath = join(this.runLogger.runDir, "dom.html");

    try {
      await this.tracedScreenshot(page, failureScreenshotPath, {
        stage: this.resolveActiveStage("failure_artifacts"),
        note: "failure_capture"
      });
      this.runLogger.attachArtifact({
        failureScreenshotPath
      });
    } catch {
      // best effort only
    }

    try {
      await this.tracedDomDump(page, failureDomPath, {
        stage: this.resolveActiveStage("failure_artifacts"),
        note: "failure_capture"
      });
      this.runLogger.attachArtifact({
        failureDomDumpPath: failureDomPath
      });
    } catch {
      // best effort only
    }
  }

  private async runWithPlatformLease<T>(work: () => Promise<T>): Promise<T> {
    const manager = this.deps.sessionManager as SessionManager & {
      withPlatformLease?: (input: { platform: "LINKEDIN"; personKey?: string }, work: () => Promise<T>) => Promise<T>;
    };
    if (typeof manager.withPlatformLease !== "function") {
      return work();
    }
    return manager.withPlatformLease({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default"
    }, work);
  }

  private async getPage(): Promise<Page> {
    return this.deps.sessionManager.getManagedPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default",
      args: ["--disable-blink-features=AutomationControlled"],
      runLogger: this.runLogger ?? undefined
    });
  }

  private async navigateInbox(selectors: SelectorRegistry): Promise<Page> {
    const navigate = async (target: Page): Promise<void> => {
      await target.bringToFront();
      await this.tracedGoto(target, selectors.inbox_url, {
        stage: "navigate",
        note: "navigate_inbox",
        waitUntil: "commit",
        timeoutMs: LinkedInAdapter.inboxNavigationTimeoutMs
      });
      await this.runTracedPageAction({
        page: target,
        stage: "navigate",
        action: "wait_for_domcontentloaded",
        note: "post_goto_domcontentloaded",
        run: async () => {
          await target.waitForLoadState("domcontentloaded", {
            timeout: 4_000
          }).catch(() => undefined);
        }
      });
      await this.runTracedPageAction({
        page: target,
        stage: "navigate",
        action: "wait_for_timeout",
        note: "post_navigation_settle",
        details: {
          delayMs: 350
        },
        run: async () => {
          await target.waitForTimeout(350);
        }
      });
    };

    const page = await retryWithBackoff({
      attempts: 2,
      baseDelayMs: 300,
      isRetryable: (error) => isTransientPageError(error),
      run: async () => {
        const target = await this.getPage();
        await navigate(target);
        return target;
      }
    });

    return page;
  }

  private classifyFailureKind(reason: string, fallback: AdapterFailureKind): AdapterFailureKind {
    return inferAdapterFailureKindFromMessage(reason) ?? fallback;
  }

  private normalizeTimestamp(rawValue: string | undefined, fallbackIso: string): string {
    if (!rawValue) {
      return fallbackIso;
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
      return fallbackIso;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }

    return fallbackIso;
  }

  private normalizeIdentity(value: string | undefined): string {
    return cleanText(value ?? "").toLowerCase();
  }

  private normalizeThreadUrl(value: string | undefined): string {
    if (!value) {
      return "";
    }
    try {
      const parsed = new URL(value);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return value.replace(/[?#].*$/, "").replace(/\/+$/, "").trim();
    }
  }

  private resolveThreadUrlToken(value: string | undefined): string {
    const normalized = this.normalizeThreadUrl(value);
    if (!normalized) {
      return "";
    }

    const threadMatch = normalized.match(/\/messaging\/thread\/([^/]+)/i);
    if (threadMatch?.[1]) {
      return threadMatch[1].toLowerCase();
    }

    const conversationMatch = normalized.match(/conversationid=([^&]+)/i);
    if (conversationMatch?.[1]) {
      return conversationMatch[1].toLowerCase();
    }

    return normalized.toLowerCase();
  }

  private async detectAuthRequired(
    page: Page
  ): Promise<{ authRequired: boolean; url: string; source?: "url" | "dom" }> {
    const url = page.url();
    if (/\/uas\/login/i.test(url)) {
      return { authRequired: true, url, source: "url" };
    }

    const hasUsername = (await page.locator("#username").count().catch(() => 0)) > 0;
    const hasPassword = (await page.locator("#password").count().catch(() => 0)) > 0;
    const hasLoginForm =
      (await page.locator("form[action*='login-submit']").count().catch(() => 0)) > 0 ||
      (await page.locator("form[data-id='sign-in-form']").count().catch(() => 0)) > 0 ||
      (await page.locator("[data-id='sign-in-form']").count().catch(() => 0)) > 0;
    const hasLoginDom = hasUsername || hasPassword || hasLoginForm;

    return {
      authRequired: hasLoginDom,
      url,
      source: hasLoginDom ? "dom" : undefined
    };
  }

  private async throwIfAuthRequired(page: Page, context: string): Promise<void> {
    const authState = await this.detectAuthRequired(page);
    if (!authState.authRequired) {
      return;
    }

    throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
      kind: "AUTH_REQUIRED",
      platform: this.platform,
      stage: "navigate",
      details: {
        context,
        url: authState.url,
        detection: authState.source ?? "unknown"
      }
    });
  }

  private summarizeError(error: unknown): Record<string, unknown> {
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

  private async detectLinkedInOverlayReason(page: Page): Promise<LinkedInScanFailureReason | undefined> {
    const url = page.url().toLowerCase();
    if (/\/uas\/login/i.test(url)) {
      return "login_required";
    }
    if (/\/checkpoint\//i.test(url)) {
      return "checkpoint_required";
    }

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (bodyText.includes("verify your identity") || bodyText.includes("checkpoint")) {
      return "checkpoint_required";
    }
    if (bodyText.includes("too many requests") || bodyText.includes("try again later")) {
      return "rate_limited";
    }
    if (bodyText.includes("something went wrong")) {
      return "linkedin_error_overlay";
    }
    if (bodyText.includes("sign in") && (bodyText.includes("join now") || bodyText.includes("forgot password"))) {
      return "login_required";
    }

    return undefined;
  }

  private async captureUnreadScanRuntimeContext(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<LinkedInScanRuntimeContext> {
    const unreadPill = page.locator(linkedInUnreadPillSelector).first();
    const unreadPillPresent = (await unreadPill.count().catch(() => 0)) > 0;
    const unreadPillActive = unreadPillPresent
      ? isLinkedInUnreadPillActive({
          ariaPressed: await unreadPill.getAttribute("aria-pressed").catch(() => null),
          ariaChecked: await unreadPill.getAttribute("aria-checked").catch(() => null)
        })
      : false;

    const overlayReason = await this.detectLinkedInOverlayReason(page);

    return {
      url: page.url(),
      threadListCount: await page.locator(selectors.thread_list).count().catch(() => 0),
      threadItemCount: await page.locator(selectors.thread_item).count().catch(() => 0),
      unreadBadgeCount: await page.locator(selectors.unread_badge).count().catch(() => 0),
      unreadPillPresent,
      unreadPillActive,
      spinnerCount: await page.locator(linkedInLoadingSpinnerSelector).count().catch(() => 0),
      overlayReason
    };
  }

  private async waitForUnreadListSettle(page: Page, selectors: SelectorRegistry): Promise<void> {
    const deadline = Date.now() + 4_000;
    let stableIterations = 0;
    let previousFingerprint = "";
    while (Date.now() < deadline) {
      const threadItemCount = await this.tracedLocatorCount(page, selectors.thread_item, {
        stage: "unread_filter",
        note: "settle_thread_count"
      }).catch(() => 0);
      const unreadBadgeCount = await this.tracedLocatorCount(page, selectors.unread_badge, {
        stage: "unread_filter",
        note: "settle_unread_badge_count"
      }).catch(() => 0);
      const spinnerCount = await this.tracedLocatorCount(page, linkedInLoadingSpinnerSelector, {
        stage: "unread_filter",
        note: "settle_spinner_count"
      }).catch(() => 0);
      const firstRow = page.locator(selectors.thread_item).first();
      const firstRowText =
        (await firstRow.count().catch(() => 0)) > 0
          ? ((await firstRow.textContent({ timeout: 0 }).catch(() => null)) ?? "")
          : "";
      const fingerprint = `${threadItemCount}|${unreadBadgeCount}|${spinnerCount}|${firstRowText.slice(0, 80)}`;

      if (threadItemCount > 0 || unreadBadgeCount > 0) {
        return;
      }

      if (spinnerCount > 0) {
        stableIterations = 0;
      } else if (fingerprint === previousFingerprint) {
        stableIterations += 1;
        if (stableIterations >= 3) {
          return;
        }
      } else {
        stableIterations = 0;
      }

      previousFingerprint = fingerprint;
      await this.runTracedPageAction({
        page,
        stage: "unread_filter",
        action: "wait_for_timeout",
        note: "settle_poll_wait",
        details: {
          delayMs: 140
        },
        run: async () => {
          await page.waitForTimeout(140);
        }
      });
    }
  }

  async ensureUnreadFilterActive(page: Page, selectors: SelectorRegistry): Promise<LinkedInUnreadFilterActivationResult> {
    const result = await activateLinkedInUnreadFilterWithHooks(page, {
      clickUnreadPill: async () => {
        return this.tracedClick(page, linkedInUnreadPillSelector, {
          stage: "unread_filter",
          timeoutMs: 5_000,
          note: "activate_unread_pill"
        })
          .then(() => true)
          .catch(() => false);
      },
      waitForTimeout: async (ms: number) => {
        await this.runTracedPageAction({
          page,
          stage: "unread_filter",
          action: "wait_for_timeout",
          note: "unread_filter_refresh_wait",
          details: {
            delayMs: ms
          },
          run: async () => {
            await page.waitForTimeout(ms);
          }
        });
      }
    });
    this.logTraceDecision({
      stage: "unread_filter",
      decision: "Unread filter activation result",
      details: { ...result }
    });
    await this.waitForUnreadListSettle(page, selectors);
    return result;
  }

  async waitForThreadListReadyOrClassified(
    page: Page,
    selectors: SelectorRegistry,
    timeoutMs = 8_000
  ): Promise<{ ready: boolean; empty: boolean; reason?: LinkedInScanFailureReason | LinkedInCollectionStopReason }> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error("Target page, context or browser has been closed");
      }

      const overlayReason = await this.detectLinkedInOverlayReason(page);
      if (overlayReason) {
        return {
          ready: false,
          empty: false,
          reason: overlayReason
        };
      }

      const listLocator = page.locator(selectors.thread_list).first();
      const listVisible = await listLocator.isVisible({ timeout: 0 }).catch(() => false);
      const threadCount = await this.tracedLocatorCount(page, selectors.thread_item, {
        stage: "collect_threads",
        note: "read_thread_item_count"
      }).catch(() => 0);
      if (listVisible || threadCount > 0) {
        return {
          ready: true,
          empty: false
        };
      }

      const emptyStateCount = await this.tracedLocatorCount(
        page,
        ".msg-conversations-container__no-results, .msg-conversations-container__empty-state, .msg-conversations-container__empty-convos, [data-test-empty-state]",
        {
          stage: "collect_threads",
          note: "read_empty_state_count"
        }
      ).catch(() => 0);
      if (emptyStateCount > 0) {
        return {
          ready: true,
          empty: true,
          reason: "zero_threads_found"
        };
      }

      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "wait_for_timeout",
        note: "thread_list_poll_wait",
        details: {
          delayMs: 140
        },
        run: async () => {
          await page.waitForTimeout(140);
        }
      });
    }

    throw new Error("Timed out waiting for LinkedIn thread list container to become ready.");
  }

  async collectThreadCandidates(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{
    rows: LinkedInThreadSnapshot[];
    trailingKey: string | null;
    threadListCount: number;
    threadItemCount: number;
    spinnerCount: number;
    visibleSetHash: string;
    bottomKey: string | null;
  }> {
    const threadListLocator = page.locator(selectors.thread_list).first();
    const threadListCount = await threadListLocator.count().catch(() => 0);
    const rowRoots = page.locator(".msg-conversation-listitem");
    const selectorItemCount = await rowRoots.count().catch(() => 0);
    const rows: LinkedInThreadSnapshot[] = [];

    const readText = async (locator: Locator): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.innerText({ timeout: 0 }).catch(() => null);
    };
    const readAttr = async (locator: Locator, name: string): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.getAttribute(name, { timeout: 0 }).catch(() => null);
    };

    for (let index = 0; index < selectorItemCount; index += 1) {
      const scope = rowRoots.nth(index);
      const clickTarget = scope.locator(".msg-conversation-listitem__link").first();
      const clickTargetExists = (await clickTarget.count().catch(() => 0)) > 0;
      const linkContainer = clickTargetExists ? clickTarget : scope;

      const hrefRaw =
        (await readAttr(linkContainer, "href")) ??
        (await readAttr(linkContainer.locator("a[href*='/messaging/']"), "href")) ??
        "";
      let href = hrefRaw.trim();
      if (href) {
        try {
          href = new URL(href, page.url()).toString();
        } catch {
          href = href.trim();
        }
      }

      const displayName = cleanText(
        (await readText(scope.locator(".msg-conversation-listitem__participant-names span.truncate"))) ??
          (await readText(scope.locator(".msg-conversation-listitem__participant-names"))) ??
          (await readText(scope.locator("h3 span.truncate"))) ??
          (await readText(scope.locator("h3"))) ??
          ""
      );
      const preview = cleanText(
        (await readText(scope.locator(".msg-conversation-card__message-snippet"))) ??
          (await readText(scope.locator("p.msg-conversation-card__message-snippet"))) ??
          ""
      ).slice(0, 220);
      const lastMessageAt = cleanText(
        (await readText(scope.locator("time.msg-conversation-listitem__time-stamp"))) ??
          (await readText(scope.locator("time"))) ??
          ""
      );

      const unreadContainer = scope.locator(".msg-conversation-card__unread-count").first();
      const unreadContainerExists = (await unreadContainer.count().catch(() => 0)) > 0;
      const unreadText = cleanText(
        (await readText(unreadContainer.locator(".notification-badge__count"))) ??
          (await readText(unreadContainer)) ??
          ""
      );
      const unreadMatch = unreadText.match(/\d+/);
      const unreadCount = unreadMatch ? Number(unreadMatch[0]) : unreadContainerExists ? 1 : 0;

      const urnToken =
        (await readAttr(scope, "data-conversation-urn")) ??
        (await readAttr(scope, "data-urn")) ??
        (await readAttr(scope, "data-event-urn")) ??
        (await readAttr(scope, "data-conversation-id")) ??
        (await readAttr(scope, "data-id")) ??
        (await readAttr(scope, "id")) ??
        "";
      const hrefToken = this.resolveThreadUrlToken(href);
      const fallbackKey = `linkedin-fallback:${displayName.toLowerCase()}|${preview.toLowerCase()}|${unreadCount}`;
      const stableKey =
        (hrefToken && `linkedin-href:${hrefToken}`) ||
        (urnToken && `linkedin-urn:${urnToken.toLowerCase()}`) ||
        fallbackKey;
      const avatarUrl = (await readAttr(scope.locator("img"), "src")) ?? undefined;

      rows.push({
        stableKey,
        displayName: displayName || `LinkedIn Thread ${index + 1}`,
        unreadCount,
        lastMessagePreview: preview,
        lastMessageAt: lastMessageAt || undefined,
        threadUrl: href || undefined,
        avatarUrl
      });
    }

    const visibleSetHash = rows.map((row) => row.stableKey).join("|");
    const bottomKey = rows.at(-1)?.stableKey ?? null;
    return {
      rows,
      trailingKey: bottomKey,
      threadListCount,
      threadItemCount: selectorItemCount,
      spinnerCount: await page.locator(linkedInLoadingSpinnerSelector).count().catch(() => 0),
      visibleSetHash,
      bottomKey
    };
  }

  async captureThreadRowsSnapshot(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{
    rows: LinkedInThreadSnapshot[];
    trailingKey: string | null;
    threadListCount: number;
    threadItemCount: number;
    spinnerCount: number;
    visibleSetHash: string;
    bottomKey: string | null;
  }> {
    return this.collectThreadCandidates(page, selectors);
  }

  async deepScrollThreadList(
    page: Page,
    selectors: SelectorRegistry,
    state: { bottomKey: string | null; visibleSetHash: string }
  ): Promise<{ didScroll: boolean; reachedBottom: boolean; moved: boolean }> {
    const listTarget = page.locator(selectors.thread_list).first();
    const listTargetCount = await listTarget.count().catch(() => 0);
    if (listTargetCount <= 0) {
      return { didScroll: false, reachedBottom: true, moved: false };
    }

    const rowRoots = page.locator(".msg-conversation-listitem");
    const beforeCount = await rowRoots.count().catch(() => 0);
    if (beforeCount > 0) {
      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "scroll_into_view",
        note: "row_tail_scroll",
        run: async () => {
          await rowRoots
            .nth(beforeCount - 1)
            .scrollIntoViewIfNeeded()
            .catch(() => undefined);
        }
      });
    } else {
      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "scroll_into_view",
        selector: selectors.thread_list,
        note: "container_scroll",
        run: async () => {
          await listTarget.scrollIntoViewIfNeeded().catch(() => undefined);
        }
      });
    }

    await this.tracedScrollContainer(page, selectors.thread_list, 840, {
      stage: "collect_threads",
      note: "primary_scroll"
    });
    await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "wait_for_timeout",
      note: "after_primary_scroll",
      details: {
        delayMs: Math.max(80, this.deps.scanScrollWaitMs)
      },
      run: async () => {
        await page.waitForTimeout(Math.max(80, this.deps.scanScrollWaitMs));
      }
    });

    let after = await this.collectThreadCandidates(page, selectors).catch(() => null);
    let moved = Boolean(after && after.bottomKey && after.bottomKey !== state.bottomKey);
    if (!moved) {
      await this.tracedScrollContainer(page, selectors.thread_list, 840, {
        stage: "collect_threads",
        note: "secondary_scroll"
      });
      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "wait_for_timeout",
        note: "after_secondary_scroll",
        details: {
          delayMs: Math.max(80, this.deps.scanScrollWaitMs)
        },
        run: async () => {
          await page.waitForTimeout(Math.max(80, this.deps.scanScrollWaitMs));
        }
      });
      after = await this.collectThreadCandidates(page, selectors).catch(() => null);
      moved = Boolean(after && after.bottomKey && after.bottomKey !== state.bottomKey);
    }

    return {
      didScroll: true,
      reachedBottom: !moved,
      moved
    };
  }

  async collectThreadRowsWithScroll(
    page: Page,
    selectors: SelectorRegistry,
    maxThreads: number
  ): Promise<{
    rows: ThreadStub[];
    iterations: number;
    stopReason: LinkedInCollectionStopReason;
    noProgressStreak: number;
    bottomRepeatStreak: number;
    scrollNoMoveStreak: number;
    scrollIterations: number;
  }> {
    const readiness = await this.waitForThreadListReadyOrClassified(page, selectors, 8_000);
    if (!readiness.ready) {
      if (readiness.reason === "login_required" || readiness.reason === "checkpoint_required") {
        throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
          kind: "AUTH_REQUIRED",
          stage: "collect_threads",
          platform: this.platform,
          details: {
            reason: readiness.reason,
            url: page.url()
          }
        });
      }
      if (readiness.reason === "rate_limited" || readiness.reason === "linkedin_error_overlay") {
        throw new AdapterFailure("LinkedIn unread thread list is blocked by an overlay.", {
          kind: "SELECTOR_MISMATCH",
          stage: "collect_threads",
          platform: this.platform,
          details: {
            reason: readiness.reason,
            url: page.url()
          }
        });
      }
      throw new Error("LinkedIn thread list is not ready for unread collection.");
    }

    if (readiness.empty) {
      return {
        rows: [],
        iterations: 0,
        stopReason: "zero_threads_found",
        noProgressStreak: 0,
        bottomRepeatStreak: 0,
        scrollNoMoveStreak: 0,
        scrollIterations: 0
      };
    }

    const cappedMaxThreads = Math.max(1, maxThreads);
    const stableIterationsTarget = Math.max(1, this.deps.scanStableIterations);
    const maxIterations = Math.max(20, Math.min(60, this.deps.scanMaxThreads * 3));
    const maxDurationMs = 45_000;
    const merged = new Map<string, ThreadStub>();
    const startedAt = Date.now();
    let scrollIterations = 0;

    let iterations = 0;
    let loadingWindowIterations = 0;
    let missingListIterations = 0;
    let noProgressStreak = 0;
    let bottomRepeatStreak = 0;
    let scrollNoMoveStreak = 0;
    let previousBottomKey: string | null = null;
    let stopReason: LinkedInCollectionStopReason = "max_iterations";

    this.logTraceEvent({
      stage: "collect_threads",
      action: "collection_start",
      details: {
        maxThreads: cappedMaxThreads,
        stableIterationsTarget,
        maxIterations,
        maxDurationMs
      },
      page
    });

    while (iterations < maxIterations) {
      if (Date.now() - startedAt >= maxDurationMs) {
        stopReason = "max_duration";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to max duration",
          details: {
            maxDurationMs,
            elapsedMs: Date.now() - startedAt
          },
          level: "warn"
        });
        break;
      }

      iterations += 1;
      const snapshot = await retryWithBackoff({
        attempts: 3,
        baseDelayMs: 250,
        isRetryable: (error) => isRetryableLinkedInCollectError(error),
        run: async () => this.captureThreadRowsSnapshot(page, selectors)
      });
      this.logTraceEvent({
        stage: "collect_threads",
        action: "collection_iteration_snapshot",
        details: {
          iteration: iterations,
          threadListCount: snapshot.threadListCount,
          threadItemCount: snapshot.threadItemCount,
          spinnerCount: snapshot.spinnerCount,
          visibleCount: snapshot.rows.length
        },
        attempt: iterations,
        page
      });

      if (snapshot.threadItemCount === 0 && snapshot.spinnerCount > 0) {
        loadingWindowIterations += 1;
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Thread list still loading after unread filter",
          details: {
            loadingWindowIterations,
            spinnerCount: snapshot.spinnerCount
          },
          attempt: iterations
        });
        if (loadingWindowIterations >= 12) {
          throw new Error("LinkedIn thread list is still loading after unread filter activation.");
        }
        await this.runTracedPageAction({
          page,
          stage: "collect_threads",
          action: "wait_for_timeout",
          note: "loading_window_wait",
          details: {
            delayMs: this.deps.scanScrollWaitMs
          },
          attempt: iterations,
          run: async () => {
            await page.waitForTimeout(this.deps.scanScrollWaitMs);
          }
        });
        continue;
      }

      loadingWindowIterations = 0;
      if (snapshot.threadListCount <= 0) {
        missingListIterations += 1;
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Thread list container missing during collection",
          details: {
            missingListIterations
          },
          attempt: iterations
        });
        if (missingListIterations >= 6) {
          throw new Error("LinkedIn thread list container is missing while collecting unread threads.");
        }
        await this.runTracedPageAction({
          page,
          stage: "collect_threads",
          action: "wait_for_timeout",
          note: "missing_list_wait",
          details: {
            delayMs: this.deps.scanScrollWaitMs
          },
          attempt: iterations,
          run: async () => {
            await page.waitForTimeout(this.deps.scanScrollWaitMs);
          }
        });
        continue;
      }
      missingListIterations = 0;

      if (snapshot.threadItemCount === 0) {
        const overlayReason = await this.detectLinkedInOverlayReason(page);
        if (overlayReason === "login_required" || overlayReason === "checkpoint_required") {
          throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
            kind: "AUTH_REQUIRED",
            stage: "collect_threads",
            platform: this.platform,
            details: {
              reason: overlayReason,
              url: page.url()
            }
          });
        }
        if (overlayReason === "rate_limited" || overlayReason === "linkedin_error_overlay") {
          throw new AdapterFailure("LinkedIn unread thread list is blocked by an overlay.", {
            kind: "SELECTOR_MISMATCH",
            stage: "collect_threads",
            platform: this.platform,
            details: {
              reason: overlayReason,
              url: page.url()
            }
          });
        }
      }

      const previousCount = merged.size;
      for (const row of snapshot.rows) {
        if (merged.has(row.stableKey)) {
          continue;
        }
        merged.set(row.stableKey, {
          platformThreadId: row.stableKey,
          displayName: row.displayName,
          unreadCount: row.unreadCount,
          lastMessagePreview: row.lastMessagePreview,
          lastMessageAt: row.lastMessageAt,
          threadUrl: row.threadUrl,
          avatarUrl: row.avatarUrl
        });
      }
      const nextCount = merged.size;
      const grew = nextCount > previousCount;
      const bottomRepeated = Boolean(snapshot.bottomKey && snapshot.bottomKey === previousBottomKey);

      if (grew) {
        noProgressStreak = 0;
      } else {
        noProgressStreak += 1;
      }
      bottomRepeatStreak = bottomRepeated ? bottomRepeatStreak + 1 : 0;

      previousBottomKey = snapshot.bottomKey;

      if (nextCount >= cappedMaxThreads) {
        stopReason = "max_threads";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection after hitting max thread cap",
          details: {
            nextCount,
            cappedMaxThreads
          }
        });
        break;
      }
      if (noProgressStreak >= stableIterationsTarget) {
        stopReason = "end_of_list_no_progress";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to no growth streak",
          details: {
            noProgressStreak,
            stableIterationsTarget
          }
        });
        break;
      }
      if (bottomRepeatStreak >= stableIterationsTarget) {
        stopReason = "end_of_list_reached";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to repeated bottom key",
          details: {
            bottomRepeatStreak,
            stableIterationsTarget
          }
        });
        break;
      }
      if (scrollNoMoveStreak >= stableIterationsTarget) {
        stopReason = "end_of_list_no_progress";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to repeated scroll no-move streak",
          details: {
            scrollNoMoveStreak,
            stableIterationsTarget
          }
        });
        break;
      }

      const scrollOutcome = await this.deepScrollThreadList(page, selectors, {
        bottomKey: snapshot.bottomKey,
        visibleSetHash: snapshot.visibleSetHash
      });
      scrollIterations += 1;
      this.logTraceEvent({
        stage: "collect_threads",
        action: "scroll_iteration",
        details: {
          scrollIterations,
          moved: scrollOutcome.moved,
          reachedBottom: scrollOutcome.reachedBottom,
          didScroll: scrollOutcome.didScroll
        },
        attempt: iterations,
        page
      });
      if (!scrollOutcome.moved) {
        scrollNoMoveStreak += 1;
      } else {
        scrollNoMoveStreak = 0;
      }
      if (!scrollOutcome.didScroll || scrollOutcome.reachedBottom) {
        stopReason = merged.size > 0 ? "end_of_list_reached" : "zero_threads_found";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection because list reached bottom",
          details: {
            mergedCount: merged.size,
            stopReason
          }
        });
        break;
      }

      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "wait_for_timeout",
        note: "post_scroll_wait",
        details: {
          delayMs: this.deps.scanScrollWaitMs
        },
        run: async () => {
          await page.waitForTimeout(this.deps.scanScrollWaitMs);
        }
      });
    }

    if (merged.size <= 0 && stopReason !== "max_threads") {
      stopReason = "zero_threads_found";
    }

    this.logTraceEvent({
      stage: "collect_threads",
      action: "collection_complete",
      details: {
        iterations,
        stopReason,
        threadsCollectedTotal: merged.size,
        noProgressStreak,
        bottomRepeatStreak,
        scrollNoMoveStreak,
        scrollIterations
      },
      page
    });

    return {
      rows: Array.from(merged.values()).slice(0, cappedMaxThreads),
      iterations,
      stopReason,
      noProgressStreak,
      bottomRepeatStreak,
      scrollNoMoveStreak,
      scrollIterations
    };
  }

  getLastCollectionMetrics(): {
    totalFound: number;
    unreadFound: number;
    iterations: number;
    stopReason: LinkedInCollectionStopReason;
  } | null {
    return this.lastCollectionMetrics;
  }

  private async getActiveThreadDescriptor(page: Page, selectors: SelectorRegistry): Promise<ActiveThreadDescriptor> {
    return page.evaluate(
      ({ selectors }) => {
        const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
        const activeNode =
          (document.querySelector(
            "li.msg-conversation-listitem .msg-conversations-container__convo-item-link--active"
          ) as HTMLElement | null) ??
          (document.querySelector(
            "li.msg-conversation-listitem .msg-conversation-listitem__link--active"
          ) as HTMLElement | null);

        const activeRow =
          (activeNode?.closest("li.msg-conversation-listitem") as HTMLElement | null) ??
          ((activeNode as HTMLElement | null) ?? null);

        const href =
          (activeRow?.querySelector("a[href*='/messaging/']") as HTMLAnchorElement | null)?.href ??
          (document.querySelector(`${selectors.thread_item} a[href*='/messaging/']`) as HTMLAnchorElement | null)?.href ??
          undefined;

        const displayName =
          clean(
            activeRow?.querySelector("h3 span.truncate")?.textContent ??
              activeRow?.querySelector("h3")?.textContent ??
              activeRow?.querySelector("span[title]")?.getAttribute("title") ??
              document.querySelector(".msg-thread__link-to-profile")?.textContent ??
              ""
          ) || undefined;

        const activeKey =
          activeRow?.getAttribute("data-conversation-urn") ??
          activeRow?.getAttribute("data-urn") ??
          activeRow?.getAttribute("data-conversation-id") ??
          activeRow?.getAttribute("data-id") ??
          activeRow?.id ??
          href;

        return {
          threadUrl: href,
          activeKey: activeKey || undefined,
          displayName
        } satisfies ActiveThreadDescriptor;
      },
      { selectors }
    );
  }

  private isThreadDescriptorMatch(
    descriptor: ActiveThreadDescriptor,
    thread: ThreadStub,
    currentPageUrl: string
  ): boolean {
    const expectedName = this.normalizeIdentity(thread.displayName);
    const actualName = this.normalizeIdentity(descriptor.displayName);
    if (expectedName && actualName && expectedName === actualName) {
      return true;
    }

    const expectedKey = this.normalizeIdentity(thread.platformThreadId);
    const actualKey = this.normalizeIdentity(descriptor.activeKey);
    if (expectedKey && actualKey && expectedKey === actualKey) {
      return true;
    }

    const expectedToken = this.resolveThreadUrlToken(thread.threadUrl || thread.platformThreadId);
    const actualToken = this.resolveThreadUrlToken(descriptor.threadUrl || currentPageUrl);
    if (expectedToken && actualToken && (expectedToken.includes(actualToken) || actualToken.includes(expectedToken))) {
      return true;
    }

    return false;
  }

  private async openThreadAndWaitForActivation(
    page: Page,
    selectors: SelectorRegistry,
    thread: ThreadStub
  ): Promise<void> {
    const before = await this.getActiveThreadDescriptor(page, selectors);

    if (thread.threadUrl) {
      await this.tracedGoto(page, thread.threadUrl, {
        stage: "open_thread",
        note: "open_by_thread_url"
      });
    } else {
      await this.tracedGoto(page, selectors.inbox_url, {
        stage: "open_thread",
        note: "open_by_inbox_navigation"
      });
      await this.tracedWaitForVisible(page, selectors.thread_list, LinkedInAdapter.inboxReadyTimeoutMs, {
        stage: "open_thread",
        note: "wait_thread_list_before_click"
      });

      const rowRoot = page.locator(".msg-conversation-listitem").filter({ hasText: thread.displayName }).first();
      const fallbackRow = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
      const rowExists = (await rowRoot.count()) > 0;
      const clickTarget = rowExists
        ? rowRoot.locator(".msg-conversation-listitem__link").first()
        : fallbackRow;
      const clickTargetExists = (await clickTarget.count()) > 0;

      if (!rowExists && !clickTargetExists) {
        throw new AdapterFailure(`Unable to locate LinkedIn thread row for ${thread.displayName}`, {
          kind: "THREAD_FETCH_FAILED",
          platform: this.platform,
          stage: "open_thread",
          platformThreadId: thread.platformThreadId,
          details: {
            targetDisplayName: thread.displayName,
            platformThreadId: thread.platformThreadId
          }
        });
      }

      await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);
      await this.runTracedPageAction({
        page,
        stage: "open_thread",
        action: "click",
        selector: rowExists ? ".msg-conversation-listitem__link" : selectors.thread_item,
        note: "activate_thread_row",
        details: {
          targetDisplayName: thread.displayName
        },
        run: async () => {
          await clickTarget.click({ timeout: 10_000 });
        }
      });
    }

    await this.tracedWaitForVisible(page, selectors.message_container, 15_000, {
      stage: "open_thread",
      note: "wait_message_container_after_open"
    });

    const startedAt = Date.now();
    let lastDescriptor: ActiveThreadDescriptor | undefined;

    while (Date.now() - startedAt < 12_000) {
      await this.throwIfAuthRequired(page, "openThreadAndWaitForActivation");
      const descriptor = await this.getActiveThreadDescriptor(page, selectors);
      lastDescriptor = descriptor;

      const changed =
        this.normalizeIdentity(before.activeKey) !== this.normalizeIdentity(descriptor.activeKey) ||
        this.normalizeIdentity(before.displayName) !== this.normalizeIdentity(descriptor.displayName) ||
        this.normalizeThreadUrl(before.threadUrl) !== this.normalizeThreadUrl(descriptor.threadUrl);

      const matchesTarget = this.isThreadDescriptorMatch(descriptor, thread, page.url());
      if (matchesTarget || changed) {
        if (matchesTarget) {
          return;
        }
      }

      await this.runTracedPageAction({
        page,
        stage: "open_thread",
        action: "wait_for_timeout",
        note: "activation_poll_wait",
        details: {
          delayMs: 300
        },
        run: async () => {
          await page.waitForTimeout(300);
        }
      });
    }

    throw new AdapterFailure(`LinkedIn thread activation mismatch for ${thread.displayName}`, {
      kind: "THREAD_FETCH_FAILED",
      platform: this.platform,
      stage: "open_thread",
      platformThreadId: thread.platformThreadId,
      details: {
        targetDisplayName: thread.displayName,
        targetThreadUrl: thread.threadUrl ?? null,
        targetPlatformThreadId: thread.platformThreadId,
        actualDisplayName: lastDescriptor?.displayName ?? null,
        actualThreadUrl: lastDescriptor?.threadUrl ?? page.url(),
        actualKey: lastDescriptor?.activeKey ?? null
      }
    });
  }

  private async collectThreadMessagesWithBackfill(
    page: Page,
    selectors: SelectorRegistry,
    limit: number
  ): Promise<LinkedInMessageSnapshot[]> {
    const maxAttempts = Math.max(1, this.deps.messageBackfillAttempts);
    const merged = new Map<string, LinkedInMessageSnapshot>();

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.logTraceEvent({
        stage: "read_thread",
        action: "message_backfill_attempt_start",
        details: {
          attempt: attempt + 1,
          maxAttempts,
          limit,
          mergedCount: merged.size
        },
        attempt: attempt + 1,
        page
      });
      const snapshot = await page.evaluate(
        ({ selectors }) => {
          const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
          const findScrollableContainer = (start: Element | null): HTMLElement | null => {
            let current = start as HTMLElement | null;
            while (current) {
              const style = window.getComputedStyle(current);
              const overflowY = style.overflowY.toLowerCase();
              const scrollable = overflowY.includes("auto") || overflowY.includes("scroll");
              if (scrollable && current.scrollHeight > current.clientHeight + 4) {
                return current;
              }
              current = current.parentElement;
            }
            return null;
          };

          const nodes = Array.from(document.querySelectorAll(selectors.message_item));
          const messages = nodes.map((node, index) => {
            const root = node as HTMLElement;
            const className = root.className || "";
            const inbound = className.includes("msg-s-event-listitem--other") || /other|received|incoming/i.test(className);
            const attachmentCount = root.querySelectorAll("img, video, svg, a[download], a[href*='attachment']").length;
            const rawBodyText = clean(
              root.querySelector(selectors.message_text)?.textContent ??
                ""
            );
            const text =
              rawBodyText ||
              (attachmentCount > 0 ? "[non-text message]" : "[system event]");
            const senderName = clean(
              root.querySelector(".msg-s-message-group__profile-link")?.textContent ??
                root.querySelector(".msg-s-message-group__name")?.textContent ??
                ""
            );
            const timeNode = root.querySelector("time") as HTMLTimeElement | null;
            const timestamp =
              clean(timeNode?.getAttribute("datetime")) ||
              clean(timeNode?.textContent) ||
              "";
            const platformMessageKey =
              root.getAttribute("data-event-urn") ||
              root.getAttribute("data-id") ||
              root.getAttribute("id") ||
              `li-msg-${index}`;

            return {
              platformMessageKey,
              direction: inbound ? "IN" : "OUT",
              timestamp,
              text,
              senderName: senderName || undefined,
              raw: {
                className,
                hasTime: Boolean(timeNode),
                attachmentCount
              },
              attachments: attachmentCount
                ? [{ type: "attachment", manualReview: true, rawLabel: `${attachmentCount} attachment(s)` }]
                : []
            };
          });

          const container = findScrollableContainer(document.querySelector(selectors.message_container));
          const beforeTop = container?.scrollTop ?? 0;
          if (container) {
            const jump = Math.max(200, Math.floor(container.clientHeight * 0.8));
            container.scrollTop = Math.max(0, beforeTop - jump);
          }
          const afterTop = container?.scrollTop ?? beforeTop;
          const didScrollUp = afterTop < beforeTop - 1;

          return {
            messages,
            didScrollUp
          };
        },
        { selectors }
      );

      for (const message of snapshot.messages) {
        merged.set(message.platformMessageKey, {
          ...message,
          direction: message.direction === "IN" ? "IN" : "OUT"
        });
      }
      this.logTraceEvent({
        stage: "read_thread",
        action: "message_backfill_attempt_end",
        details: {
          attempt: attempt + 1,
          collectedInAttempt: snapshot.messages.length,
          mergedCount: merged.size,
          didScrollUp: snapshot.didScrollUp
        },
        attempt: attempt + 1,
        page
      });

      if (merged.size >= limit || !snapshot.didScrollUp) {
        break;
      }

      await this.runTracedPageAction({
        page,
        stage: "read_thread",
        action: "wait_for_timeout",
        note: "message_backfill_wait",
        details: {
          delayMs: 350
        },
        attempt: attempt + 1,
        run: async () => {
          await page.waitForTimeout(350);
        }
      });
    }

    const rows = Array.from(merged.values());
    rows.sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      const safeLeft = Number.isNaN(leftTime) ? 0 : leftTime;
      const safeRight = Number.isNaN(rightTime) ? 0 : rightTime;
      return safeLeft - safeRight;
    });
    this.logTraceEvent({
      stage: "read_thread",
      action: "message_backfill_complete",
      details: {
        totalMessages: rows.length,
        returnedMessages: Math.min(rows.length, limit)
      },
      page
    });
    return rows.slice(-limit);
  }

  async ensureConnected(): Promise<void> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();

      let page: Page | null = null;
      try {
        this.activeStage = "connect";
        this.runLogger?.logStage({
          stage: "connect",
          phase: "start"
        });
        page = await this.navigateInbox(selectors);
        await this.throwIfAuthRequired(page, "ensureConnected:navigation");
        await this.tracedWaitForVisible(page, selectors.thread_list, LinkedInAdapter.inboxReadyTimeoutMs, {
          stage: "connect",
          note: "wait_thread_list_connected"
        });
        await this.throwIfAuthRequired(page, "ensureConnected:thread_list");
        this.runLogger?.logStage({
          stage: "connect",
          phase: "end"
        });
      } catch (error) {
        this.runLogger?.logError({
          component: "linkedin-adapter",
          stage: "connect",
          action: "ensure_connected_failed",
          error
        });
        if (page) {
          await this.captureRunFailureArtifacts(page);
        }
        if (error instanceof AdapterFailure) {
          throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);
        const currentUrl = page?.url();
        const suffix = currentUrl ? ` (url: ${currentUrl})` : "";
        throw await toStageFailure({
          platform: this.platform,
          stage: "connect",
          message: `LinkedIn connect failed (${reason})${suffix}`,
          action: "connect-failed",
          error,
          kind: this.classifyFailureKind(reason, "SELECTOR_MISMATCH"),
          page: page ?? undefined,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir,
          details: currentUrl ? { url: currentUrl } : undefined
        });
      } finally {
        this.activeStage = null;
      }
    });
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.navigateInbox(selectors);
      const stageReceipts: LinkedInScanStageReceipt[] = [];
      let activeStage: LinkedInScanStageReceipt["stage"] = "navigate";
      let recoveryAttempts = 0;
      const runCounters: LinkedInRunCounters = {
        unreadViewActive: false,
        threadsVisibleCount: 0,
        threadsCollectedTotal: 0,
        threadsWithUnreadBadgeCount: 0,
        candidatesToOpenCount: 0,
        openedThreadsCount: 0,
        messagesParsedCount: 0,
        scrollIterations: 0,
        noProgressStreak: 0,
        recoveryAttemptsUsed: 0,
        reloadSuppressed: false
      };

      const stopRunTracing = await this.startRunTracing(page);
      const runStage = async <T>(
        stage: LinkedInScanStageReceipt["stage"],
        run: () => Promise<T>,
        details?: Record<string, unknown>
      ): Promise<T> => {
        activeStage = stage;
        this.activeStage = stage;
        const started = Date.now();
        const startedAt = new Date(started).toISOString();
        this.runLogger?.logStage({
          stage,
          phase: "start",
          details
        });
        try {
          const value = await run();
          const durationMs = Date.now() - started;
          stageReceipts.push({
            stage,
            status: "OK",
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            details
          });
          this.runLogger?.logStage({
            stage,
            phase: "end",
            details: {
              status: "OK",
              ...(details ?? {})
            },
            elapsedMs: durationMs
          });
          return value;
        } catch (error) {
          const durationMs = Date.now() - started;
          stageReceipts.push({
            stage,
            status: "FAIL",
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            details: {
              ...(details ?? {}),
              ...this.summarizeError(error)
            }
          });
          this.runLogger?.logStage({
            stage,
            phase: "end",
            details: {
              status: "FAIL",
              ...(details ?? {})
            },
            elapsedMs: durationMs
          });
          throw error;
        }
      };

      try {
        for (let attempt = 0; attempt <= 1; attempt += 1) {
          try {
            await runStage("navigate", async () => {
              const readiness = await this.waitForThreadListReadyOrClassified(page, selectors, 8_000);
              if (!readiness.ready) {
                if (readiness.reason === "login_required" || readiness.reason === "checkpoint_required") {
                  throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
                    kind: "AUTH_REQUIRED",
                    platform: this.platform,
                    stage: "navigate",
                    details: {
                      reason: readiness.reason,
                      url: page.url()
                    }
                  });
                }
                if (readiness.reason === "rate_limited" || readiness.reason === "linkedin_error_overlay") {
                  throw new AdapterFailure("LinkedIn inbox is blocked by a LinkedIn overlay.", {
                    kind: "SELECTOR_MISMATCH",
                    platform: this.platform,
                    stage: "navigate",
                    details: {
                      reason: readiness.reason,
                      url: page.url()
                    }
                  });
                }
                throw new Error("LinkedIn thread list container not ready.");
              }
            }, {
              url: page.url()
            });

            await runStage("auth_check", async () => {
              await this.throwIfAuthRequired(page, "scanUnreadThreads:navigation");
              await this.throwIfAuthRequired(page, "scanUnreadThreads:thread_list");
            });

            const unreadFilterResult = await runStage("unread_filter", async () => {
              return this.ensureUnreadFilterActive(page, selectors);
            });

            const collected = await runStage(
              "collect_threads",
              async () => this.collectThreadRowsWithScroll(page, selectors, this.deps.scanMaxThreads),
              {
                unreadFilterResult: { ...unreadFilterResult },
                attempt: attempt + 1,
                recoveryAttempts
              }
            );
            const latestReceipt = stageReceipts.at(-1);
            if (latestReceipt && latestReceipt.stage === "collect_threads") {
              latestReceipt.details = {
                ...(latestReceipt.details ?? {}),
                iterations: collected.iterations,
                stopReason: collected.stopReason,
                uniqueThreads: collected.rows.length,
                noProgressStreak: collected.noProgressStreak,
                bottomRepeatStreak: collected.bottomRepeatStreak,
                scrollNoMoveStreak: collected.scrollNoMoveStreak,
                scrollIterations: collected.scrollIterations
              };
            }

            const unreadCandidates = collected.rows.filter((thread) => (thread.unreadCount ?? 0) > 0);
            runCounters.unreadViewActive = unreadFilterResult.pillPresent && unreadFilterResult.waitReason !== "pill_missing";
            runCounters.threadsVisibleCount = collected.rows.length;
            runCounters.threadsCollectedTotal = collected.rows.length;
            runCounters.threadsWithUnreadBadgeCount = unreadCandidates.length;
            runCounters.candidatesToOpenCount = unreadCandidates.length;
            runCounters.scrollIterations = collected.scrollIterations;
            runCounters.noProgressStreak = collected.noProgressStreak;
            runCounters.stopReason = collected.stopReason;
            runCounters.recoveryAttemptsUsed = recoveryAttempts;
            this.runLogger?.mergeCounters({ ...runCounters });

            this.logTraceDecision({
              stage: "collect_threads",
              decision: runCounters.unreadViewActive
                ? "Unread pill active => unread badge filtering used"
                : "Unread badge filtering used",
              details: {
                threadsCollectedTotal: runCounters.threadsCollectedTotal,
                unreadCandidatesCount: runCounters.candidatesToOpenCount
              }
            });

            if (runCounters.candidatesToOpenCount === 0 && runCounters.unreadViewActive) {
              this.logTraceDecision({
                stage: "collect_threads",
                level: "warn",
                decision: "Candidate selection empty => failing with reason unread_candidates_empty_in_unread_view",
                details: {
                  reason: "unread_candidates_empty_in_unread_view",
                  threadsVisibleCount: runCounters.threadsVisibleCount
                }
              });
            }

            this.lastCollectionMetrics = {
              totalFound: collected.rows.length,
              unreadFound: unreadCandidates.length,
              iterations: collected.iterations,
              stopReason: collected.stopReason
            };
            return unreadCandidates.map((thread) => ({ ...thread, isUnreadCandidate: true }));
          } catch (error) {
            if (attempt === 0 && isRetryableLinkedInCollectError(error)) {
              this.logTraceDecision({
                stage: activeStage,
                level: "warn",
                decision: "Retryable collect error detected; automatic reload is disabled and manual refresh is required",
                details: {
                  attempt: attempt + 1,
                  message: error instanceof Error ? error.message : String(error)
                }
              });
              runCounters.reloadSuppressed = true;
              runCounters.recoveryAttemptsUsed = recoveryAttempts;
              this.runLogger?.mergeCounters({ ...runCounters });
              throw new AdapterFailure(
                "Manual refresh required: LinkedIn page became unstable. Refresh LinkedIn manually, then rerun scan. Automatic reload is disabled to preserve browser console diagnostics.",
                {
                  kind: "SELECTOR_MISMATCH",
                  platform: this.platform,
                  stage: activeStage,
                  details: {
                    reason: "manual_refresh_required",
                    requiresManualRefresh: true,
                    guidance: "Refresh LinkedIn manually and rerun scan.",
                    recoveryAttempts
                  }
                }
              );
            }

            const runtimeContext = await this.captureUnreadScanRuntimeContext(page, selectors).catch(() => undefined);
            const failureReason = resolveLinkedInScanFailureReason({
              message: error instanceof Error ? error.message : String(error),
              url: runtimeContext?.url ?? page.url(),
              overlayReason: runtimeContext?.overlayReason,
              threadListCount: runtimeContext?.threadListCount,
              threadItemCount: runtimeContext?.threadItemCount,
              spinnerCount: runtimeContext?.spinnerCount
            });
            runCounters.recoveryAttemptsUsed = recoveryAttempts;
            runCounters.stopReason = failureReason;
            this.runLogger?.mergeCounters({ ...runCounters });

            this.runLogger?.logError({
              component: "linkedin-adapter",
              stage: activeStage,
              action: "scan_unread_fail",
              error,
              details: {
                reason: failureReason,
                runtimeContext,
                recoveryAttempts
              },
              url: page.url(),
              pageId: this.getPageTraceId(page)
            });
            await this.captureRunFailureArtifacts(page);

            if (error instanceof AdapterFailure) {
              error.details = {
                ...(error.details ?? {}),
                stage: error.stage ?? activeStage,
                reason: failureReason,
                runtimeContext,
                stageReceipts,
                recoveryAttempts
              };
              throw error;
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            throw await toStageFailure({
              platform: this.platform,
              stage: activeStage,
              message: "Failed while scanning LinkedIn unread threads",
              action: "scan-unread",
              error,
              kind: this.classifyFailureKind(errorMessage, "SELECTOR_MISMATCH"),
              page,
              screenshotDir: this.deps.screenshotDir,
              domDumpDir: this.deps.domDumpDir,
              details: {
                stage: activeStage,
                reason: failureReason,
                message: errorMessage,
                runtimeContext,
                stageReceipts,
                recoveryAttempts
              }
            });
          }
        }

        throw new Error("LinkedIn unread scan exhausted retries.");
      } finally {
        runCounters.recoveryAttemptsUsed = recoveryAttempts;
        this.runLogger?.mergeCounters({ ...runCounters });
        this.activeStage = null;
        await stopRunTracing();
      }
    });
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.navigateInbox(selectors);

      try {
        this.activeStage = "collect_threads";
        this.runLogger?.logStage({
          stage: "collect_threads",
          phase: "start",
          details: {
            mode: "recent",
            limit
          }
        });
        await this.throwIfAuthRequired(page, "fetchRecentThreads:navigation");
        await this.tracedWaitForVisible(page, selectors.thread_list, 10_000, {
          stage: "collect_threads",
          note: "wait_recent_thread_list"
        });
        await this.throwIfAuthRequired(page, "fetchRecentThreads:thread_list");
        const collected = await this.collectThreadRowsWithScroll(
          page,
          selectors,
          Math.max(limit, this.deps.scanMaxThreads)
        );
        this.lastCollectionMetrics = {
          totalFound: collected.rows.length,
          unreadFound: collected.rows.filter((thread) => (thread.unreadCount ?? 0) > 0).length,
          iterations: collected.iterations,
          stopReason: collected.stopReason
        };
        this.runLogger?.logStage({
          stage: "collect_threads",
          phase: "end",
          details: {
            mode: "recent",
            status: "OK",
            totalFound: collected.rows.length,
            stopReason: collected.stopReason
          }
        });
        return collected.rows.slice(0, limit).map((thread) => ({ ...thread, isRecentCandidate: true }));
      } catch (error) {
        this.runLogger?.logError({
          component: "linkedin-adapter",
          stage: "collect_threads",
          action: "scan_recent_fail",
          error
        });
        await this.captureRunFailureArtifacts(page);
        if (error instanceof AdapterFailure) {
          throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);
        throw await toStageFailure({
          platform: this.platform,
          stage: "collect_threads",
          message: "Failed while scanning LinkedIn recent threads",
          action: "scan-recent",
          error,
          kind: this.classifyFailureKind(reason, "SELECTOR_MISMATCH"),
          page,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir
        });
      } finally {
        this.activeStage = null;
      }
    });
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.navigateInbox(selectors);

      try {
        this.activeStage = "read_thread";
        this.runLogger?.logStage({
          stage: "read_thread",
          phase: "start",
          details: {
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName,
            limit
          }
        });
        await this.throwIfAuthRequired(page, "fetchThreadMessages:navigation");
        await this.openThreadAndWaitForActivation(page, selectors, thread);
        await this.throwIfAuthRequired(page, "fetchThreadMessages:after_activation");
        await this.tracedWaitForVisible(page, selectors.message_container, 15_000, {
          stage: "read_thread",
          note: "wait_message_container"
        });
        await this.throwIfAuthRequired(page, "fetchThreadMessages:after_container_wait");

        const messages = await this.collectThreadMessagesWithBackfill(page, selectors, limit);
        this.logTraceEvent({
          stage: "read_thread",
          action: "messages_parsed",
          details: {
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName,
            messagesParsedCount: messages.length
          },
          page
        });
        this.runLogger?.logStage({
          stage: "read_thread",
          phase: "end",
          details: {
            status: "OK",
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName,
            messagesParsedCount: messages.length
          }
        });
        const baseTimestamp = Date.now() - messages.length * 1_000;
        return messages.map((message, index) => ({
          ...message,
          direction: message.direction === "IN" ? "IN" : "OUT",
          timestamp: this.normalizeTimestamp(message.timestamp, new Date(baseTimestamp + index * 1_000).toISOString()),
          text: cleanText(message.text),
          senderName: message.senderName,
          raw: message.raw
        }));
      } catch (error) {
        this.runLogger?.logError({
          component: "linkedin-adapter",
          stage: "read_thread",
          action: "fetch_thread_messages_fail",
          error,
          details: {
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName
          }
        });
        await this.captureRunFailureArtifacts(page);
        if (error instanceof AdapterFailure) {
          throw error;
        }
        throw await toStageFailure({
          platform: this.platform,
          stage: "parse",
          message: `Failed to fetch LinkedIn thread messages for ${thread.displayName}`,
          action: "fetch-thread",
          error,
          kind: "THREAD_FETCH_FAILED",
          page,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir,
          platformThreadId: thread.platformThreadId,
          details: { threadDisplayName: thread.displayName, url: page.url() }
        });
      } finally {
        this.activeStage = null;
      }
    });
  }

  private async getLatestMessageSnapshot(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{ direction: "IN" | "OUT"; timestamp: number; text: string } | null> {
    return page.evaluate(
      ({ selectors }) => {
        const nodes = Array.from(document.querySelectorAll(selectors.message_item));
        const last = nodes[nodes.length - 1] as HTMLElement | undefined;
        if (!last) {
          return null;
        }

        const className = last.className || "";
        const inbound = /other|received|incoming/i.test(className);
        const timeNode = last.querySelector("time") as HTMLTimeElement | null;
        const timestampRaw = timeNode?.getAttribute("datetime") || timeNode?.textContent || "";
        const parsed = Date.parse(timestampRaw);

        const text =
          last.querySelector(selectors.message_text)?.textContent ||
          last.textContent ||
          "";

        return {
          direction: inbound ? "IN" : "OUT",
          timestamp: Number.isNaN(parsed) ? Date.now() : parsed,
          text
        };
      },
      { selectors }
    );
  }

  async sendMessage(thread: ThreadStub, text: string): Promise<SendReceipt> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.getPage();

      try {
        if (thread.threadUrl) {
          await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
        } else {
          await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
          const rowRoot = page.locator(".msg-conversation-listitem").filter({ hasText: thread.displayName }).first();
          const fallbackRow = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
          const rowExists = (await rowRoot.count()) > 0;
          const clickTarget = rowExists
            ? rowRoot.locator(".msg-conversation-listitem__link").first()
            : fallbackRow;
          if ((await clickTarget.count()) > 0) {
            await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);
            await clickTarget.click();
          }
        }

        await page.waitForSelector(selectors.message_container, { timeout: 12_000 });
        const preSend = await this.getLatestMessageSnapshot(page, selectors);

        const composer = page.locator(selectors.composer_input).first();
        await composer.click({ timeout: 10_000 });
        try {
          await composer.fill(text);
        } catch {
          await page.keyboard.press("Meta+A").catch(() => undefined);
          await page.keyboard.type(text, { delay: 12 });
        }

        await humanDelay(100, 300);
        await page.locator(selectors.send_button).first().click({ timeout: 10_000 });

        const start = Date.now();
        let verifiedBy: VerificationMethod = "best_effort";

        while (Date.now() - start < 10_000) {
          const last = await this.getLatestMessageSnapshot(page, selectors);
          if (!last) {
            await page.waitForTimeout(300);
            continue;
          }

          const timestampAdvanced = !preSend || last.timestamp > preSend.timestamp;
          const textMatch = cleanText(last.text).includes(cleanText(text));

          if (last.direction === "OUT" && timestampAdvanced && textMatch) {
            verifiedBy = "bubble_detected";
            break;
          }

          if (last.direction === "OUT" && timestampAdvanced) {
            verifiedBy = "timestamp_advanced";
            break;
          }

          await page.waitForTimeout(400);
        }

        return {
          sentAt: new Date().toISOString(),
          verifiedBy
        };
      } catch (error) {
        throw await toStageFailure({
          platform: this.platform,
          stage: "persist",
          message: `Failed to send LinkedIn message for ${thread.displayName}`,
          action: "send",
          error,
          kind: "THREAD_FETCH_FAILED",
          page,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir,
          platformThreadId: thread.platformThreadId,
          details: {
            threadDisplayName: thread.displayName
          }
        });
      }
    });
  }

  async openThread(thread: ThreadStub): Promise<void> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.getPage();
      await page.bringToFront();
      await this.openThreadAndWaitForActivation(page, selectors, thread);
    });
  }

  async closeSession(_reason?: string): Promise<void> {
    await this.deps.sessionManager.closePlatformPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default"
    });
  }
}
