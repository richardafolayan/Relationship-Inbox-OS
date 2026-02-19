import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { LinkedInAdapter } from "../apps/runner/dist/platforms/linkedin-adapter.js";
import { getLinkedInDevScanCaps } from "../apps/runner/dist/dev-flags.js";

function selectorsForInbox(inboxUrl) {
  return {
    inbox_url: inboxUrl,
    thread_list: "ul.msg-conversations-container__conversations-list",
    thread_item: "li.msg-conversation-listitem",
    unread_badge: ".msg-conversation-card__unread-count .notification-badge__count",
    message_container: ".message-container",
    message_item: ".message-item",
    message_text: ".message-text",
    composer_input: ".composer-input",
    send_button: ".send-button"
  };
}

function buildFixtureHtml() {
  return `<!doctype html>
<html>
  <body>
    <button data-test-messaging-inbox-filters__filter-pill="UNREAD" aria-pressed="true">Unread</button>
    <ul class="msg-conversations-container__conversations-list">
      <li class="msg-conversation-listitem" data-id="thread-1">
        <div class="msg-conversation-listitem__link msg-conversations-container__convo-item-link">
          <a href="https://www.linkedin.com/messaging/thread/thread-1/">Open</a>
          <h3 class="msg-conversation-listitem__participant-names"><span class="truncate">Ada Lovelace</span></h3>
          <p class="msg-conversation-card__message-snippet">Unread one</p>
          <time class="msg-conversation-listitem__time-stamp">8:01 AM</time>
          <div class="msg-conversation-card__unread-count"><span class="notification-badge__count">2</span></div>
        </div>
      </li>
      <li class="msg-conversation-listitem" data-id="thread-2">
        <div class="msg-conversation-listitem__link msg-conversations-container__convo-item-link">
          <a href="https://www.linkedin.com/messaging/thread/thread-2/">Open</a>
          <h3 class="msg-conversation-listitem__participant-names"><span class="truncate">Grace Hopper</span></h3>
          <p class="msg-conversation-card__message-snippet">Unread two</p>
          <time class="msg-conversation-listitem__time-stamp">8:05 AM</time>
          <div class="msg-conversation-card__unread-count"><span class="notification-badge__count">3</span></div>
        </div>
      </li>
      <li class="msg-conversation-listitem" data-id="thread-3">
        <div class="msg-conversation-listitem__link msg-conversations-container__convo-item-link">
          <a href="https://www.linkedin.com/messaging/thread/thread-3/">Open</a>
          <h3 class="msg-conversation-listitem__participant-names"><span class="truncate">Katherine Johnson</span></h3>
          <p class="msg-conversation-card__message-snippet">Unread three</p>
          <time class="msg-conversation-listitem__time-stamp">8:09 AM</time>
          <div class="msg-conversation-card__unread-count"><span class="notification-badge__count">4</span></div>
        </div>
      </li>
    </ul>
  </body>
</html>`;
}

test("LinkedIn full scan honors dev caps and skips deep-scroll loop when disabled", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    LINKEDIN_DEV_SCAN_MAX_THREADS: process.env.LINKEDIN_DEV_SCAN_MAX_THREADS,
    LINKEDIN_DEV_SCAN_MAX_OPENS: process.env.LINKEDIN_DEV_SCAN_MAX_OPENS,
    LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL: process.env.LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL
  };
  process.env.NODE_ENV = "development";
  process.env.LINKEDIN_DEV_SCAN_MAX_THREADS = "1";
  process.env.LINKEDIN_DEV_SCAN_MAX_OPENS = "1";
  process.env.LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL = "1";

  const context = await browser.newContext();
  const page = await context.newPage();
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-dev-caps-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-dev-caps-dom-"));
  const inboxUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildFixtureHtml())}`;

  const adapter = new LinkedInAdapter({
    screenshotDir,
    domDumpDir,
    resolveSelectors: async () => selectorsForInbox(inboxUrl),
    sessionManager: {
      getManagedPage: async () => page
    },
    personKey: "default",
    scanMaxThreads: 200,
    scanStableIterations: 3,
    scanScrollWaitMs: 100,
    messageBackfillAttempts: 1
  });

  let deepScrollInvocations = 0;
  const originalDeepScroll = adapter.deepScrollThreadList.bind(adapter);
  adapter.deepScrollThreadList = async (...args) => {
    deepScrollInvocations += 1;
    return originalDeepScroll(...args);
  };

  t.after(async () => {
    process.env.NODE_ENV = previousEnv.NODE_ENV;
    process.env.LINKEDIN_DEV_SCAN_MAX_THREADS = previousEnv.LINKEDIN_DEV_SCAN_MAX_THREADS;
    process.env.LINKEDIN_DEV_SCAN_MAX_OPENS = previousEnv.LINKEDIN_DEV_SCAN_MAX_OPENS;
    process.env.LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL = previousEnv.LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL;
    await context.close();
    await browser.close();
  });

  const caps = getLinkedInDevScanCaps();
  assert.equal(caps.maxThreads, 1);
  assert.equal(caps.maxOpens, 1);
  assert.equal(caps.disableDeepScroll, true);

  const threads = await adapter.scanUnreadThreads({
    ...caps,
    requestId: "dev-cap-test"
  });
  assert.equal(threads.length, 1);
  assert.equal(deepScrollInvocations, 0);
});
