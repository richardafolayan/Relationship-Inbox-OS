import type { Locator, Page } from "patchright";
import {
  stableHash,
  type NormalizedMessage,
  type OutboundAttachment,
  type SelectorRegistry,
  type SendReceipt,
  type ThreadStub
} from "@inbox-os/core";
import { BetaAdapter, betaIdentityMatch, type BetaAdapterDependencies } from "./beta-adapter";
import { ChromeCookieBridge } from "./chrome-cookie-bridge";
import { AdapterFailure, cleanMessageText } from "./utils";
import { humanClick, humanType, readingPause } from "./humanize";

const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const THREAD_PATH = /^\/direct\/t\/([^/?#]+)\/?$/i;

export interface InstagramAdapterDependencies extends Omit<BetaAdapterDependencies, "platform"> {
  connectTimeoutMs: number;
  sendVerificationTimeoutMs?: number;
  personalProfile?: {
    sourceUserDataDir: string;
    profileDirectory: string;
  };
}

export interface InstagramThreadSnapshot {
  href?: string;
  stableId?: string;
  displayName?: string;
  preview?: string;
  unread?: boolean;
}

export type InstagramDirectionEvidence = "IN" | "OUT" | "AMBIGUOUS";

export interface InstagramMessageSnapshot {
  nativeId?: string;
  direction: InstagramDirectionEvidence;
  text?: string;
  senderName?: string;
  sourceTimestamp?: string;
  mediaKind?: "photo" | "video" | "voice_message" | "attachment" | "unsupported";
  deleted?: boolean;
}

export class InstagramParsingError extends Error {
  constructor(readonly reason: string) {
    super(`Instagram parsing failed: ${reason}`);
    this.name = "InstagramParsingError";
  }
}

export type InstagramAuthRequirement = "login_required" | "verification_required";

export function classifyInstagramAuthRequirement(input: {
  url: string;
  fieldNames?: string[];
  bodyText?: string;
  hasRecaptcha?: boolean;
}): InstagramAuthRequirement | null {
  if (
    /\/auth_platform\/recaptcha/i.test(input.url) ||
    input.hasRecaptcha ||
    /i['’]?m not a robot|security check|recaptcha/i.test(input.bodyText ?? "")
  ) {
    return "verification_required";
  }
  if (/\/accounts\/login/i.test(input.url)) {
    return "login_required";
  }
  const fields = new Set((input.fieldNames ?? []).map((value) => value.toLowerCase()));
  if (
    fields.has("email") ||
    fields.has("pass") ||
    fields.has("username") ||
    fields.has("password")
  ) {
    return "login_required";
  }
  return /log in to instagram/i.test(input.bodyText ?? "") ? "login_required" : null;
}

export function instagramAuthRequiredFromSignals(input: {
  url: string;
  fieldNames?: string[];
  bodyText?: string;
  hasRecaptcha?: boolean;
}): boolean {
  return classifyInstagramAuthRequirement(input) !== null;
}

export function instagramThreadIdFromUrl(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const url = new URL(value, INSTAGRAM_ORIGIN);
    if (url.hostname !== "www.instagram.com" && url.hostname !== "instagram.com") {
      return null;
    }
    const match = url.pathname.match(THREAD_PATH);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function isStableInstagramId(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9._=-]+$/.test(value));
}

export function canonicalInstagramThreadUrl(platformThreadId: string): string {
  if (!isStableInstagramId(platformThreadId)) {
    throw new InstagramParsingError("invalid_thread_id");
  }
  return `${INSTAGRAM_ORIGIN}/direct/t/${encodeURIComponent(platformThreadId)}/`;
}

export function normalizeInstagramThreadSnapshots(
  snapshots: InstagramThreadSnapshot[]
): ThreadStub[] {
  const byId = new Map<string, ThreadStub>();

  for (const snapshot of snapshots) {
    const hrefId = instagramThreadIdFromUrl(snapshot.href);
    const platformThreadId = hrefId ?? (isStableInstagramId(snapshot.stableId) ? snapshot.stableId : null);
    if (!platformThreadId) {
      throw new InstagramParsingError("thread_missing_stable_identity");
    }

    const existing = byId.get(platformThreadId);
    const displayName = snapshot.displayName?.replace(/\s+/g, " ").trim() || "Instagram conversation";
    const candidate: ThreadStub = {
      platformThreadId,
      displayName,
      unreadCount: snapshot.unread ? 1 : 0,
      lastMessagePreview: snapshot.preview?.replace(/\s+/g, " ").trim().slice(0, 220) ?? "",
      threadUrl: canonicalInstagramThreadUrl(platformThreadId)
    };

    if (!existing) {
      byId.set(platformThreadId, candidate);
      continue;
    }

    byId.set(platformThreadId, {
      ...existing,
      unreadCount: Math.max(existing.unreadCount ?? 0, candidate.unreadCount ?? 0),
      displayName:
        existing.displayName === "Instagram conversation" ? candidate.displayName : existing.displayName,
      lastMessagePreview: existing.lastMessagePreview || candidate.lastMessagePreview
    });
  }

  return [...byId.values()];
}

export function parseInstagramSourceTimestamp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function instagramThreadUrlMatches(url: string, expectedThreadId: string): boolean {
  return instagramThreadIdFromUrl(url) === expectedThreadId;
}

export function findNewVerifiedInstagramOutgoing(
  before: NormalizedMessage[],
  after: NormalizedMessage[],
  text: string
): NormalizedMessage | null {
  const normalizedText = cleanMessageText(text);
  const beforeKeys = new Set(
    before
      .filter(
        (message) =>
          message.direction === "OUT" && cleanMessageText(message.text) === normalizedText
      )
      .map((message) => message.platformMessageKey)
      .filter((key): key is string => Boolean(key))
  );
  return (
    after
      .filter(
        (message) =>
          message.direction === "OUT" && cleanMessageText(message.text) === normalizedText
      )
      .find((message) => !message.platformMessageKey || !beforeKeys.has(message.platformMessageKey)) ??
    null
  );
}

function placeholderForSnapshot(snapshot: InstagramMessageSnapshot): {
  text: string;
  attachmentType?: string;
} {
  if (snapshot.deleted) {
    return { text: "[Deleted Instagram message]", attachmentType: "deleted_message" };
  }
  if (snapshot.mediaKind === "photo") {
    return { text: "[Instagram photo]", attachmentType: "photo" };
  }
  if (snapshot.mediaKind === "video") {
    return { text: "[Instagram video]", attachmentType: "video" };
  }
  if (snapshot.mediaKind === "voice_message") {
    return { text: "[Instagram voice message]", attachmentType: "voice_message" };
  }
  if (snapshot.mediaKind === "attachment") {
    return { text: "[Instagram attachment]", attachmentType: "attachment" };
  }
  return { text: "[Unsupported Instagram message]", attachmentType: "unsupported" };
}

export function normalizeInstagramMessageSnapshots(
  platformThreadId: string,
  snapshots: InstagramMessageSnapshot[]
): NormalizedMessage[] {
  const prepared = snapshots.map((snapshot) => {
    if (snapshot.direction === "AMBIGUOUS") {
      throw new InstagramParsingError("ambiguous_message_direction");
    }
    const sourceTimestamp = parseInstagramSourceTimestamp(snapshot.sourceTimestamp);
    const cleanedText = cleanMessageText(snapshot.text ?? "");
    const placeholder =
      snapshot.deleted || snapshot.mediaKind || !cleanedText
        ? placeholderForSnapshot(snapshot)
        : undefined;
    const text = snapshot.deleted ? placeholder!.text : cleanedText || placeholder!.text;
    const senderName = snapshot.senderName?.replace(/\s+/g, " ").trim() || undefined;
    const signature = [
      snapshot.direction,
      text,
      sourceTimestamp ?? "",
      senderName ?? "",
      placeholder?.attachmentType ?? ""
    ].join("\u001f");
    return { snapshot, sourceTimestamp, text, senderName, placeholder, signature };
  });

  const occurrences = new Map<string, number>();
  const seenKeys = new Set<string>();
  const messages: NormalizedMessage[] = [];

  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index]!;
    const occurrence = occurrences.get(item.signature) ?? 0;
    occurrences.set(item.signature, occurrence + 1);
    const previous = prepared[index - 1]?.signature ?? "";
    const nativeId = item.snapshot.nativeId?.trim();
    const key = nativeId
      ? `instagram:${nativeId}`
      : `instagram:${stableHash(
          [platformThreadId, item.signature, previous, String(occurrence)].join("\u001e")
        )}`;

    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    messages.push({
      platformMessageKey: key,
      direction: item.snapshot.direction as "IN" | "OUT",
      timestamp: item.sourceTimestamp,
      text: item.text,
      senderName: item.senderName,
      raw: {
        timestampSource: item.sourceTimestamp ? "source" : "first_seen",
        contentKind: item.placeholder?.attachmentType ?? "text"
      },
      attachments: item.placeholder?.attachmentType
        ? [
            {
              type: item.placeholder.attachmentType,
              kind:
                item.placeholder.attachmentType === "photo"
                  ? "photo"
                  : item.placeholder.attachmentType === "video"
                    ? "video"
                    : item.placeholder.attachmentType === "voice_message"
                      ? "voice_note"
                      : "unknown",
              manualReview: true
            }
          ]
        : []
    });
  }

  return messages;
}

