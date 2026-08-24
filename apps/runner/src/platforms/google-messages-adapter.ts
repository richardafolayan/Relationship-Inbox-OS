import type { Page } from "patchright";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  AttachmentPlaceholder,
  NormalizedMessage,
  OutboundAttachment,
  PlatformAdapter,
  PlatformName,
  SelectorRegistry,
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import { BOUNDED_COLLECTION_BOUNDARY } from "./collection-boundary";
import type { SessionManager } from "../services/session-manager";
import { AdapterFailure, cleanMessageText, toStageFailure } from "./utils";

const PLATFORM: PlatformName = "GOOGLE_MESSAGES";

export interface GoogleMessagesAdapterDeps {
  screenshotDir: string;
  domDumpDir: string;
  mediaDir: string;
  resolveSelectors: () => Promise<SelectorRegistry>;
  sessionManager: SessionManager;
  personKey?: string;
}

export function googleMessagesThreadId(url: string): string {
  const match = url.match(/\/web\/conversations\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : url;
}

export function googleMessagesDirection(input: {
  className?: string;
  ariaLabel?: string;
  dataDirection?: string;
}): "IN" | "OUT" {
  const value = `${input.className ?? ""} ${input.ariaLabel ?? ""} ${input.dataDirection ?? ""}`;
  if (/\b(outgoing|sent|from-me|mine|self)\b|\byou\s*:/i.test(value)) return "OUT";
  return "IN";
}

export function googleMessagesTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function googleMessagesSenderName(ariaLabel: string, direction: "IN" | "OUT"): string | undefined {
  if (direction === "OUT") return undefined;
  const match = ariaLabel.match(/^([^:]{1,80}):\s/);
  const name = match?.[1]?.trim();
  return name && !/^(message|received|incoming)$/i.test(name) ? name : undefined;
}

export function googleMessagesReactions(labels: string[]): Array<{
  emoji: string;
  kind: "reaction";
  direction: "IN" | "OUT";
}> {
  return labels.flatMap((label) => {
    const emoji = label.match(/\p{Extended_Pictographic}(?:\uFE0F)?/u)?.[0];
    if (!emoji) return [];
    return [{
      emoji,
      kind: "reaction" as const,
      direction: /\byou\b/i.test(label) ? "OUT" as const : "IN" as const
    }];
  });
}

export class GoogleMessagesAdapter implements PlatformAdapter {
  readonly platform: PlatformName = PLATFORM;
  readonly collectionBoundary = BOUNDED_COLLECTION_BOUNDARY;

  constructor(private readonly deps: GoogleMessagesAdapterDeps) {}

  private async getPage(): Promise<Page> {
    return this.deps.sessionManager.getManagedPage({
      platform: PLATFORM,
      personKey: this.deps.personKey ?? "default"
    });
  }

  private async selectors(): Promise<SelectorRegistry> {
    return this.deps.resolveSelectors();
  }

  private async assertConnected(page: Page, selectors: SelectorRegistry): Promise<void> {
    const connected = await page
      .evaluate(({ threadItem, messageContainer }) => {
        const text = document.body?.innerText?.toLowerCase() ?? "";
        const welcome = location.pathname.includes("/welcome") || /welcome to google messages/.test(text);
        const signIn = welcome || (/sign in/.test(text) && !document.querySelector(threadItem));
        return {
          connected: Boolean(document.querySelector(threadItem) || document.querySelector(messageContainer)) && !signIn,
          signIn
        };
      }, { threadItem: selectors.thread_item, messageContainer: selectors.message_container })
      .catch(() => ({ connected: false, signIn: true }));
    if (connected.connected) return;
    throw new AdapterFailure("Google Messages sign in and phone pairing required", {
      kind: "AUTH_REQUIRED",
      platform: PLATFORM,
      stage: "connect",
      details: { url: page.url(), signIn: connected.signIn }
    });
  }

  private async openInbox(page: Page, selectors: SelectorRegistry): Promise<void> {
    await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
    await Promise.race([
      page.waitForSelector(selectors.thread_item, { timeout: 15_000 }),
      page.waitForSelector(selectors.message_container, { timeout: 15_000 }),
      page.waitForURL(/\/web\/welcome|accounts\.google\.com/, { timeout: 15_000 })
    ]).catch(() => undefined);
    await this.assertConnected(page, selectors);
  }

  private async scrapeThreads(page: Page, selectors: SelectorRegistry, limit: number): Promise<ThreadStub[]> {
    const rows = await page.evaluate(
      ({ selectors: s, limit: rowLimit }) => {
        const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        return Array.from(document.querySelectorAll(s.thread_item)).slice(0, rowLimit).map((node, index) => {
          const root = node as HTMLElement;
          const link = (root.matches("a") ? root : root.querySelector("a[href*='/web/conversations/']")) as HTMLAnchorElement | null;
          const href = link?.href ?? root.getAttribute("data-href") ?? "";
          const labelled = clean(root.getAttribute("aria-label"));
          const title = clean(root.querySelector("[title]")?.getAttribute("title"));
          const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,[class*='name'],[class*='title']"))
            .map((entry) => clean(entry.textContent))
            .filter(Boolean);
          const lines = root.innerText.split(/\n+/).map(clean).filter(Boolean);
          const displayName = title || headings[0] || lines[0] || labelled || `Android conversation ${index + 1}`;
          const snippetNode = root.querySelector(s.thread_snippet ?? "[class*='snippet']");
          const snippet = clean(snippetNode?.textContent) || lines.find((line) => line !== displayName) || "";
          const unread = Boolean(root.querySelector(s.unread_badge)) || /\bunread\b/i.test(`${labelled} ${root.className}`);
          const timeNode = root.querySelector("time,[datetime],[title*='202'],[aria-label*=' at ']");
          return {
            platformThreadId: href || root.getAttribute("data-conversation-id") || root.id || `google-messages-row-${index}`,
            displayName,
            unreadCount: unread ? 1 : 0,
            lastMessagePreview: snippet.slice(0, 220),
            lastMessageAt: timeNode?.getAttribute("datetime") || timeNode?.getAttribute("title") || undefined,
            threadUrl: href || undefined,
            isGroup: /\bparticipants?\b|\bgroup\b/i.test(labelled)
          };
        });
      },
      { selectors, limit }
    );
    return rows.map((row) => ({
      ...row,
      platformThreadId: googleMessagesThreadId(row.platformThreadId),
      lastMessageAt: googleMessagesTimestamp(row.lastMessageAt)
    }));
  }

  private async openConversation(page: Page, selectors: SelectorRegistry, thread: ThreadStub): Promise<void> {
    if (thread.threadUrl) {
      await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
    } else {
      await this.openInbox(page, selectors);
      const row = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
      if ((await row.count()) === 0) {
        throw new AdapterFailure("Google Messages conversation not found", {
          kind: "THREAD_NOT_FOUND",
          platform: PLATFORM,
          stage: "open_thread",
          platformThreadId: thread.platformThreadId
        });
      }
      await row.click();
    }
    await page.waitForSelector(selectors.message_container, { timeout: 15_000 });
    await this.assertConnected(page, selectors);
  }

  private async captureMedia(
    page: Page,
    messageKey: string,
    media: Array<{ src: string; tag: string; label: string }>
  ): Promise<AttachmentPlaceholder[]> {
    const captured: AttachmentPlaceholder[] = [];
    await mkdir(this.deps.mediaDir, { recursive: true });
    for (const [index, item] of media.entries()) {
      if (!item.src) continue;
      const resolvedSrc = item.src.startsWith("blob:") ? item.src : new URL(item.src, page.url()).href;
      const response = resolvedSrc.startsWith("blob:")
        ? null
        : await page.request.get(resolvedSrc).catch(() => null);
      const blobPayload = resolvedSrc.startsWith("blob:")
        ? await page.evaluate(async (src) => {
            const response = await fetch(src);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > 25 * 1024 * 1024) return null;
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 32_768) {
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
            }
            return { base64: btoa(binary), contentType: response.headers.get("content-type") ?? "" };
          }, resolvedSrc).catch(() => null)
        : null;
      const payload = response?.ok()
        ? await response.body()
        : blobPayload
          ? Buffer.from(blobPayload.base64, "base64")
          : null;
      if (!payload || payload.byteLength > 25 * 1024 * 1024) continue;
      const contentType = (response?.headers()["content-type"] ?? blobPayload?.contentType ?? "").split(";")[0] ?? "";
      const kind: AttachmentPlaceholder["kind"] = contentType.startsWith("image/")
        ? "photo"
        : contentType.startsWith("video/")
          ? "video"
          : contentType.startsWith("audio/")
            ? "audio"
            : contentType === "application/pdf"
              ? "pdf"
              : item.tag === "IMG"
                ? "photo"
                : item.tag === "VIDEO"
                  ? "video"
                  : item.tag === "AUDIO"
                    ? "audio"
                    : "unknown";
      const urlExt = resolvedSrc.startsWith("blob:") ? "" : extname(new URL(resolvedSrc).pathname).slice(0, 10);
      const defaultExtensions: Record<string, string> = { photo: ".jpg", video: ".mp4", audio: ".m4a", pdf: ".pdf" };
      const extension = urlExt || defaultExtensions[kind ?? "unknown"] || ".bin";
      const guid = `${createHash("sha256").update(`${messageKey}:${index}:${item.src}`).digest("hex")}${extension}`;
      await writeFile(join(this.deps.mediaDir, guid), payload);
      captured.push({
        type: contentType || "media",
        kind,
        guid,
        byteSize: payload.byteLength,
        manualReview: false,
        rawLabel: item.label || undefined
      });
    }
    return captured;
  }

  async ensureConnected(): Promise<void> {
    const selectors = await this.selectors();
    const page = await this.getPage();
    try {
      await this.openInbox(page, selectors);
    } catch (error) {
      if (!(error instanceof AdapterFailure) || error.kind !== "AUTH_REQUIRED") throw error;
      await page
        .waitForSelector(`${selectors.thread_item}, ${selectors.message_container}`, { timeout: 115_000 })
        .catch(() => undefined);
      await this.assertConnected(page, selectors);
    }
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const selectors = await this.selectors();
    const page = await this.getPage();
    try {
      await this.openInbox(page, selectors);
      return (await this.scrapeThreads(page, selectors, 100))
        .filter((thread) => (thread.unreadCount ?? 0) > 0)
        .map((thread) => ({ ...thread, isUnreadCandidate: true }));
    } catch (error) {
      if (error instanceof AdapterFailure) throw error;
      throw await toStageFailure({
        platform: PLATFORM,
        stage: "collect_threads",
        message: "Google Messages conversation scan failed",
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
    const selectors = await this.selectors();
    const page = await this.getPage();
    await this.openInbox(page, selectors);
    return (await this.scrapeThreads(page, selectors, limit)).map((thread) => ({
      ...thread,
      isRecentCandidate: true
    }));
  }

  async fetchThreadById(platformThreadId: string): Promise<ThreadStub | null> {
    const threads = await this.fetchRecentThreads(150);
    return threads.find((thread) => thread.platformThreadId === platformThreadId) ?? null;
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const selectors = await this.selectors();
    const page = await this.getPage();
    await this.openConversation(page, selectors, thread);
    const messages = await page.evaluate(
      ({ selectors: s }) => {
        const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        return Array.from(document.querySelectorAll(s.message_item)).map((node, index) => {
          const root = node as HTMLElement;
          const aria = clean(root.getAttribute("aria-label"));
          const className = typeof root.className === "string" ? root.className : "";
          const dataDirection = root.getAttribute("data-direction") ?? "";
          const textNodes = Array.from(root.querySelectorAll(s.message_text));
          const text = clean(textNodes.map((entry) => entry.textContent).join(" "));
          const timeNode = root.querySelector("time,[datetime],[data-timestamp],[title*='202']");
          const timestamp = timeNode?.getAttribute("datetime") || timeNode?.getAttribute("data-timestamp") || timeNode?.getAttribute("title") || undefined;
          const media = Array.from(root.querySelectorAll("img[src],video[src],audio[src],a[download][href]"))
            .filter((entry) => !entry.closest("button"))
            .map((entry) => ({
              src: entry.getAttribute("src") || entry.getAttribute("href") || "",
              tag: entry.tagName,
              label: clean(entry.getAttribute("alt") || entry.getAttribute("aria-label") || entry.getAttribute("download"))
            }));
          const reactionLabels = Array.from(root.querySelectorAll("[aria-label*='react' i], [class*='reaction']"))
            .map((entry) => clean(entry.getAttribute("aria-label") || entry.textContent))
            .filter(Boolean);
          const key = root.getAttribute("data-e2e-message-id") || root.getAttribute("data-message-id") || root.id || `google-message-${index}`;
          return { key, aria, className, dataDirection, text, timestamp, media, reactionLabels };
        });
      },
      { selectors }
    );
    return Promise.all(messages.slice(-limit).map(async (message) => {
      const attachments = await this.captureMedia(page, message.key, message.media);
      const direction = googleMessagesDirection(message);
      return {
        platformMessageKey: message.key,
        direction,
        timestamp: googleMessagesTimestamp(message.timestamp),
        text: cleanMessageText(message.text),
        senderName: googleMessagesSenderName(message.aria, direction),
        attachments,
        raw: {
          ariaLabel: message.aria,
          className: message.className,
          dataDirection: message.dataDirection,
          reactions: googleMessagesReactions(message.reactionLabels)
        }
      };
    }));
  }

  async sendMessage(
    thread: ThreadStub,
    text: string,
    attachments?: OutboundAttachment[]
  ): Promise<SendReceipt> {
    const selectors = await this.selectors();
    const page = await this.getPage();
    await this.openConversation(page, selectors, thread);
    const messageCountBefore = await page.locator(selectors.message_item).count();
    const files = (attachments ?? []).map((attachment) => attachment.absolutePath).filter(Boolean);
    if (files.length) {
      let input = page.locator("input[type='file']").first();
      if ((await input.count()) === 0) {
        await page.locator("button[aria-label*='Attach' i], button[aria-label*='media' i]").first().click();
        input = page.locator("input[type='file']").first();
      }
      await input.setInputFiles(files);
    }
    if (text.trim()) {
      const composer = page.locator(selectors.composer_input).first();
      await composer.fill(text).catch(async () => {
        await composer.click();
        await page.keyboard.type(text, { delay: 8 });
      });
    }
    const send = page.locator(selectors.send_button).first();
    await send.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      (selector) => Array.from(document.querySelectorAll(selector)).some((element) => {
        const button = element as HTMLButtonElement;
        return !button.disabled && button.getAttribute("aria-disabled") !== "true";
      }),
      selectors.send_button,
      { timeout: 10_000 }
    );
    await send.click();
    const bubbleDetected = await page
      .waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length > count,
        { selector: selectors.message_item, count: messageCountBefore },
        { timeout: 10_000 }
      )
      .then(() => true)
      .catch(() => false);
    return {
      sentAt: new Date().toISOString(),
      ...(bubbleDetected ? { acknowledgedAt: new Date().toISOString() } : {}),
      verifiedBy: bubbleDetected ? "bubble_detected" : "best_effort",
      raw: { attachmentCount: files.length }
    };
  }

  async reactToMessage(thread: ThreadStub, platformMessageKey: string, emoji: string): Promise<void> {
    const selectors = await this.selectors();
    const page = await this.getPage();
    await this.openConversation(page, selectors, thread);
    const escaped = platformMessageKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const message = page.locator(
      `[data-e2e-message-id="${escaped}"], [data-message-id="${escaped}"]`
    ).first();
    if ((await message.count()) === 0) {
      throw new AdapterFailure("Google Messages reaction target not found", {
        kind: "THREAD_NOT_FOUND",
        platform: PLATFORM,
        stage: "persist",
        details: { platformMessageKey }
      });
    }
    await message.hover();
    await message.locator("button[aria-label*='reaction' i]").first().click();
    await page.getByRole("button", { name: emoji, exact: false }).first().click();
  }

  async openThread(thread: ThreadStub): Promise<void> {
    const selectors = await this.selectors();
    const page = await this.getPage();
    await this.openConversation(page, selectors, thread);
    await page.bringToFront();
  }

  async closeSession(): Promise<void> {
    await this.deps.sessionManager.closePlatformPage({
      platform: PLATFORM,
      personKey: this.deps.personKey ?? "default"
    });
  }
}
