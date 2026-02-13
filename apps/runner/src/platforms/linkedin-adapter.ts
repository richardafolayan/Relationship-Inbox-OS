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
} from "./utils";
import type { AdapterFailureKind } from "./utils";
import type { BrowserProfileConfig } from "../config";
import { launchPersistentContextForPlatform } from "./browser-launch";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "./browser-launch";

interface LinkedInAdapterDependencies {
  profileDir: string;
  screenshotDir: string;
  domDumpDir: string;
  resolveSelectors: () => Promise<SelectorRegistry>;
  getSettings: () => Promise<AppSettings>;
  browserProfile: BrowserProfileConfig;
  onConnectStep?: (info: ConnectStepInfo) => Promise<void> | void;
  onPersonalProfileFallback?: (info: PersonalProfileFallbackInfo) => Promise<void> | void;
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
      // Retry once on a fresh tab in case the initial startup tab is stuck.
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

  private async scrapeThreadRows(page: Page, selectors: SelectorRegistry, limit: number): Promise<ThreadStub[]> {
    return page.evaluate(
      ({ selectors, limit }) => {
        const rows = Array.from(document.querySelectorAll(selectors.thread_item)).slice(0, limit);
        return rows.map((row, index) => {
          const anchors = Array.from(row.querySelectorAll("a[href]")) as HTMLAnchorElement[];
          const threadLink = anchors.find((anchor) => /\/messaging\//i.test(anchor.href)) ?? null;
          const parentItem = row.closest("li.msg-conversation-listitem") as HTMLElement | null;

          const name =
            row.querySelector("h3")?.textContent ||
            row.querySelector("span")?.textContent ||
            row.getAttribute("aria-label") ||
            `LinkedIn Thread ${index + 1}`;

          const preview =
            row.querySelector("p")?.textContent ||
            row.querySelector(".msg-conversation-card__message-snippet")?.textContent ||
            "";

          const timeText = row.querySelector("time")?.getAttribute("datetime") || row.querySelector("time")?.textContent || "";
          const unreadNode = row.querySelector(selectors.unread_badge);
          const unreadText = unreadNode?.textContent?.trim() || "";
          const unreadMatch = unreadText.match(/\d+/);
          const conversationCard = row.querySelector("[id^='conversation-card-']") as HTMLElement | null;
          const normalizedName = name.trim().toLowerCase();
          const fallbackKey = normalizedName
            ? `linkedin-name:${normalizedName}`
            : `linkedin-preview:${preview.trim().toLowerCase().slice(0, 120)}`;
          const platformThreadId =
            threadLink?.href ||
            row.getAttribute("data-id") ||
            parentItem?.getAttribute("data-id") ||
            fallbackKey ||
            conversationCard?.id ||
            row.getAttribute("id") ||
            parentItem?.id ||
            `linkedin-${index}`;

          return {
            platformThreadId,
            displayName: name.trim(),
            unreadCount: unreadMatch ? Number(unreadMatch[0]) : unreadNode ? 1 : 0,
            lastMessagePreview: preview.trim(),
            lastMessageAt: timeText,
            threadUrl: threadLink?.href || undefined,
            avatarUrl: (row.querySelector("img") as HTMLImageElement | null)?.src || undefined
          };
        });
      },
      { selectors, limit }
    );
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

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.navigateInbox(selectors);

    try {
      await this.throwIfAuthRequired(page, "scanUnreadThreads:navigation");
      await page.waitForSelector(selectors.thread_list, { timeout: 10000 });
      await this.throwIfAuthRequired(page, "scanUnreadThreads:thread_list");
      const rows = await this.scrapeThreadRows(page, selectors, 120);
      return rows
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
      await page.waitForSelector(selectors.thread_list, { timeout: 10000 });
      await this.throwIfAuthRequired(page, "fetchRecentThreads:thread_list");
      const rows = await this.scrapeThreadRows(page, selectors, limit);
      return rows.map((thread) => ({ ...thread, isRecentCandidate: true }));
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
    const page = await this.getPage();

    try {
      if (thread.threadUrl) {
        await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
        await this.throwIfAuthRequired(page, "fetchThreadMessages:thread_url");
      } else {
        await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
        await this.throwIfAuthRequired(page, "fetchThreadMessages:inbox_fallback");
        const row = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
        if ((await row.count()) > 0) {
          await row.click();
        }
      }

      await humanDelay();
      await this.throwIfAuthRequired(page, "fetchThreadMessages:before_container_wait");
      await page.waitForSelector(selectors.message_container, { timeout: 15000 });
      await this.throwIfAuthRequired(page, "fetchThreadMessages:after_container_wait");

      const messages = await page.evaluate(
        ({ selectors }) => {
          const nodes = Array.from(document.querySelectorAll(selectors.message_item));
          return nodes.map((node, index) => {
            const root = node as HTMLElement;
            const className = root.className || "";
            const inbound = /other|received|incoming/i.test(className);
            const text =
              root.querySelector(selectors.message_text)?.textContent ||
              root.textContent ||
              "";
            const timeNode = root.querySelector("time") as HTMLTimeElement | null;
            const timestamp = timeNode?.getAttribute("datetime") || timeNode?.textContent || new Date().toISOString();
            const attachmentCount = root.querySelectorAll("img, video, svg, a[download]").length;

            return {
              platformMessageKey: root.getAttribute("data-id") || root.getAttribute("id") || `li-msg-${index}`,
              direction: inbound ? "IN" : "OUT",
              timestamp,
              text,
              attachments: attachmentCount
                ? [{ type: "attachment", manualReview: true, rawLabel: `${attachmentCount} attachment(s)` }]
                : []
            };
          });
        },
        { selectors }
      );

      return messages.slice(-limit).map((msg) => ({
        ...msg,
        direction: msg.direction === "IN" ? "IN" : "OUT",
        timestamp: this.normalizeTimestamp(msg.timestamp),
        text: cleanText(msg.text)
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

  private async getLatestMessageSnapshot(page: Page, selectors: SelectorRegistry): Promise<{
    direction: "IN" | "OUT";
    timestamp: number;
    text: string;
  } | null> {
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

      await page.waitForSelector(selectors.message_container, { timeout: 12000 });
      const preSend = await this.getLatestMessageSnapshot(page, selectors);

      const composer = page.locator(selectors.composer_input).first();
      await composer.click({ timeout: 10000 });
      try {
        await composer.fill(text);
      } catch {
        await page.keyboard.press("Meta+A").catch(() => undefined);
        await page.keyboard.type(text, { delay: 12 });
      }

      await humanDelay(100, 300);
      await page.locator(selectors.send_button).first().click({ timeout: 10000 });

      const start = Date.now();
      let verifiedBy: VerificationMethod = "best_effort";

      while (Date.now() - start < 10000) {
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
}
