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
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-scroll-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-scroll-dom-"));
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
    scanMaxThreads: 60,
    scanStableIterations: 3,
    scanScrollWaitMs: 100,
    messageBackfillAttempts: 1
  });

  return {
    skipped: false,
    adapter,
    context,
    browser
  };
}

test("LinkedIn deep scroll terminates with bounded iterations and deterministic stop reason", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const threads = await fixture.adapter.scanUnreadThreads();
  const metrics = fixture.adapter.getLastCollectionMetrics();

  assert.equal(threads.length > 0, true);
  assert.equal(metrics !== null, true);
  assert.equal((metrics?.iterations ?? 0) > 0, true);
  assert.equal((metrics?.iterations ?? 0) <= 60, true);
  assert.equal(
    [
      "end_of_list_no_progress",
      "end_of_list_reached",
      "max_threads",
      "max_iterations",
      "max_duration",
      "zero_threads_found"
    ].includes(metrics?.stopReason ?? ""),
    true
  );
});
