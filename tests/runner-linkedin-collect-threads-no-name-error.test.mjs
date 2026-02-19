import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
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
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-collect-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-collect-dom-"));
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
    page,
    context,
    browser,
    selectors: selectorsForInbox(inboxUrl)
  };
}

test("LinkedIn collect_threads production path parses rows without __name evaluate leakage", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  await fixture.page.goto(fixture.selectors.inbox_url, { waitUntil: "domcontentloaded" });
  const unreadState = await fixture.adapter.ensureUnreadFilterActive(fixture.page, fixture.selectors);
  assert.equal(Boolean(unreadState.pillPresent), true);

  const collected = await fixture.adapter.collectThreadRowsWithScroll(
    fixture.page,
    fixture.selectors,
    20
  );
  assert.equal(collected.rows.length > 0, true);
  assert.equal(
    collected.rows.some((row) => row.displayName && row.displayName.trim().length > 0),
    true
  );
  assert.equal(
    collected.rows.some((row) => (row.threadUrl ?? "").includes("/messaging/thread/")),
    true
  );
});