function threadIdForStub(thread: ThreadStub): string {
  const fromUrl = instagramThreadIdFromUrl(thread.threadUrl);
  if (fromUrl) {
    return fromUrl;
  }
  const fromPlatformId = instagramThreadIdFromUrl(thread.platformThreadId);
  if (fromPlatformId) {
    return fromPlatformId;
  }
  if (isStableInstagramId(thread.platformThreadId)) {
    return thread.platformThreadId;
  }
  throw new InstagramParsingError("invalid_thread_id");
}

export class InstagramAdapter extends BetaAdapter {
  private readonly instagramDeps: InstagramAdapterDependencies;
  private cookieBridge: ChromeCookieBridge | null = null;
  private lastCookieSyncAt: number | null = null;

  constructor(deps: InstagramAdapterDependencies) {
    super({ ...deps, platform: "INSTAGRAM" });
    this.instagramDeps = deps;
  }

  protected override async getPage(): Promise<Page> {
    const page = await super.getPage();
    await this.ensureSessionCookies(page);
    return page;
  }

  private async ensureSessionCookies(page: Page): Promise<void> {
    const personal = this.instagramDeps.personalProfile;
    if (!personal) {
      return;
    }

    const now = Date.now();
    if (this.lastCookieSyncAt !== null && now - this.lastCookieSyncAt < 10 * 60 * 1000) {
      return;
    }

    this.cookieBridge ??= new ChromeCookieBridge({
      sourceUserDataDir: personal.sourceUserDataDir,
      profileDirectory: personal.profileDirectory
    });

    const result = await this.cookieBridge.syncIntoContext(
      page.context(),
      "%instagram.com%"
    );
    if (result.reason === "ok") {
      this.lastCookieSyncAt = now;
      console.log(`[instagram-cookie-bridge] injected ${result.injected} cookies`);
      return;
    }

    console.warn(`[instagram-cookie-bridge] no cookies injected (${result.reason})`);
  }

