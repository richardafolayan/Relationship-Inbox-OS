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

async function createAdapterPageFixture() {
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
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-resilience-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-resilience-dom-"));
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
    browser
  };
}

test("LinkedIn unread scan survives unread-click rerender and container-only scrolling", async (t) => {
  const fixture = await createAdapterPageFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const threads = await fixture.adapter.scanUnreadThreads();
  const names = threads.map((thread) => thread.displayName);

  assert.equal(threads.length > 0, true);
  assert.equal(names.includes("Bravo Two"), true);
  assert.equal(names.includes("Hotel Eight"), true);
  assert.equal(names.includes("India Nine"), true);
});

test("LinkedIn unread scan retries transient execution-context errors during collect", async (t) => {
  const fixture = await createAdapterPageFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const originalSnapshot = fixture.adapter.captureThreadRowsSnapshot.bind(fixture.adapter);
  let injectedFailure = false;
  fixture.adapter.captureThreadRowsSnapshot = async (...args) => {
    if (!injectedFailure) {
      injectedFailure = true;
      throw new Error("Execution context was destroyed, most likely because of a navigation.");
    }
    return originalSnapshot(...args);
  };

  const threads = await fixture.adapter.scanUnreadThreads();
  assert.equal(injectedFailure, true);
  assert.equal(threads.length > 0, true);
});

test("LinkedIn unread scan never passes string scripts to page.evaluate in production path", async (t) => {
  const fixture = await createAdapterPageFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const originalEvaluate = fixture.page.evaluate.bind(fixture.page);
  let stringEvaluateCalls = 0;
  fixture.page.evaluate = async (fn, arg) => {
    if (typeof fn === "string") {
      stringEvaluateCalls += 1;
      throw new Error("page.evaluate string argument is not allowed in LinkedIn unread scan path");
    }
    return originalEvaluate(fn, arg);
  };

  const threads = await fixture.adapter.scanUnreadThreads();
  assert.equal(stringEvaluateCalls, 0);
  assert.equal(threads.length > 0, true);
});
