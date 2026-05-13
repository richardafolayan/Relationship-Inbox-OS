import type { Page } from "playwright";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformName,
  SelectorRegistry,
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import { AdapterFailure, cleanText, humanDelay, toStageFailure } from "./utils";
import type { SessionManager } from "../services/session-manager";

interface BetaAdapterDependencies {
  platform: PlatformName;
  screenshotDir: string;
  domDumpDir: string;
  resolveSelectors: () => Promise<SelectorRegistry>;
  sessionManager: SessionManager;
  personKey?: string;
}

export class BetaAdapter implements PlatformAdapter {
  platform: PlatformName;

  constructor(private readonly deps: BetaAdapterDependencies) {
    this.platform = deps.platform;
  }

  private async getPage(): Promise<Page> {
    return this.deps.sessionManager.getManagedPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default"
    });
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

  private async detectAuthRequired(page: Page): Promise<{ authRequired: boolean; reason?: string; url: string }> {
    const url = page.url();
    const detection = await page.evaluate((platform) => {
      const bodyText = document.body?.innerText?.toLowerCase() ?? "";
      const has = (selector: string) => document.querySelector(selector) !== null;

      if (platform === "INSTAGRAM") {
        if (has("input[name='username']") || has("input[name='password']") || /log in to instagram/.test(bodyText)) {
          return { authRequired: true, reason: "instagram_login_form" };
        }
      }

      if (platform === "TIKTOK") {
        if (
          /log in with qr code/.test(bodyText) ||
          /scan with your mobile device/.test(bodyText) ||
          /confirm login or sign up/.test(bodyText)
        ) {
          return { authRequired: true, reason: "tiktok_qr_login" };
        }
        if (/log in/.test(bodyText) && !/messages/.test(bodyText)) {
          return { authRequired: true, reason: "tiktok_login_gate" };
        }
      }

      return { authRequired: false };
    }, this.platform);

    const urlAuthMatch =
      (this.platform === "INSTAGRAM" && /\/accounts\/login/i.test(url)) ||
      (this.platform === "TIKTOK" && /\/login/i.test(url));

    return {
      authRequired: detection.authRequired || urlAuthMatch,
      reason: detection.reason ?? (urlAuthMatch ? "url_auth_pattern" : undefined),
      url
    };
  }

  private async throwIfAuthRequired(page: Page, context: string): Promise<void> {
    const auth = await this.detectAuthRequired(page);
    if (!auth.authRequired) {
      return;
    }

    throw new AdapterFailure(`${this.platform} auth required`, {
      kind: "AUTH_REQUIRED",
      platform: this.platform,
      stage: "navigate",
      details: {
        context,
        reason: auth.reason ?? "unknown",
        url: auth.url
      }
    });
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
      await this.throwIfAuthRequired(page, "ensureConnected");
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      throw await toStageFailure({
        platform: this.platform,
        stage: "connect",
        message: `${this.platform} inbox selector missing`,
        action: "connect-failed",
        error,
        kind: "SELECTOR_MISMATCH",
        page,
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
    }
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
      await this.waitForInboxReady(page, selectors, 12000);
      await this.throwIfAuthRequired(page, "scanUnreadThreads");
      const rows = await this.scrapeThreads(page, selectors, 80);
      return rows.filter((thread) => (thread.unreadCount ?? 0) > 0).map((thread) => ({ ...thread, isUnreadCandidate: true }));
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      throw await toStageFailure({
        platform: this.platform,
        stage: "collect_threads",
        message: `${this.platform} unread scan failed`,
        action: "scan-unread",
        error,
        kind: "SELECTOR_MISMATCH",
        page,
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
    }
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
      await this.waitForInboxReady(page, selectors, 12000);
      await this.throwIfAuthRequired(page, "fetchRecentThreads");
      const rows = await this.scrapeThreads(page, selectors, limit);
      return rows.map((thread) => ({ ...thread, isRecentCandidate: true }));
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      throw await toStageFailure({
        platform: this.platform,
        stage: "collect_threads",
        message: `${this.platform} recent scan failed`,
        action: "scan-recent",
        error,
        kind: "SELECTOR_MISMATCH",
        page,
        screenshotDir: this.deps.screenshotDir,
        domDumpDir: this.deps.domDumpDir
      });
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
      await this.throwIfAuthRequired(page, "fetchThreadMessages");
      const messages = await page.evaluate(
        ({ selectors }) => {
          const container =
            (document.querySelector(selectors.message_container) as HTMLElement | null) ??
            (document.querySelector("main, div[role='main']") as HTMLElement | null) ??
            document.body;
          const nodes = Array.from(container.querySelectorAll(selectors.message_item));
          return nodes.map((node, index) => {
            const root = node as HTMLElement;
            const className = root.className || "";
            // Token-boundary match on inbound classnames — previously
            // `/other|left|incoming|receive/i` matched any substring
            // including unrelated tokens (`brother`, `received-icon`,
            // `relevant`). Anchor at word boundaries so a future class
            // rename doesn't silently invert direction.
            const inbound = /\b(other|left|incoming|received?|incoming-bubble)\b/i.test(className);
            const text = root.querySelector(selectors.message_text)?.textContent || root.textContent || "";
            const senderName =
              root.querySelector("[role='link']")?.textContent ||
              root.querySelector("h3, h4, strong")?.textContent ||
              undefined;
            const attachmentCount = root.querySelectorAll("img, video, svg, a[download]").length;
            return {
              platformMessageKey: root.getAttribute("data-id") || root.getAttribute("id") || `beta-${index}`,
              direction: inbound ? "IN" : "OUT",
              // Beta IG/TikTok scrapers don't parse the per-message timestamp
              // out of the DOM yet (relative-time strings like "5m"/"2d" + a
              // hover-only datetime attribute that varies per layout). Omit
              // the field so scan-queue stamps each NEW message with first-seen
              // time and leaves existing rows alone — avoids the bug where
              // every scrape advanced every message to "now" and inflated
              // freshness across the inbox (issue #245).
              timestamp: undefined,
              text,
              senderName: senderName?.trim() || undefined,
              raw: {
                className,
                attachmentCount
              },
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
        text: cleanText(msg.text),
        senderName: msg.senderName,
        raw: msg.raw
      }));
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      throw await toStageFailure({
        platform: this.platform,
        stage: "parse",
        message: `${this.platform} fetch thread failed`,
        action: "fetch-thread",
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

  async sendMessage(
    thread: ThreadStub,
    text: string,
    attachments?: Array<{ absolutePath: string; displayName: string; mimeType?: string; kind?: string }>
  ): Promise<SendReceipt> {
    // The Beta adapter (Instagram / TikTok) ships text only — the web
    // composers don't have a stable file-attach affordance the runner can
    // drive without per-platform UI scripting. Previously the parameter was
    // missing entirely, which meant `send.ts:248` silently dropped any
    // attachments without telling the caller. Throw so the operator sees a
    // clear FAILED row instead of a "sent text only" surprise.
    if (attachments && attachments.length > 0) {
      throw new Error(
        `${this.platform} adapter does not support attachments yet (got ${attachments.length}). Send text only or use the iMessage / LinkedIn adapter.`
      );
    }
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      if (thread.threadUrl) {
        await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
      } else {
        await this.openThreadFromInbox(page, selectors, thread);
      }

      await this.waitForConversationReady(page, selectors);
      await this.throwIfAuthRequired(page, "sendMessage");
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
      if (error instanceof AdapterFailure) {
        throw error;
      }
      throw await toStageFailure({
        platform: this.platform,
        stage: "persist",
        message: `${this.platform} send failed`,
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

    if (thread.threadUrl) {
      await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
    } else {
      await this.openThreadFromInbox(page, selectors, thread);
    }
    await this.throwIfAuthRequired(page, "openThread");
  }

  async closeSession(_reason?: string): Promise<void> {
    await this.deps.sessionManager.closePlatformPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default"
    });
  }
}