  private safeFailure(
    kind: "SELECTOR_MISMATCH" | "THREAD_FETCH_FAILED" | "THREAD_NOT_FOUND" | "NAVIGATION_FAILED",
    stage: "connect" | "navigate" | "collect_threads" | "open_thread" | "parse" | "persist",
    reason: string,
    platformThreadId?: string,
    cause?: unknown
  ): AdapterFailure {
    return new AdapterFailure(`Instagram ${reason.replaceAll("_", " ")}`, {
      kind,
      platform: "INSTAGRAM",
      stage,
      platformThreadId,
      details: { reason },
      cause
    });
  }

  private async throwIfInstagramAuthRequired(page: Page, context: string): Promise<void> {
    const signals = await page.evaluate(() => ({
      fieldNames: Array.from(document.querySelectorAll("input[name]"))
        .map((node) => node.getAttribute("name") ?? "")
        .filter(Boolean),
      bodyText: document.body?.innerText?.slice(0, 500) ?? "",
      hasRecaptcha: Boolean(
        document.querySelector("iframe[src*='recaptcha'], .g-recaptcha, [data-sitekey]")
      )
    }));
    const requirement = classifyInstagramAuthRequirement({
      url: page.url(),
      fieldNames: signals.fieldNames,
      bodyText: signals.bodyText,
      hasRecaptcha: signals.hasRecaptcha
    });
    if (requirement) {
      throw new AdapterFailure("Instagram auth required", {
        kind: "AUTH_REQUIRED",
        platform: "INSTAGRAM",
        stage: "navigate",
        details: { context, reason: `instagram_${requirement}` }
      });
    }
  }

