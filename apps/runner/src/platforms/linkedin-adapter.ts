import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type {
  AppSettings,
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
  captureDiagnostics,
  humanDelay,
  inferAdapterFailureKindFromMessage
} from "./utils.js";
import type { AdapterFailureKind } from "./utils.js";
import type { BrowserProfileConfig } from "../config.js";
import { launchPersistentContextForPlatform } from "./browser-launch.js";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "./browser-launch.js";

interface LinkedInAdapterDependencies {
  profileDir: string;
  screenshotDir: string;
  domDumpDir: string;
  resolveSelectors: () => Promise<SelectorRegistry>;
  getSettings: () => Promise<AppSettings>;
  browserProfile: BrowserProfileConfig;
  scanMaxThreads: number;
  scanStableIterations: number;
  scanScrollWaitMs: number;
  messageBackfillAttempts: number;
  onConnectStep?: (info: ConnectStepInfo) => Promise<void> | void;
  onPersonalProfileFallback?: (info: PersonalProfileFallbackInfo) => Promise<void> | void;
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
}

interface LinkedInMessageSnapshot {
  platformMessageKey: string;
  direction: "IN" | "OUT";
  timestamp: string;
  text: string;
  attachments: Array<{ type: string; manualReview: boolean; rawLabel?: string }>;
}

interface ActiveThreadDescriptor {
  threadUrl?: string;
  activeKey?: string;
  displayName?: string;
}

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

export class LinkedInAdapter implements PlatformAdapter {
  platform = "LINKEDIN" as const;

  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private static readonly inboxNavigationTimeoutMs = 10_000;
  private static readonly inboxReadyTimeoutMs = 10_000;

  constructor(private readonly deps: LinkedInAdapterDependencies) {}

  private async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    const settings = await this.deps.getSettings();
    this.context = await launchPersistentContextForPlatform({
      platform: this.platform,
      launchPersistentContext: (userDataDir, options) =>
        chromium.launchPersistentContext(userDataDir, options),
      isolatedProfileDir: this.deps.profileDir,
      headless: settings.headless,
      browserProfile: this.deps.browserProfile,
      args: ["--disable-blink-features=AutomationControlled"],
      onConnectStep: this.deps.onConnectStep,
      onPersonalProfileFallback: this.deps.onPersonalProfileFallback
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  private async navigateInbox(selectors: SelectorRegistry): Promise<Page> {
    const page = await this.getPage();

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

    try {
      await navigate(page);
      return page;
    } catch {
      if (!this.context) {
        throw new Error("LinkedIn browser context unavailable while navigating inbox");
      }

      const retryPage = await this.context.newPage();
      this.page = retryPage;
      await navigate(retryPage);
      return retryPage;
    }
  }

  private classifyFailureKind(reason: string, fallback: AdapterFailureKind): AdapterFailureKind {
    return inferAdapterFailureKindFromMessage(reason) ?? fallback;
  }

  private normalizeTimestamp(rawValue: string | undefined): string {
    if (!rawValue) {
      return new Date().toISOString();
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
      return new Date().toISOString();
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }

    return new Date().toISOString();
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
      details: {
        context,
        url: authState.url,
        detection: authState.source ?? "unknown"
      }
    });
  }

