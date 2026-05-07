import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { LinkedInAdapter } from "../apps/runner/dist/platforms/linkedin-adapter.js";

function buildAdapter(page) {
  return new LinkedInAdapter({
    screenshotDir: join(tmpdir(), "linkedin-message-screens"),
    domDumpDir: join(tmpdir(), "linkedin-message-dom"),
    resolveSelectors: async () => ({
      inbox_url: "https://www.linkedin.com/messaging/",
      thread_list: "ul.msg-conversations-container__conversations-list",
      thread_item: "li.msg-conversation-listitem",
      unread_badge: ".msg-conversation-card__unread-count .notification-badge__count",
      message_container: ".msg-s-message-list",
      message_item: ".msg-s-event-listitem[data-event-urn]",
      message_text: ".msg-s-event-listitem__body",
      composer_input: "div.msg-form__contenteditable[contenteditable='true']",
      send_button: "button.msg-form__send-button"
    }),
    sessionManager: {
      getManagedPage: async () => page
    },
    personKey: "default",
    scanMaxThreads: 30,
    scanStableIterations: 3,
    scanScrollWaitMs: 80,
    messageBackfillAttempts: 1
  });
}

function buildSelectors() {
  return {
    inbox_url: "https://www.linkedin.com/messaging/",
    thread_list: "ul.msg-conversations-container__conversations-list",
    thread_item: "li.msg-conversation-listitem",
    unread_badge: ".msg-conversation-card__unread-count .notification-badge__count",
    message_container: ".msg-s-message-list",
    message_item: ".msg-s-event-listitem[data-event-urn]",
    message_text: ".msg-s-event-listitem__body",
    composer_input: "div.msg-form__contenteditable[contenteditable='true']",
    send_button: "button.msg-form__send-button"
  };
}

test("LinkedIn message iterator prefers data-event-urn events and handles non-text/system rows safely", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "message-events.html");
  const fixture = await readFile(fixturePath, "utf8");
  await page.setContent(fixture, { waitUntil: "domcontentloaded" });

  const adapter = buildAdapter(page);
  const selectors = buildSelectors();
  const messages = await adapter.collectThreadMessagesWithBackfill(page, selectors, 20);

  await context.close();
  await browser.close();

  assert.equal(messages.length, 6);
  assert.equal(messages[0].platformMessageKey, "urn:li:msg_event:1");
  assert.equal(messages[0].direction, "IN");
  assert.equal(messages[0].text, "Incoming hello");

  assert.equal(messages[1].platformMessageKey, "urn:li:msg_event:2");
  assert.equal(messages[1].direction, "OUT");
  assert.equal(messages[1].text, "Outgoing reply");

  assert.equal(messages[2].platformMessageKey, "urn:li:msg_event:3");
  assert.equal(messages[2].text, "[non-text message]");

  assert.equal(messages[3].platformMessageKey, "urn:li:msg_event:4");
  assert.equal(messages[3].text, "[system event]");

  assert.equal(messages[4].platformMessageKey, "urn:li:msg_event:5");
  assert.equal(messages[4].text, "First paragraph from one LinkedIn event.");
  assert.equal(messages[5].platformMessageKey, "urn:li:msg_event:5:body:1");
  assert.equal(messages[5].text, "Second paragraph from the same event.");
});

test("LinkedIn visible message parser emits separate messages for separate body segments", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "message-events.html");
  const fixture = await readFile(fixturePath, "utf8");
  await page.setContent(fixture, { waitUntil: "domcontentloaded" });

  const adapter = buildAdapter(page);
  const selectors = buildSelectors();
  const messages = await adapter.collectVisibleThreadMessages(page, selectors, 20);

  await context.close();
  await browser.close();

  const first = messages.find((message) => message.platformMessageKey === "urn:li:msg_event:5");
  const second = messages.find((message) => message.platformMessageKey === "urn:li:msg_event:5:body:1");
  assert.equal(first?.text, "First paragraph from one LinkedIn event.");
  assert.equal(second?.text, "Second paragraph from the same event.");
});