  private async waitForAuthenticatedInbox(
    page: Page,
    selectors: SelectorRegistry,
    timeoutMs: number
  ): Promise<void> {
    await page.waitForFunction(
      ({ threadList, threadItem, messageContainer }) => {
        const pathname = window.location.pathname;
        if (
          pathname.startsWith("/auth_platform/recaptcha") ||
          document.querySelector("iframe[src*='recaptcha'], .g-recaptcha, [data-sitekey]")
        ) {
          return true;
        }
        if (!pathname.startsWith("/direct")) {
          return false;
        }
        return Boolean(
          document.querySelector(threadList) ||
            document.querySelector(threadItem) ||
            document.querySelector(messageContainer) ||
            document.querySelector("main")
        );
      },
      {
        threadList: selectors.thread_list,
        threadItem: selectors.thread_item,
        messageContainer: selectors.message_container
      },
      { timeout: timeoutMs }
    );
  }

  private async navigateToInbox(
    page: Page,
    selectors: SelectorRegistry,
    timeoutMs: number
  ): Promise<void> {
    await page.goto(selectors.inbox_url, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeoutMs, 12_000)
    });
    await page.waitForTimeout(350);
    await this.throwIfInstagramAuthRequired(page, "instagram_inbox");
    await this.waitForAuthenticatedInbox(page, selectors, timeoutMs);
  }

  async ensureConnected(): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    try {
      await this.navigateToInbox(page, selectors, 12_000);
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      throw this.safeFailure("SELECTOR_MISMATCH", "connect", "inbox_not_ready", undefined, error);
    }
  }

  async connectInteractively(): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    const startedAt = Date.now();
    const reserveMs = Math.max(
      2_000,
      Math.floor(this.instagramDeps.connectTimeoutMs * 0.15)
    );
    const navigationTimeoutMs = Math.max(
      1_000,
      Math.min(15_000, Math.floor(this.instagramDeps.connectTimeoutMs * 0.25))
    );
    try {
      await page.goto(selectors.inbox_url, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs
      });
      await page.bringToFront();
      const authWaitTimeoutMs = Math.max(
        1,
        this.instagramDeps.connectTimeoutMs - (Date.now() - startedAt) - reserveMs
      );
      await this.waitForAuthenticatedInbox(page, selectors, authWaitTimeoutMs);
      await this.throwIfInstagramAuthRequired(page, "interactive_connect");
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      await this.throwIfInstagramAuthRequired(page, "interactive_connect");
      throw this.safeFailure("SELECTOR_MISMATCH", "connect", "interactive_login_incomplete", undefined, error);
    }
  }

  private async snapshotThreads(
    page: Page,
    selectors: SelectorRegistry,
    limit: number
  ): Promise<InstagramThreadSnapshot[]> {
    return page.evaluate(
      ({ selectors, limit }) => {
        const clean = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim();
        const query = (root: Element, selector: string | undefined): Element | null => {
          if (!selector) return null;
          try {
            return root.matches(selector) ? root : root.querySelector(selector);
          } catch {
            return null;
          }
        };
        const rows = Array.from(document.querySelectorAll(selectors.thread_item)).slice(0, limit);
        return rows.map((row) => {
          const link = query(row, selectors.thread_link ?? "a[href*='/direct/t/']") as
            | HTMLAnchorElement
            | null;
          const identity = query(
            row,
            selectors.thread_identity ?? "span[title], img[alt]"
          ) as HTMLElement | null;
          const preview = query(row, selectors.thread_snippet ?? "span[dir='auto']") as
            | HTMLElement
            | null;
          const identityText =
            identity?.getAttribute("title") ||
            identity?.getAttribute("alt") ||
            identity?.textContent ||
            "";
          const stableId =
            row.getAttribute("data-thread-id") ||
            row.getAttribute("data-conversation-id") ||
            link?.getAttribute("data-thread-id") ||
            undefined;
          return {
            href: link?.href,
            stableId,
            displayName: clean(identityText),
            preview: clean(preview?.textContent),
            unread: Boolean(query(row, selectors.unread_badge))
          };
        });
      },
      { selectors, limit }
    );
  }

  private async collectThreads(limit: number): Promise<ThreadStub[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    try {
      await this.navigateToInbox(page, selectors, 12_000);
      const snapshots = await this.snapshotThreads(page, selectors, limit);
      if (snapshots.length === 0) {
        const emptyInbox = await page
          .evaluate(() => {
            const text = document.body?.innerText?.toLowerCase() ?? "";
            return /no messages|no conversations|messages you send and receive/.test(text);
          })
          .catch(() => false);
        if (!emptyInbox) {
          throw new InstagramParsingError("thread_selector_returned_no_rows");
        }
      }
      return normalizeInstagramThreadSnapshots(snapshots);
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      const reason =
        error instanceof InstagramParsingError ? error.reason : "thread_collection_failed";
      throw this.safeFailure("SELECTOR_MISMATCH", "collect_threads", reason, undefined, error);
    }
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const threads = await this.collectThreads(80);
    return threads
      .filter((thread) => (thread.unreadCount ?? 0) > 0)
      .map((thread) => ({ ...thread, isUnreadCandidate: true }));
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const threads = await this.collectThreads(limit);
    return threads.map((thread) => ({ ...thread, isRecentCandidate: true }));
  }

  private async openExactThread(
    page: Page,
    selectors: SelectorRegistry,
    thread: ThreadStub
  ): Promise<string> {
    const platformThreadId = threadIdForStub(thread);
    await page.goto(canonicalInstagramThreadUrl(platformThreadId), {
      waitUntil: "domcontentloaded",
      timeout: 12_000
    });
    await page.waitForTimeout(350);
    await this.throwIfInstagramAuthRequired(page, "open_thread");
    await Promise.race([
      page.waitForSelector(selectors.message_container, { timeout: 12_000 }),
      page.waitForSelector(selectors.composer_input, { timeout: 12_000 }),
      page.waitForSelector(selectors.message_item, { timeout: 12_000 })
    ]);

    if (!instagramThreadUrlMatches(page.url(), platformThreadId)) {
      throw this.safeFailure(
        "THREAD_NOT_FOUND",
        "open_thread",
        "opened_thread_id_mismatch",
        platformThreadId
      );
    }

    const headerText = await page
      .locator(selectors.conversation_header ?? "header h1, header h2, header span[title]")
      .first()
      .getAttribute("title")
      .catch(() => null);
    const fallbackHeader = headerText
      ? headerText
      : await page
          .locator(selectors.conversation_header ?? "header h1, header h2, header span[title]")
          .first()
          .textContent()
          .catch(() => "");
    if (
      thread.displayName &&
      thread.displayName !== "Instagram conversation" &&
      fallbackHeader?.trim() &&
      !betaIdentityMatch(fallbackHeader, thread.displayName)
    ) {
      throw this.safeFailure(
        "THREAD_NOT_FOUND",
        "open_thread",
        "opened_recipient_mismatch",
        platformThreadId
      );
    }

    return platformThreadId;
  }

  private async snapshotMessages(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<InstagramMessageSnapshot[]> {
    return page.evaluate(
      ({ selectors }) => {
        const clean = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim();
        const matches = (root: Element, selector: string | undefined): boolean => {
          if (!selector) return false;
          try {
            return root.matches(selector) || Boolean(root.querySelector(selector));
          } catch {
            return false;
          }
        };
        const query = (root: Element, selector: string | undefined): Element | null => {
          if (!selector) return null;
          try {
            return root.matches(selector) ? root : root.querySelector(selector);
          } catch {
            return null;
          }
        };
        const container =
          document.querySelector(selectors.message_container) ??
          document.querySelector("main, div[role='main']");
        if (!container) {
          return [];
        }
        const containerRect = container.getBoundingClientRect();
        return Array.from(container.querySelectorAll(selectors.message_item)).map((node) => {
          const root = node as HTMLElement;
          const semantic = [
            root.getAttribute("data-direction"),
            root.getAttribute("data-testid"),
            root.getAttribute("aria-label"),
            root.className?.toString()
          ]
            .filter(Boolean)
            .join(" ");
          const explicitIn =
            matches(root, selectors.message_direction_in) ||
            /\b(incoming|received|message-in|other|left)\b/i.test(semantic);
          const explicitOut =
            matches(root, selectors.message_direction_out) ||
            /\b(outgoing|sent|message-out|self|mine|right)\b/i.test(semantic);
          const rect = root.getBoundingClientRect();
          const delta = rect.left + rect.width / 2 - (containerRect.left + containerRect.width / 2);
          const layoutDirection =
            Math.abs(delta) >= Math.max(12, containerRect.width * 0.08)
              ? delta > 0
                ? "OUT"
                : "IN"
              : null;
          const direction =
            explicitIn && explicitOut
              ? "AMBIGUOUS"
              : explicitIn
                ? "IN"
                : explicitOut
                  ? "OUT"
                  : layoutDirection ?? "AMBIGUOUS";
          const idNode = query(root, selectors.message_id);
          const nativeId =
            root.getAttribute("data-message-id") ||
            root.getAttribute("data-id") ||
            root.id ||
            idNode?.getAttribute("data-message-id") ||
            idNode?.getAttribute("data-id") ||
            idNode?.id ||
            undefined;
          const textNode = query(root, selectors.message_text);
          const timestampNode = query(root, selectors.message_timestamp ?? "time[datetime]");
          const senderNode = query(root, selectors.message_sender);
          const mediaNode = query(
            root,
            selectors.message_media ?? "img:not([alt='']), video, audio"
          ) as HTMLElement | null;
          const mediaSignal = [
            mediaNode?.tagName,
            mediaNode?.getAttribute("aria-label"),
            mediaNode?.getAttribute("alt")
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          const mediaKind = !mediaNode
            ? undefined
            : /voice|audio/.test(mediaSignal)
              ? "voice_message"
              : /video/.test(mediaSignal)
                ? "video"
                : /img|photo|image/.test(mediaSignal)
                  ? "photo"
                  : "attachment";
          return {
            nativeId,
            direction,
            text: clean(textNode?.textContent),
            senderName: clean(senderNode?.textContent) || undefined,
            sourceTimestamp:
              timestampNode?.getAttribute("datetime") ||
              timestampNode?.getAttribute("title") ||
              undefined,
            mediaKind,
            deleted:
              matches(root, selectors.message_deleted) ||
              /message (?:was )?(?:deleted|unavailable)/i.test(clean(root.textContent))
          };
        });
      },
      { selectors }
    );
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    let platformThreadId: string | undefined;
    try {
      platformThreadId = await this.openExactThread(page, selectors, thread);
      const snapshots = await this.snapshotMessages(page, selectors);
      if (snapshots.length === 0 && (await page.locator(selectors.composer_input).count()) === 0) {
        throw new InstagramParsingError("message_selector_returned_no_rows");
      }
      return normalizeInstagramMessageSnapshots(platformThreadId, snapshots).slice(-limit);
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      const reason =
        error instanceof InstagramParsingError ? error.reason : "message_parse_failed";
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "parse",
        reason,
        platformThreadId,
        error
      );
    }
  }

  private async requireEnabled(locator: Locator, reason: string): Promise<void> {
    if ((await locator.count()) !== 1) {
      throw new InstagramParsingError(`${reason}_not_unique`);
    }
    if (
      !(await locator.isEnabled().catch(() => false)) ||
      (await locator.getAttribute("aria-disabled")) === "true"
    ) {
      throw new InstagramParsingError(`${reason}_disabled`);
    }
  }

  async sendMessage(
    thread: ThreadStub,
    text: string,
    attachments: OutboundAttachment[] = []
  ): Promise<SendReceipt> {
    if (attachments.length > 0) {
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "persist",
        "text_only_send_required",
        thread.platformThreadId
      );
    }
    const normalizedText = cleanMessageText(text);
    if (!normalizedText) {
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "persist",
        "empty_message_rejected",
        thread.platformThreadId
      );
    }

    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    let platformThreadId: string | undefined;
    try {
      platformThreadId = await this.openExactThread(page, selectors, thread);
      const before = normalizeInstagramMessageSnapshots(
        platformThreadId,
        await this.snapshotMessages(page, selectors)
      );
      const composer = page.locator(selectors.composer_input);
      await this.requireEnabled(composer, "composer");
      await humanClick(page, composer, { timeout: 10_000 });
      await humanType(page, composer, normalizedText, { alreadyFocused: true, reading: null });
      await readingPause(500, 1_100);

      const sendButton = page.locator(selectors.send_button);
      await this.requireEnabled(sendButton, "send_button");
      await humanClick(page, sendButton, { timeout: 10_000, reading: null });

      const deadline =
        Date.now() + (this.instagramDeps.sendVerificationTimeoutMs ?? 12_000);
      while (Date.now() < deadline) {
        if (!instagramThreadUrlMatches(page.url(), platformThreadId)) {
          throw new InstagramParsingError("thread_changed_during_send");
        }
        const after = normalizeInstagramMessageSnapshots(
          platformThreadId,
          await this.snapshotMessages(page, selectors)
        );
        const sent = findNewVerifiedInstagramOutgoing(before, after, normalizedText);
        if (sent) {
          return {
            sentAt: new Date().toISOString(),
            acknowledgedAt: new Date().toISOString(),
            verifiedBy: "bubble_detected",
            platformMessageKey: sent?.platformMessageKey,
            raw: { verification: "new_outgoing_bubble" }
          };
        }
        await page.waitForTimeout(500);
      }

      throw new InstagramParsingError("submitted_message_not_observed");
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      const reason =
        error instanceof InstagramParsingError ? error.reason : "send_verification_failed";
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "persist",
        reason,
        platformThreadId,
        error
      );
    }
  }

  async openThread(thread: ThreadStub): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    await page.bringToFront();
    await this.openExactThread(page, selectors, thread);
  }
}