  private async collectThreadRowsWithScroll(
    page: Page,
    selectors: SelectorRegistry,
    maxThreads: number
  ): Promise<{ rows: ThreadStub[]; iterations: number }> {
    const cappedMaxThreads = Math.max(1, maxThreads);
    const stableIterationsTarget = Math.max(1, this.deps.scanStableIterations);
    const merged = new Map<string, ThreadStub>();

    let noGrowthIterations = 0;
    let trailingRepeatIterations = 0;
    let previousTrailingKey: string | null = null;
    let iterations = 0;

    while (iterations < 300) {
      iterations += 1;
      const iteration = await page.evaluate(
        ({ selectors }) => {
          const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
          const truncate = (value: string, max = 220): string => value.slice(0, max);

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

          const list = document.querySelector(selectors.thread_list) as HTMLElement | null;
          const scrollContainer = findScrollableContainer(list) ?? list;

          const nodes = Array.from(document.querySelectorAll(selectors.thread_item));
          const rows = nodes.map((node, index) => {
            const rowRoot =
              (node.closest("li.msg-conversation-listitem") as HTMLElement | null) ??
              (node.closest("[data-conversation-urn], [data-urn], [data-conversation-id], [data-id]") as HTMLElement | null) ??
              (node as HTMLElement);
            const link =
              (rowRoot.querySelector("a[href*='/messaging/']") as HTMLAnchorElement | null) ??
              (node.querySelector("a[href*='/messaging/']") as HTMLAnchorElement | null);

            const displayName = clean(
              rowRoot.querySelector("h3 span.truncate")?.textContent ??
                rowRoot.querySelector("h3")?.textContent ??
                rowRoot.querySelector("span[title]")?.getAttribute("title") ??
                rowRoot.getAttribute("aria-label") ??
                ""
            );
            const preview = truncate(
              clean(
                rowRoot.querySelector(".msg-conversation-card__message-snippet")?.textContent ??
                  rowRoot.querySelector("p")?.textContent ??
                  ""
              )
            );
            const lastMessageAt = clean(
              rowRoot.querySelector("time")?.getAttribute("datetime") ??
                rowRoot.querySelector("time")?.textContent ??
                ""
            );
            const unreadBadge = rowRoot.querySelector(selectors.unread_badge);
            const unreadText = clean(unreadBadge?.textContent ?? "");
            const unreadMatch = unreadText.match(/\d+/);
            const unreadCount = unreadMatch ? Number(unreadMatch[0]) : unreadBadge ? 1 : 0;

            const attrKeys = [
              rowRoot.getAttribute("data-conversation-urn"),
              rowRoot.getAttribute("data-urn"),
              rowRoot.getAttribute("data-conversation-id"),
              rowRoot.getAttribute("data-id"),
              rowRoot.id
            ].filter((value): value is string => Boolean(value && value.trim()));

            const href = link?.href?.trim() || "";
            const fallbackKey = displayName
              ? `linkedin-name:${displayName.toLowerCase()}`
              : `linkedin-preview:${preview.toLowerCase() || index}`;
            const stableKey = (attrKeys[0] ?? href) || fallbackKey;

            return {
              stableKey,
              displayName: displayName || `LinkedIn Thread ${index + 1}`,
              unreadCount,
              lastMessagePreview: preview,
              lastMessageAt: lastMessageAt || undefined,
              threadUrl: href || undefined,
              avatarUrl: (rowRoot.querySelector("img") as HTMLImageElement | null)?.src || undefined
            };
          });

          const beforeTop = scrollContainer?.scrollTop ?? 0;
          const maxTop = scrollContainer ? Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight) : 0;
          if (scrollContainer) {
            const jump = Math.max(120, Math.floor(scrollContainer.clientHeight * 0.85));
            scrollContainer.scrollTop = Math.min(maxTop, beforeTop + jump);
          }
          const afterTop = scrollContainer?.scrollTop ?? beforeTop;
          const didScroll = afterTop > beforeTop + 1;
          const reachedBottom = scrollContainer ? afterTop >= maxTop - 1 : true;
          const trailingKey = rows.at(-1)?.stableKey ?? null;

          return {
            rows,
            trailingKey,
            didScroll,
            reachedBottom
          } satisfies LinkedInThreadCollectionIteration;
        },
        { selectors }
      );

      const previousCount = merged.size;
      for (const row of iteration.rows) {
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
        nextTrailingKey: iteration.trailingKey,
        noGrowthIterations,
        trailingRepeatIterations
      });

      noGrowthIterations = stability.noGrowthIterations;
      trailingRepeatIterations = stability.trailingRepeatIterations;
      previousTrailingKey = iteration.trailingKey;

      if (
        shouldStopLinkedInCollection({
          uniqueCount: nextCount,
          maxThreads: cappedMaxThreads,
          noGrowthIterations,
          trailingRepeatIterations,
          stableIterations: stableIterationsTarget,
          didScroll: iteration.didScroll,
          reachedBottom: iteration.reachedBottom
        })
      ) {
        break;
      }

