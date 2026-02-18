import { join } from "node:path";
import type { PlatformName, SelectorRegistry, SelectorTestReport, SelectorTestResult } from "@inbox-os/core";
import { v4 as uuid } from "uuid";
import type { Page } from "playwright";
import { AdapterFailure } from "../platforms/utils.js";
import type { SessionManager } from "./session-manager";

interface SelectorTestServiceDeps {
  resolveSelectors: (platform: PlatformName) => Promise<SelectorRegistry>;
  sessionManager: SessionManager;
  screenshotDir: string;
}

const selectorKeys: Array<keyof SelectorRegistry> = [
  "thread_list",
  "thread_item",
  "unread_badge",
  "message_container",
  "message_item",
  "message_text",
  "composer_input",
  "send_button"
];

const adaptiveConversationProbeLimit = 8;

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

export function createSelectorTestService(deps: SelectorTestServiceDeps) {
  async function throwIfAuthRequired(page: Page, platform: PlatformName): Promise<void> {
    const url = page.url();
    const authState = await page.evaluate((targetPlatform) => {
      const bodyText = document.body?.innerText?.toLowerCase() ?? "";
      const hasInput = (selector: string) => document.querySelector(selector) !== null;

      if (targetPlatform === "INSTAGRAM") {
        if (hasInput("input[name='username']") || hasInput("input[name='password']")) {
          return {
            authRequired: true,
            reason: "instagram_login_form"
          };
        }
      }

      if (targetPlatform === "TIKTOK") {
        const qrLogin = bodyText.includes("log in with qr code");
        const authPrompts =
          bodyText.includes("log in") ||
          bodyText.includes("sign up") ||
          bodyText.includes("scan with your mobile device");
        if (qrLogin || authPrompts) {
          return {
            authRequired: true,
            reason: qrLogin ? "tiktok_qr_login" : "tiktok_auth_gate"
          };
        }
      }

      return {
        authRequired: false,
        reason: undefined
      };
    }, platform);

    const urlSuggestsAuth =
      (platform === "INSTAGRAM" && /\/accounts\/login/i.test(url)) ||
      (platform === "TIKTOK" && /\/login/i.test(url));

    if (!authState.authRequired && !urlSuggestsAuth) {
      return;
    }

    throw new AdapterFailure(`${platform} requires authentication before selector tests can run`, {
      kind: "AUTH_REQUIRED",
      details: {
        platform,
        stage: "navigate",
        reason: authState.reason ?? "url_auth_pattern",
        url
      }
    });
  }

  async function run(input: {
    platform: PlatformName;
    key?: keyof SelectorRegistry;
    selector?: string;
  }): Promise<SelectorTestReport> {
    const reportId = uuid();
    const startedAt = new Date().toISOString();

    const selectors = await deps.resolveSelectors(input.platform);
    if (input.key && input.selector) {
      selectors[input.key] = input.selector;
    }
    const page = await deps.sessionManager.getManagedPage({
      platform: input.platform,
      personKey: "default"
    });
    await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
    await throwIfAuthRequired(page, input.platform);

    const keys = input.key ? [input.key] : selectorKeys;
    const results: SelectorTestResult[] = [];
    const conversationKeys = new Set<keyof SelectorRegistry>([
      "message_item",
      "message_text",
      "composer_input",
      "send_button"
    ]);
    let conversationOpened = false;
    let adaptiveProbeAttempted = false;
    let replyCapableConversationFound = false;

      async function openThreadAtIndex(index: number): Promise<boolean> {
        const thread = page.locator(selectors.thread_item).nth(index);
        if ((await thread.count()) === 0) {
          return false;
        }

        await thread.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(800);
        return true;
      }

      async function probeReplyCapableConversation(): Promise<boolean> {
        const threadCount = await page.locator(selectors.thread_item).count();
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

        const hasMessages = (await page.locator(selectors.message_item).count()) > 0;
        const hasComposer = (await page.locator(selectors.composer_input).count()) > 0;
        const hasContainer = (await page.locator(selectors.message_container).count()) > 0;
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

        const nowHasMessages = (await page.locator(selectors.message_item).count()) > 0;
        const nowHasComposer = (await page.locator(selectors.composer_input).count()) > 0;
        const nowHasContainer = (await page.locator(selectors.message_container).count()) > 0;

        conversationOpened = nowHasMessages || nowHasComposer || nowHasContainer;
        if (nowHasComposer) {
          replyCapableConversationFound = true;
        }
      }

      async function countWithRetry(selector: string, attempts = 4, delayMs = 350): Promise<number> {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const count = await page.locator(selector).count();
          if (count > 0) {
            return count;
          }
          if (attempt < attempts - 1) {
            await page.waitForTimeout(delayMs);
          }
        }

        return 0;
      }

    for (const key of keys) {
      const selector = selectors[key];

        let count = 0;
        let status: "PASS" | "FAIL" = "FAIL";
        let screenshotFile: string | undefined;

        try {
          await ensureConversationContext(key);

          count = await countWithRetry(selector);
          status = count > 0 ? "PASS" : "FAIL";

          if (status === "FAIL" && key === "message_item") {
            const composerCount = await countWithRetry(selectors.composer_input, 2, 200);
            if (composerCount > 0) {
              // Empty/new threads can have a composer with zero existing message rows.
              status = "PASS";
            }
          }

          if (status === "FAIL" && key === "send_button") {
            const composerCount = await countWithRetry(selectors.composer_input, 2, 200);
            if (composerCount > 0) {
              // Some platforms only surface a visible send button after typing.
              status = "PASS";
            }
          }

          await page.evaluate((value) => {
            document.querySelectorAll("[data-inbox-selector-highlight='1']").forEach((el) => {
              el.removeAttribute("data-inbox-selector-highlight");
            });

            document.querySelectorAll(value).forEach((el) => {
              (el as HTMLElement).setAttribute("data-inbox-selector-highlight", "1");
            });
          }, selector);

          await page.addStyleTag({
            content:
              "[data-inbox-selector-highlight='1'] { outline: 2px solid #2563eb !important; box-shadow: 0 0 0 3px rgba(37,99,235,0.2) !important; }"
          });

          screenshotFile = `${input.platform.toLowerCase()}-${key}-${Date.now()}.png`;
          await page.screenshot({ path: join(deps.screenshotDir, screenshotFile), fullPage: true });
        } catch {
          status = "FAIL";
        }

      results.push({
        key,
        selector,
        count,
        status,
        screenshotFile
      });
    }

    return {
      reportId,
      platform: input.platform,
      startedAt,
      completedAt: new Date().toISOString(),
      results
    };
  }

  return {
    run
  };
}
