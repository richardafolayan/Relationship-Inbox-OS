import type { Page } from "patchright";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformName,
  SelectorRegistry,
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import { AdapterFailure, cleanMessageText, humanDelay, toStageFailure } from "./utils";
import { humanClick, humanType, readingPause } from "./humanize";
import type { SessionManager } from "../services/session-manager";

/**
 * Decide which inbox-row locator (if any) matched the target thread. Returns
 * `"title"` for a `span[title=...]` hit, `"text"` for a `hasText` hit, and
 * `null` when NEITHER matched. `null` means "do not open anything" — there is
 * deliberately NO first-row fallback: clicking whichever thread happens to be
 * first would open the wrong conversation, and the caller would then message or
 * scrape the wrong contact (bug H4).
 */
export function resolveBetaThreadMatch(input: {
  hasTitleMatch: boolean;
  hasTextMatch: boolean;
}): "title" | "text" | null {
  if (input.hasTitleMatch) {
    return "title";
  }
  if (input.hasTextMatch) {
    return "text";
  }
  return null;
}

/**
 * Whitespace/case-insensitive, bidirectional containment test between an opened
 * conversation's header text and the intended recipient's display name. Mirrors
 * the LinkedIn adapter's `normalizeIdentity` + `includes` identity match. Empty
 * inputs return `false` (cannot confirm a match), so the caller must decide
 * whether an empty/unscrapeable header is fatal.
 */