      await page.waitForTimeout(this.deps.scanScrollWaitMs);
    }

    return {
      rows: Array.from(merged.values()).slice(0, cappedMaxThreads),
      iterations
    };
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

      const row = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
      if ((await row.count()) === 0) {
        throw new AdapterFailure(`Unable to locate LinkedIn thread row for ${thread.displayName}`, {
          kind: "THREAD_FETCH_FAILED",
          details: {
            targetDisplayName: thread.displayName,
            platformThreadId: thread.platformThreadId
          }
        });
      }

      await row.click({ timeout: 10_000 });
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
            const inbound = /other|received|incoming/i.test(className);
            const text = clean(
              root.querySelector(selectors.message_text)?.textContent ??
                root.textContent ??
                ""
            );
            const timeNode = root.querySelector("time") as HTMLTimeElement | null;
            const timestamp =
              clean(timeNode?.getAttribute("datetime")) ||
              clean(timeNode?.textContent) ||
              new Date().toISOString();
            const attachmentCount = root.querySelectorAll("img, video, svg, a[download], a[href*='attachment']").length;
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

      const files =
        page &&
        (await captureDiagnostics({
          page,
          platform: this.platform,
          action: "connect-failed",
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir
        }));

      const reason = error instanceof Error ? error.message : String(error);
      const currentUrl = page?.url();
      const suffix = currentUrl ? ` (url: ${currentUrl})` : "";
      throw new AdapterFailure(`LinkedIn connect failed (${reason})${suffix}`, {
        kind: this.classifyFailureKind(reason, "SELECTOR_MISMATCH"),
        screenshotFile: files?.screenshotFile,
        domDumpFile: files?.domDumpFile,
        details: currentUrl ? { url: currentUrl } : undefined
      });
    }
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.navigateInbox(selectors);

    try {
      await this.throwIfAuthRequired(page, "scanUnreadThreads:navigation");
      await page.waitForSelector(selectors.thread_list, { timeout: 10_000 });
      await this.throwIfAuthRequired(page, "scanUnreadThreads:thread_list");
      const collected = await this.collectThreadRowsWithScroll(page, selectors, this.deps.scanMaxThreads);
      return collected.rows
        .filter((thread) => (thread.unreadCount ?? 0) > 0)
        .map((thread) => ({ ...thread, isUnreadCandidate: true }));
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }

      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "scan-unread",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });

      const reason = error instanceof Error ? error.message : String(error);
      throw new AdapterFailure("Failed while scanning LinkedIn unread threads", {
        kind: this.classifyFailureKind(reason, "SELECTOR_MISMATCH"),
        screenshotFile: files.screenshotFile,
        domDumpFile: files.domDumpFile
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
      return collected.rows.slice(0, limit).map((thread) => ({ ...thread, isRecentCandidate: true }));
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }

      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "scan-recent",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });

      const reason = error instanceof Error ? error.message : String(error);
      throw new AdapterFailure("Failed while scanning LinkedIn recent threads", {
        kind: this.classifyFailureKind(reason, "SELECTOR_MISMATCH"),
        screenshotFile: files.screenshotFile,
        domDumpFile: files.domDumpFile
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
      return messages.map((message) => ({
        ...message,
        direction: message.direction === "IN" ? "IN" : "OUT",
        timestamp: this.normalizeTimestamp(message.timestamp),
        text: cleanText(message.text)
      }));
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }

      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "fetch-thread",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });

      throw new AdapterFailure(`Failed to fetch LinkedIn thread messages for ${thread.displayName}`, {
        kind: "THREAD_FETCH_FAILED",
        screenshotFile: files.screenshotFile,
        domDumpFile: files.domDumpFile,
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
        const row = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
        if ((await row.count()) > 0) {
          await row.click();
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
    } catch {
      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "send",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });

      throw new AdapterFailure(`Failed to send LinkedIn message for ${thread.displayName}`, files);
    }
  }

  async openThread(thread: ThreadStub): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    await page.bringToFront();

    if (thread.threadUrl) {
      await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
      return;
    }

    await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
    const row = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
    if ((await row.count()) > 0) {
      await row.click();
    }
  }

  async closeSession(_reason?: string): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;

    if (!context) {
      return;
    }

    await context.close().catch(() => undefined);
  }
}
