import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "patchright";
import { LinkedInAdapter } from "../apps/runner/dist/platforms/linkedin-adapter.js";

function selectorsForInbox(inboxUrl) {
  return {
    inbox_url: inboxUrl,
    thread_list: "ul.msg-conversations-container__conversations-list",
    thread_item: "li.msg-conversation-listitem",
    unread_badge: "div.msg-conversation-card__unread-count .notification-badge__count",
    message_container: ".message-container",
    message_item: ".message-item",
    message_text: ".message-text",
    composer_input: ".composer-input",
    send_button: ".send-button"
  };
}

async function createFixture() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return {
      skipped: true,
      reason: `Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-no-eval-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-no-eval-dom-"));
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "unread-rerender-scroll.html");
  const html = await readFile(fixturePath, "utf8");
  const inboxUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const adapter = new LinkedInAdapter({
    screenshotDir,
    domDumpDir,
    resolveSelectors: async () => selectorsForInbox(inboxUrl),
    sessionManager: {
      getManagedPage: async () => page
    },
    personKey: "default",
    scanMaxThreads: 25,
    scanStableIterations: 3,
    scanScrollWaitMs: 80,
    messageBackfillAttempts: 1
  });

  return {
    skipped: false,
    adapter,
    context,
    browser,
    page
  };
}

test("LinkedIn unread collect path never sends string payloads to page.evaluate", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const originalEvaluate = fixture.page.evaluate.bind(fixture.page);
  let stringCalls = 0;
  fixture.page.evaluate = async (fn, arg) => {
    if (typeof fn === "string") {
      stringCalls += 1;
      throw new Error("string evaluate payload is not allowed");
    }
    return originalEvaluate(fn, arg);
  };

  const threads = await fixture.adapter.scanUnreadThreads();
  assert.equal(stringCalls, 0);
  assert.equal(threads.length > 0, true);
});
