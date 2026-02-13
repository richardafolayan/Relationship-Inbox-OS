import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type {
  AppSettings,
  NormalizedMessage,
  PlatformAdapter,
  PlatformName,
  SelectorRegistry,
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import { AdapterFailure, captureDiagnostics, cleanText, humanDelay } from "./utils";
import type { BrowserProfileConfig } from "../config";
import { launchPersistentContextForPlatform } from "./browser-launch";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "./browser-launch";

interface BetaAdapterDependencies {
  platform: PlatformName;
  profileDir: string;
  screenshotDir: string;
  domDumpDir: string;
  resolveSelectors: () => Promise<SelectorRegistry>;
  getSettings: () => Promise<AppSettings>;
  browserProfile: BrowserProfileConfig;
  onConnectStep?: (info: ConnectStepInfo) => Promise<void> | void;
  onPersonalProfileFallback?: (info: PersonalProfileFallbackInfo) => Promise<void> | void;
}

export class BetaAdapter implements PlatformAdapter {
  platform: PlatformName;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly deps: BetaAdapterDependencies) {
    this.platform = deps.platform;
  }

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
      onConnectStep: this.deps.onConnectStep,
      onPersonalProfileFallback: this.deps.onPersonalProfileFallback
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  private escapeCssAttribute(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private async waitForInboxReady(page: Page, selectors: SelectorRegistry, timeout: number): Promise<void> {
    try {
      await page.waitForSelector(selectors.thread_list, { timeout });
      return;
    } catch {
      await page.waitForFunction(
        ({ threadItem, messageContainer }) => {
          if (!window.location.pathname.includes("/direct") && !window.location.pathname.includes("/messages")) {
            return false;
          }

          if (document.querySelector(threadItem)) {
            return true;
          }

          if (document.querySelector("input[placeholder='Search'], input[aria-label='Search']")) {
            return true;
          }

          return Boolean(document.querySelector(messageContainer));
        },
        { threadItem: selectors.thread_item, messageContainer: selectors.message_container },
        { timeout }
      );
    }
  }

  private async openThreadFromInbox(page: Page, selectors: SelectorRegistry, thread: ThreadStub): Promise<void> {
    await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
    await this.waitForInboxReady(page, selectors, 12000);

    const escapedName = this.escapeCssAttribute(thread.displayName);
    const byTitle = page
      .locator(`${selectors.thread_item} span[title="${escapedName}"]`)
      .first();

    if ((await byTitle.count()) > 0) {
      await byTitle.click({ timeout: 10000 });
      return;
    }

    const byText = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
    if ((await byText.count()) > 0) {
      await byText.click({ timeout: 10000 });
      return;
    }

    const byFallback = page.locator(selectors.thread_item).first();
    if ((await byFallback.count()) > 0) {
      await byFallback.click({ timeout: 10000 });
    }
  }

  private async waitForConversationReady(page: Page, selectors: SelectorRegistry): Promise<void> {
    await Promise.race([
      page.waitForSelector(selectors.message_item, { timeout: 12000 }).catch(() => undefined),
      page.waitForSelector(selectors.composer_input, { timeout: 12000 }).catch(() => undefined),
      page.waitForSelector(selectors.message_container, { timeout: 12000 }).catch(() => undefined)
    ]);
  }

  private async scrapeThreads(page: Page, selectors: SelectorRegistry, limit: number): Promise<ThreadStub[]> {
    return page.evaluate(
      ({ selectors, limit, platform }) => {
        const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

        const rows = Array.from(document.querySelectorAll(selectors.thread_item)).slice(0, limit);
        return rows.map((row, index) => {
          const link = row.querySelector("a") as HTMLAnchorElement | null;
          const nameFromTitle = row.querySelector("span[title]")?.getAttribute("title");
          const spanTexts = Array.from(row.querySelectorAll("span"))
            .map((node) => clean(node.textContent))
            .filter(Boolean);

          const nameCandidate =
            clean(nameFromTitle) ||
            clean(row.querySelector("h3")?.textContent) ||
            clean(row.getAttribute("aria-label")) ||
            spanTexts.find((value) => value.length > 1 && !/^unread$/i.test(value)) ||
            `${platform} Thread ${index + 1}`;

          const displayName = clean(nameCandidate);

          const previewCandidates = [
            clean(row.querySelector("p")?.textContent),
            ...Array.from(row.querySelectorAll("span[dir='auto']")).map((node) => clean(node.textContent)),
            ...spanTexts
          ].filter(Boolean);

          const preview =
            previewCandidates.find((value) => {
              if (!value || value === displayName) {
                return false;
              }
              if (/^unread$/i.test(value)) {
                return false;
              }
              if (/^\d+\s*[smhdwy]$/i.test(value)) {
                return false;
              }
              return true;
            }) || "";

          const unreadNode = row.querySelector(selectors.unread_badge);
          const unreadText = clean(unreadNode?.textContent);
          const unreadMatch = unreadText.match(/\d+/);
          const normalizedName = displayName.toLowerCase().slice(0, 120);
          const normalizedPreview = preview.toLowerCase().slice(0, 160);
          const stableKey = normalizedName
            ? `${platform.toLowerCase()}:name:${normalizedName}`
            : `${platform.toLowerCase()}:preview:${normalizedPreview || index}`;

          return {
            platformThreadId: link?.href || row.getAttribute("data-id") || row.getAttribute("id") || stableKey,
            displayName,
            unreadCount: unreadMatch ? Number(unreadMatch[0]) : unreadNode ? 1 : 0,
            lastMessagePreview: preview.slice(0, 220),
            threadUrl: link?.href || undefined
          };
        });
      },
      { selectors, limit, platform: this.platform }
    );
  }

  async ensureConnected(): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
      await this.waitForInboxReady(page, selectors, 20000);
    } catch (error) {
      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "connect-failed",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
      const reason = error instanceof Error ? error.message : String(error);
      throw new AdapterFailure(`${this.platform} inbox selector missing (${reason})`, files);
    }
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
      await this.waitForInboxReady(page, selectors, 12000);
      const rows = await this.scrapeThreads(page, selectors, 80);
      return rows.filter((thread) => (thread.unreadCount ?? 0) > 0).map((thread) => ({ ...thread, isUnreadCandidate: true }));
    } catch (error) {
      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "scan-unread",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
      const reason = error instanceof Error ? error.message : String(error);
      throw new AdapterFailure(`${this.platform} unread scan failed (${reason})`, files);
    }
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
      await this.waitForInboxReady(page, selectors, 12000);
      const rows = await this.scrapeThreads(page, selectors, limit);
      return rows.map((thread) => ({ ...thread, isRecentCandidate: true }));
    } catch (error) {
      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "scan-recent",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
      const reason = error instanceof Error ? error.message : String(error);
      throw new AdapterFailure(`${this.platform} recent scan failed (${reason})`, files);
    }
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      if (thread.threadUrl) {
        await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
      } else {
        await this.openThreadFromInbox(page, selectors, thread);
      }

      await this.waitForConversationReady(page, selectors);
      const messages = await page.evaluate(
        ({ selectors }) => {
          const nodes = Array.from(document.querySelectorAll(selectors.message_item));
          return nodes.map((node, index) => {
            const root = node as HTMLElement;
            const className = root.className || "";
            const inbound = /other|left|incoming|receive/i.test(className);
            const text = root.querySelector(selectors.message_text)?.textContent || root.textContent || "";
            const attachmentCount = root.querySelectorAll("img, video, svg, a[download]").length;
            return {
              platformMessageKey: root.getAttribute("data-id") || root.getAttribute("id") || `beta-${index}`,
              direction: inbound ? "IN" : "OUT",
              timestamp: new Date().toISOString(),
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
        text: cleanText(msg.text)
      }));
    } catch (error) {
      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "fetch-thread",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
      const reason = error instanceof Error ? error.message : String(error);
      throw new AdapterFailure(`${this.platform} fetch thread failed (${reason})`, files);
    }
  }

  async sendMessage(thread: ThreadStub, text: string): Promise<SendReceipt> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      if (thread.threadUrl) {
        await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
      } else {
        await this.openThreadFromInbox(page, selectors, thread);
      }

      await this.waitForConversationReady(page, selectors);
      const composer = page.locator(selectors.composer_input).first();
      await composer.click();
      await composer.fill(text).catch(async () => {
        await page.keyboard.type(text, { delay: 8 });
      });

      await humanDelay(100, 250);
      await page.locator(selectors.send_button).first().click({ timeout: 10000 }).catch(async () => {
        await page.keyboard.press("Enter");
      });

      return {
        sentAt: new Date().toISOString(),
        verifiedBy: "best_effort"
      };
    } catch (error) {
      const files = await captureDiagnostics({
        page,
        platform: this.platform,
        action: "send",
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
      const reason = error instanceof Error ? error.message : String(error);
      throw new AdapterFailure(`${this.platform} send failed (${reason})`, files);
    }
  }

  async openThread(thread: ThreadStub): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    await page.bringToFront();

    if (thread.threadUrl) {
      await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
    } else {
      await this.openThreadFromInbox(page, selectors, thread);
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
