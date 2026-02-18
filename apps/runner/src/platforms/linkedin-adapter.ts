import type { Locator, Page } from "playwright";
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
  | "login_required"
  | "checkpoint_required"
  | "rate_limited"
  | "linkedin_error_overlay"
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
    /target page, context or browser has been closed/i.test(message) ||
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

    const clicked = await page
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
          await page.waitForTimeout(100);
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
          await page.waitForTimeout(100);
        }

        return false;
      },
      waitForTimeout: (ms) => page.waitForTimeout(ms)
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
  | "no_growth"
  | "trailing_repeat"
  | "bottom_reached"
  | "iteration_cap";

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
    return "no_growth";
  }
  if (input.trailingRepeatIterations >= input.stableIterations) {
    return "trailing_repeat";
  }
  if (!input.didScroll && input.reachedBottom) {
    return "bottom_reached";
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

  constructor(private readonly deps: LinkedInAdapterDependencies) {}

  private async getPage(): Promise<Page> {
    return this.deps.sessionManager.getManagedPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default",
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }

  private async navigateInbox(selectors: SelectorRegistry): Promise<Page> {
    const navigate = async (target: Page): Promise<void> => {
      await target.bringToFront();
      await target.goto(selectors.inbox_url, {
        waitUntil: "commit",
        timeout: LinkedInAdapter.inboxNavigationTimeoutMs
      });
      await target.waitForLoadState("domcontentloaded", {
        timeout: 4_000
      }).catch(() => undefined);
      await target.waitForTimeout(350);
    };

    const page = await retryWithBackoff({
      attempts: 2,
      baseDelayMs: 300,
      isRetryable: (error) => isTransientPageError(error),
      run: async (attempt) => {
        if (attempt > 1) {
          await this.deps.sessionManager.closePlatformPage({
            platform: this.platform,
            personKey: this.deps.personKey ?? "default"
          });
        }

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

    const hasLoginDom = await page.evaluate(() => {
      const hasUsername = document.querySelector("#username") !== null;
      const hasPassword = document.querySelector("#password") !== null;
      const hasLoginForm =
        document.querySelector("form[action*='login-submit']") !== null ||
        document.querySelector("form[data-id='sign-in-form']") !== null ||
        document.querySelector("[data-id='sign-in-form']") !== null;
      return hasUsername || hasPassword || hasLoginForm;
    });

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
      const threadItemCount = await page.locator(selectors.thread_item).count().catch(() => 0);
      const unreadBadgeCount = await page.locator(selectors.unread_badge).count().catch(() => 0);
      const spinnerCount = await page.locator(linkedInLoadingSpinnerSelector).count().catch(() => 0);
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
      await page.waitForTimeout(140);
    }
  }

  private async captureThreadRowsSnapshot(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<Omit<LinkedInThreadCollectionIteration, "didScroll" | "reachedBottom">> {
    const threadListLocator = page.locator(selectors.thread_list).first();
    const threadListCount = await threadListLocator.count().catch(() => 0);

    const rowRoots = page.locator(".msg-conversation-listitem");
    const rowRootCount = await rowRoots.count().catch(() => 0);
    const selectorItems = page.locator(selectors.thread_item);
    const selectorItemCount = rowRootCount > 0 ? rowRootCount : await selectorItems.count().catch(() => 0);

    const rows: LinkedInThreadSnapshot[] = [];
    const readText = async (locator: Locator): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.textContent({ timeout: 0 }).catch(() => null);
    };
    const readAttr = async (locator: Locator, name: string): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.getAttribute(name, { timeout: 0 }).catch(() => null);
    };

    for (let index = 0; index < selectorItemCount; index += 1) {
      const selectorItem = selectorItems.nth(index);
      const rootCandidate =
        rowRootCount > 0
          ? rowRoots.nth(index)
          : selectorItem
              .locator(
                "xpath=ancestor-or-self::*[contains(concat(' ', normalize-space(@class), ' '), ' msg-conversation-listitem ')][1]"
              )
              .first();
      const rootExists = (await rootCandidate.count().catch(() => 0)) > 0;
      const scope = rootExists ? rootCandidate : selectorItem;

      const clickTarget = scope.locator(".msg-conversation-listitem__link").first();
      const clickTargetExists = (await clickTarget.count().catch(() => 0)) > 0;
      const linkContainer = clickTargetExists ? clickTarget : scope;

      const hrefRaw =
        (await readAttr(linkContainer.locator("a[href*='/messaging/']"), "href")) ??
        (await readAttr(linkContainer, "href")) ??
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
          (await readAttr(scope.locator("span[title]"), "title")) ??
          (await readAttr(scope, "aria-label")) ??
          ""
      );

      const preview = cleanText(
        (await readText(scope.locator(".msg-conversation-card__message-snippet"))) ??
          (await readText(scope.locator("p"))) ??
          ""
      ).slice(0, 220);

      const lastMessageAt = cleanText(
        (await readAttr(scope.locator("time"), "datetime")) ??
          (await readText(scope.locator("time"))) ??
          ""
      );

      const unreadContainer = scope.locator(".msg-conversation-card__unread-count").first();
      const unreadContainerExists = (await unreadContainer.count().catch(() => 0)) > 0;
      const unreadText = cleanText(
        (await readText(unreadContainer.locator(".notification-badge__count"))) ??
          (await readText(unreadContainer)) ??
          (await readText(scope.locator(selectors.unread_badge))) ??
          ""
      );
      const unreadMatch = unreadText.match(/\d+/);
      const unreadCount = unreadMatch ? Number(unreadMatch[0]) : unreadContainerExists ? 1 : 0;

      const urnToken =
        (await readAttr(scope, "data-conversation-urn")) ??
        (await readAttr(scope, "data-urn")) ??
        (await readAttr(scope, "data-conversation-id")) ??
        "";
      const dataIdToken = (await readAttr(scope, "data-id")) ?? "";
      const safeDataIdToken = /^ember/i.test(dataIdToken) ? "" : dataIdToken;
      const hrefToken =
        href.match(/\/messaging\/thread\/([^/?#]+)/i)?.[1] ??
        href.match(/[?&]conversationid=([^&#]+)/i)?.[1] ??
        "";
      const fallbackKey = `linkedin-fallback:${displayName.toLowerCase()}|${preview.toLowerCase()}|${lastMessageAt.toLowerCase()}`;
      const stableKey =
        (urnToken && `linkedin-urn:${urnToken.toLowerCase()}`) ||
        (hrefToken && `linkedin-href:${hrefToken.toLowerCase()}`) ||
        (safeDataIdToken && `linkedin-id:${safeDataIdToken.toLowerCase()}`) ||
        fallbackKey ||
        `linkedin-index:${index}`;

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

    return {
      rows,
      trailingKey: rows.at(-1)?.stableKey ?? null,
      threadListCount,
      threadItemCount: selectorItemCount,
      spinnerCount: await page.locator(linkedInLoadingSpinnerSelector).count().catch(() => 0)
    };
  }

  private async scrollThreadListContainer(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{ didScroll: boolean; reachedBottom: boolean }> {
    const linkTargets = page.locator(".msg-conversation-listitem .msg-conversation-listitem__link");
    const linkTargetCount = await linkTargets.count().catch(() => 0);
    if (linkTargetCount > 0) {
      const target = linkTargets.nth(linkTargetCount - 1);
      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.hover({ force: true }).catch(() => undefined);
      await page.mouse.wheel(0, 960).catch(() => undefined);
      return { didScroll: true, reachedBottom: false };
    }

    const rowTargets = page.locator(".msg-conversation-listitem");
    const rowTargetCount = await rowTargets.count().catch(() => 0);
    if (rowTargetCount > 0) {
      const target = rowTargets.nth(rowTargetCount - 1);
      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.hover({ force: true }).catch(() => undefined);
      await page.mouse.wheel(0, 960).catch(() => undefined);
      return { didScroll: true, reachedBottom: false };
    }

    const listTarget = page.locator(selectors.thread_list).first();
    const listTargetCount = await listTarget.count().catch(() => 0);
    if (listTargetCount > 0) {
      await listTarget.scrollIntoViewIfNeeded().catch(() => undefined);
      await listTarget.hover({ force: true }).catch(() => undefined);
      await page.mouse.wheel(0, 960).catch(() => undefined);
      return { didScroll: true, reachedBottom: false };
    }

    return { didScroll: false, reachedBottom: true };
  }

  private async collectThreadRowsWithScroll(
    page: Page,
    selectors: SelectorRegistry,
    maxThreads: number
  ): Promise<{ rows: ThreadStub[]; iterations: number; stopReason: LinkedInCollectionStopReason }> {
    const cappedMaxThreads = Math.max(1, maxThreads);
    const stableIterationsTarget = Math.max(1, this.deps.scanStableIterations);
    const merged = new Map<string, ThreadStub>();

    let noGrowthIterations = 0;
    let trailingRepeatIterations = 0;
    let previousTrailingKey: string | null = null;
    let iterations = 0;
    let loadingWindowIterations = 0;
    let missingListIterations = 0;
    let stopReason: LinkedInCollectionStopReason = "iteration_cap";

    while (iterations < 300) {
      iterations += 1;
      const snapshot = await retryWithBackoff({
        attempts: 3,
        baseDelayMs: 250,
        isRetryable: (error) => isRetryableLinkedInCollectError(error),
        run: async () => this.captureThreadRowsSnapshot(page, selectors)
      });

      if (snapshot.threadItemCount === 0 && snapshot.spinnerCount > 0) {
        loadingWindowIterations += 1;
        if (loadingWindowIterations >= 10) {
          throw new Error("LinkedIn thread list is still loading after unread filter activation.");
        }
        await page.waitForTimeout(this.deps.scanScrollWaitMs);
        continue;
      }

      loadingWindowIterations = 0;
      if (snapshot.threadListCount <= 0) {
        missingListIterations += 1;
        if (missingListIterations >= 6) {
          throw new Error("LinkedIn thread list container is missing while collecting unread threads.");
        }
        await page.waitForTimeout(this.deps.scanScrollWaitMs);
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
        if (!merged.has(row.stableKey)) {
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
      }

      const nextCount = merged.size;
      const stability = updateLinkedInCollectionStability({
        previousCount,
        nextCount,
        previousTrailingKey,
        nextTrailingKey: snapshot.trailingKey,
        noGrowthIterations,
        trailingRepeatIterations
      });

      noGrowthIterations = stability.noGrowthIterations;
      trailingRepeatIterations = stability.trailingRepeatIterations;
      previousTrailingKey = snapshot.trailingKey;
      const scrollOutcome = await this.scrollThreadListContainer(page, selectors);

      const resolvedStopReason = resolveLinkedInCollectionStopReason({
        uniqueCount: nextCount,
        maxThreads: cappedMaxThreads,
        noGrowthIterations,
        trailingRepeatIterations,
        stableIterations: stableIterationsTarget,
        didScroll: scrollOutcome.didScroll,
        reachedBottom: scrollOutcome.reachedBottom
      });
      if (resolvedStopReason || shouldStopLinkedInCollection({
        uniqueCount: nextCount,
        maxThreads: cappedMaxThreads,
        noGrowthIterations,
        trailingRepeatIterations,
        stableIterations: stableIterationsTarget,
        didScroll: scrollOutcome.didScroll,
        reachedBottom: scrollOutcome.reachedBottom
      })) {
        stopReason = resolvedStopReason ?? "iteration_cap";
        break;
      }

      await page.waitForTimeout(this.deps.scanScrollWaitMs);
    }

    return {
      rows: Array.from(merged.values()).slice(0, cappedMaxThreads),
      iterations,
      stopReason
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
      await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(selectors.thread_list, { timeout: LinkedInAdapter.inboxReadyTimeoutMs });

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
      await clickTarget.click({ timeout: 10_000 });
    }

    await page.waitForSelector(selectors.message_container, { timeout: 15_000 });

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

      await page.waitForTimeout(300);
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

      if (merged.size >= limit || !snapshot.didScrollUp) {
        break;
      }

      await page.waitForTimeout(350);
    }

    const rows = Array.from(merged.values());
    rows.sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      const safeLeft = Number.isNaN(leftTime) ? 0 : leftTime;
      const safeRight = Number.isNaN(rightTime) ? 0 : rightTime;
      return safeLeft - safeRight;
    });
    return rows.slice(-limit);
  }

  async ensureConnected(): Promise<void> {
    const selectors = await this.deps.resolveSelectors();

    let page: Page | null = null;
    try {
      page = await this.navigateInbox(selectors);
      await this.throwIfAuthRequired(page, "ensureConnected:navigation");
      await page.waitForSelector(selectors.thread_list, { timeout: LinkedInAdapter.inboxReadyTimeoutMs });
      await this.throwIfAuthRequired(page, "ensureConnected:thread_list");
    } catch (error) {
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
    }
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.navigateInbox(selectors);
    const stageReceipts: LinkedInScanStageReceipt[] = [];
    const runStage = async <T>(
      stage: LinkedInScanStageReceipt["stage"],
      run: () => Promise<T>,
      details?: Record<string, unknown>
    ): Promise<T> => {
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      try {
        const value = await run();
        stageReceipts.push({
          stage,
          status: "OK",
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          details
        });
        return value;
      } catch (error) {
        stageReceipts.push({
          stage,
          status: "FAIL",
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          details: {
            ...(details ?? {}),
            ...this.summarizeError(error)
          }
        });
        throw error;
      }
    };

    try {
      await runStage("navigate", async () => {
        await page.waitForSelector(selectors.thread_list, { timeout: 10_000 });
      }, {
        url: page.url()
      });
      await runStage("auth_check", async () => {
        await this.throwIfAuthRequired(page, "scanUnreadThreads:navigation");
        await this.throwIfAuthRequired(page, "scanUnreadThreads:thread_list");
      });
      const unreadFilterResult = await runStage("unread_filter", async () => {
        const result = await activateLinkedInUnreadFilter(page);
        await this.waitForUnreadListSettle(page, selectors);
        return result;
      });
      const collected = await runStage(
        "collect_threads",
        async () => this.collectThreadRowsWithScroll(page, selectors, this.deps.scanMaxThreads),
        {
          unreadFilterResult
        }
      );
      this.lastCollectionMetrics = {
        totalFound: collected.rows.length,
        unreadFound: collected.rows.filter((thread) => (thread.unreadCount ?? 0) > 0).length,
        iterations: collected.iterations,
        stopReason: collected.stopReason
      };
      return collected.rows
        .filter((thread) => (thread.unreadCount ?? 0) > 0)
        .map((thread) => ({ ...thread, isUnreadCandidate: true }));
    } catch (error) {
      const runtimeContext = await this.captureUnreadScanRuntimeContext(page, selectors).catch(() => undefined);
      const failureReason = resolveLinkedInScanFailureReason({
        message: error instanceof Error ? error.message : String(error),
        url: runtimeContext?.url ?? page.url(),
        overlayReason: runtimeContext?.overlayReason,
        threadListCount: runtimeContext?.threadListCount,
        threadItemCount: runtimeContext?.threadItemCount,
        spinnerCount: runtimeContext?.spinnerCount
      });

      if (error instanceof AdapterFailure) {
        error.details = {
          ...(error.details ?? {}),
          reason: failureReason,
          runtimeContext,
          stageReceipts
        };
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw await toStageFailure({
        platform: this.platform,
        stage: "collect_threads",
        message: "Failed while scanning LinkedIn unread threads",
        action: "scan-unread",
        error,
        kind: this.classifyFailureKind(errorMessage, "SELECTOR_MISMATCH"),
        page,
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir,
        details: {
          reason: failureReason,
          message: errorMessage,
          runtimeContext,
          stageReceipts
        }
      });
    }
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.navigateInbox(selectors);

    try {
      await this.throwIfAuthRequired(page, "fetchRecentThreads:navigation");
      await page.waitForSelector(selectors.thread_list, { timeout: 10_000 });
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
      return collected.rows.slice(0, limit).map((thread) => ({ ...thread, isRecentCandidate: true }));
    } catch (error) {
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
    }
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.navigateInbox(selectors);

    try {
      await this.throwIfAuthRequired(page, "fetchThreadMessages:navigation");
      await this.openThreadAndWaitForActivation(page, selectors, thread);
      await this.throwIfAuthRequired(page, "fetchThreadMessages:after_activation");
      await page.waitForSelector(selectors.message_container, { timeout: 15_000 });
      await this.throwIfAuthRequired(page, "fetchThreadMessages:after_container_wait");

      const messages = await this.collectThreadMessagesWithBackfill(page, selectors, limit);
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
    }
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
  }

  async openThread(thread: ThreadStub): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    await page.bringToFront();
    await this.openThreadAndWaitForActivation(page, selectors, thread);
  }

  async closeSession(_reason?: string): Promise<void> {
    await this.deps.sessionManager.closePlatformPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default"
    });
  }
}
