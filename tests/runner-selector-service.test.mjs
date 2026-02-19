import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createSelectorTestService } from "../apps/runner/dist/services/selector-tests.js";

test("selector test service returns counts and screenshots on deterministic local HTML", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const screenshotDir = await mkdtemp(join(tmpdir(), "selector-service-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "selector-service-dom-"));

  t.after(async () => {
    await context.close();
    await browser.close();
  });

  const html = `
    <html>
      <body>
        <main class="scaffold-layout__main">
          <section class="msg-conversations-container">
            <ul class="thread-list">
              <li class="thread-item">Alice</li>
              <li class="thread-item">Bob</li>
            </ul>
            <p class="thread-snippet">Alice: checking in</p>
          </section>
          <div class="message-container">
            <div class="message-item"><span class="message-text">Hello there</span></div>
          </div>
          <div class="composer" contenteditable="true"></div>
          <button class="send">Send</button>
        </main>
      </body>
    </html>
  `;
  const inboxUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const service = createSelectorTestService({
    resolveSelectors: async () => ({
      inbox_url: inboxUrl,
      thread_list: ".thread-list",
      thread_item: ".thread-item",
      unread_badge: ".unread",
      thread_snippet: ".thread-snippet",
      message_container: ".message-container",
      message_item: ".message-item",
      message_text: ".message-text",
      composer_input: ".composer",
      send_button: ".send"
    }),
    sessionManager: {
      getManagedPage: async () => page
    },
    screenshotDir,
    domDumpDir
  });

  const report = await service.run({ platform: "LINKEDIN" });

  assert.equal(report.platform, "LINKEDIN");
  assert.equal(report.results.length >= 8, true);
  assert.equal(report.results.some((entry) => entry.key === "thread_item" && entry.count === 2), true);
  assert.equal(report.results.some((entry) => entry.key === "message_text" && entry.count === 1), true);
  const unreadBadgeResult = report.results.find((entry) => entry.key === "unread_badge");
  assert.equal(unreadBadgeResult?.count, 0);
  assert.equal(unreadBadgeResult?.status, "PASS");
  const navigateReceipt = report.receipts.find((entry) => entry.stage === "navigate");
  assert.equal(typeof navigateReceipt?.details?.effectiveSelectors?.thread_list, "string");
  assert.equal(typeof navigateReceipt?.details?.effectiveSelectors?.thread_item, "string");
  assert.equal(typeof navigateReceipt?.details?.counts?.global?.thread_list, "number");
  assert.equal(typeof navigateReceipt?.details?.counts?.global?.thread_item, "number");
  assert.equal(typeof navigateReceipt?.details?.counts?.shell?.thread_list, "number");
  assert.equal(typeof navigateReceipt?.details?.counts?.shell?.thread_item, "number");
  assert.equal(typeof navigateReceipt?.details?.shellSummary?.selector, "string");

  const screenshotFile = report.results.find((entry) => entry.screenshotFile)?.screenshotFile;
  assert.equal(typeof screenshotFile, "string");
  assert.equal(existsSync(join(screenshotDir, screenshotFile)), true);
});