export function betaIdentityMatch(
  headerText: string | null | undefined,
  displayName: string | null | undefined
): boolean {
  const normalize = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const header = normalize(headerText);
  const target = normalize(displayName);
  if (!header || !target) {
    return false;
  }
  return header.includes(target) || target.includes(header);
}

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
        // The TikTok messages surface almost always contains the word
        // "messages", so the old `/log in/ && !/messages/` gate was inert (and
        // a rare false positive). Login detection now relies on the QR phrases
        // above and the /login URL match below.
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

  private async openThreadFromInbox(page: Page, selectors: SelectorRegistry, thread: ThreadStub): Promise<string> {
    await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
    await this.waitForInboxReady(page, selectors, 12000);

    const escapedName = this.escapeCssAttribute(thread.displayName);
    const byTitle = page
      .locator(`${selectors.thread_item} span[title="${escapedName}"]`)
      .first();
    const byText = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();

    const match = resolveBetaThreadMatch({
      hasTitleMatch: (await byTitle.count()) > 0,
      hasTextMatch: (await byText.count()) > 0
    });

    // No first-row fallback. Clicking whichever thread happens to be first would
    // open the WRONG conversation, and the caller (sendMessage / fetchThreadMessages)
    // would then message or scrape that contact. A name-miss is a hard failure so
    // the scan/send is routed as THREAD_NOT_FOUND instead of silently hitting
    // someone else (bug H4).
    if (!match) {
      throw new AdapterFailure(`${this.platform} thread not found in inbox`, {
        kind: "THREAD_NOT_FOUND",
        platform: this.platform,
        stage: "open_thread",
        platformThreadId: thread.platformThreadId,
        details: {
          targetDisplayName: thread.displayName,
          platformThreadId: thread.platformThreadId
        }
      });
    }

    await humanClick(page, match === "title" ? byTitle : byText, { timeout: 10000 });
    return thread.displayName;
  }

  private async readConversationHeaderText(page: Page, selectors: SelectorRegistry): Promise<string> {
    return page
      .evaluate(
        ({ messageContainer }) => {
          const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
          const header =
            (document.querySelector("header") as HTMLElement | null) ??
            (document.querySelector(`${messageContainer} header`) as HTMLElement | null);
          if (!header) {
            return "";
          }
          return (
            clean(header.querySelector("span[title]")?.getAttribute("title")) ||
            clean(header.querySelector("h1, h2, h3")?.textContent) ||
            clean(header.innerText)
          );
        },
        { messageContainer: selectors.message_container }
      )
      .catch(() => "");
  }

  private async verifyOpenedConversationMatches(
    page: Page,
    selectors: SelectorRegistry,
    thread: ThreadStub,
    expectedName: string
  ): Promise<void> {
    const target = expectedName || thread.displayName;
    if (!target) {
      return;
    }
    const headerText = await this.readConversationHeaderText(page, selectors);
    // Only fail on a POSITIVE mismatch: the header was scrapeable AND its name is
    // disjoint from the target. An empty/unscrapeable header is NOT treated as a
    // mismatch — IG/TikTok ship hashed, frequently-changing header markup, so a
    // strict requirement would block legitimate sends. The hard wrong-recipient
    // guarantee comes from the no-first-row-fallback throw above.
    if (headerText && !betaIdentityMatch(headerText, target)) {
      throw new AdapterFailure(`${this.platform} opened the wrong conversation`, {
        kind: "THREAD_NOT_FOUND",
        platform: this.platform,
        stage: "open_thread",
        platformThreadId: thread.platformThreadId,
        details: {
          targetDisplayName: target,
          actualHeaderText: headerText,
          platformThreadId: thread.platformThreadId
        }
      });
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
          // Identity must never depend on scroll position: the same thread at a
          // different index would otherwise get a new id and duplicate across
          // scrapes. When name and preview are both empty, fall back to the
          // row's own text rather than its index.
          const rowSignature = clean(row.textContent).toLowerCase().slice(0, 200);
          const stableKey = normalizedName
            ? `${platform.toLowerCase()}:name:${normalizedName}`
            : normalizedPreview
              ? `${platform.toLowerCase()}:preview:${normalizedPreview}`
              : `${platform.toLowerCase()}:row:${rowSignature || "empty"}`;

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
            // IG/TikTok ship hashed class names, so the inbound keyword test
            // usually misses. Check both directions explicitly and default the
            // ambiguous case to IN: this is an inbox of RECEIVED DMs, and
            // mislabeling an inbound message as OUT wrongly marks the thread as
            // "you replied last" and hides it from the needs-reply queue. The
            // safer error for an unread inbox is to over-surface (IN).
            const inboundClass = /other|left|incoming|received|partner/i.test(className);
            const outboundClass = /\bself\b|\bmine\b|outgoing|message-out|message--out/i.test(className);
            const direction = inboundClass ? "IN" : outboundClass ? "OUT" : "IN";
            const text = root.querySelector(selectors.message_text)?.textContent || root.textContent || "";
            const senderName =
              root.querySelector("[role='link']")?.textContent ||
              root.querySelector("h3, h4, strong")?.textContent ||
              undefined;
            const attachmentCount = root.querySelectorAll("img, video, svg, a[download]").length;
            return {
              platformMessageKey: root.getAttribute("data-id") || root.getAttribute("id") || `beta-${index}`,
              direction,
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
        text: cleanMessageText(msg.text),
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

  async sendMessage(thread: ThreadStub, text: string): Promise<SendReceipt> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();

    try {
      let expectedName = thread.displayName;
      if (thread.threadUrl) {
        await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
      } else {
        expectedName = await this.openThreadFromInbox(page, selectors, thread);
      }

      await this.waitForConversationReady(page, selectors);
      await this.throwIfAuthRequired(page, "sendMessage");
      // Guard against typing into the wrong thread: confirm the opened
      // conversation header matches the intended recipient before composing.
      await this.verifyOpenedConversationMatches(page, selectors, thread, expectedName);
      const composer = page.locator(selectors.composer_input).first();
      await humanClick(page, composer);
      await humanType(page, composer, text, { alreadyFocused: true, reading: null }).catch(async () => {
        await composer.fill(text).catch(async () => {
          await page.keyboard.type(text, { delay: 8 });
        });
      });

      await readingPause(700, 1800);
      const sendBtn = page.locator(selectors.send_button).first();
      await humanClick(page, sendBtn, { timeout: 10000, reading: null }).catch(async () => {
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
