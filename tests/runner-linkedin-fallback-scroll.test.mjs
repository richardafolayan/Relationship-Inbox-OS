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
    message_container: ".msg-s-message-list",
    message_item: ".msg-s-event-listitem",
    message_text: ".msg-s-event-listitem__body",
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
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-fallback-scroll-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-fallback-scroll-dom-"));
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
    scanMaxThreads: 80,
    scanStableIterations: 3,
    scanScrollWaitMs: 80,
    messageBackfillAttempts: 1
  });

  return {
    skipped: false,
    adapter,
    context,
    browser
  };
}

test("LinkedIn direct fallback deep-scrolls beyond first viewport and exhausts with deep-scroll stop reason", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const result = await fixture.adapter.scanInboxThreadsDirectFallback({
    requestId: "fallback-scroll-test",
    disableDeepScroll: false,
    maxThreads: 80,
    maxOpens: 80
  });

  const names = result.threads.map((thread) => thread.displayName);
  assert.equal(names.includes("Hotel Eight"), true);
  assert.equal(names.includes("India Nine"), true);
  assert.equal(result.threadsScanned > 3, true);
  assert.equal(result.stopReason === "fallback_direct_complete", false);
});
