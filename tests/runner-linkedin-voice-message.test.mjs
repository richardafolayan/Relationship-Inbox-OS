import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { LinkedInAdapter } from "../apps/runner/dist/platforms/linkedin-adapter.js";

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

function buildAdapter(page) {
  return new LinkedInAdapter({
    screenshotDir: join(tmpdir(), "linkedin-voice-screens"),
    domDumpDir: join(tmpdir(), "linkedin-voice-dom"),
    resolveSelectors: async () => buildSelectors(),
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

test("LinkedIn voice-message bubble emits a voice_note attachment with the URN as guid", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "voice-message.html");
  const fixture = await readFile(fixturePath, "utf8");
  await page.setContent(fixture, { waitUntil: "domcontentloaded" });

  const adapter = buildAdapter(page);
  // The real captureLinkedInVoiceMessage triggers an 8s waitForResponse +
  // click against LinkedIn's CDN. We can't reach LinkedIn from a static
  // fixture, so stub the capture to return a known result and assert the
  // parser builds the right attachment shape around it. The capture path
  // itself is exercised end-to-end via the verification step in #371.
  const originalCapture = adapter.captureLinkedInVoiceMessage;
  adapter.captureLinkedInVoiceMessage = async () => ({
    path: "/tmp/test-voice.m4a",
    byteSize: 150373
  });

  const selectors = buildSelectors();
  const messages = await adapter.collectThreadMessagesWithBackfill(page, selectors, 20);

  adapter.captureLinkedInVoiceMessage = originalCapture;
  await context.close();
  await browser.close();

  assert.equal(messages.length, 1, "fixture has exactly one voice message");
  const [voice] = messages;
  assert.equal(voice.text, "[voice message]", "no body text falls back to voice-message marker");
  assert.equal(voice.direction, "IN", "msg-s-event-listitem--other => inbound");

  assert.equal(voice.attachments.length, 1, "single voice-note attachment");
  const [attachment] = voice.attachments;
  assert.equal(attachment.kind, "voice_note");
  assert.equal(attachment.type, "audio/mp4");
  assert.equal(attachment.manualReview, false);
  assert.equal(attachment.rawLabel, "Voice message");
  assert.equal(attachment.byteSize, 150373);
  assert.match(
    attachment.guid,
    /^urn:li:msg_message:/,
    "guid is the LinkedIn message URN so the resolver can look up the on-disk bytes"
  );
});

test("LinkedIn voice-message bubble survives a failed audio capture (bytes never arrive)", async (t) => {
  // Capture stalls happen in the wild — LinkedIn's signed CDN URLs
  // occasionally time out, or the page navigates away mid-wait. The
  // adapter should still emit a voice_note attachment so the
  // transcription service records a `missing_file` skip the operator
  // can retry. Without that, the message would silently degrade back
  // to "[non-text message]" with no kind set.
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "voice-message.html");
  const fixture = await readFile(fixturePath, "utf8");
  await page.setContent(fixture, { waitUntil: "domcontentloaded" });

  const adapter = buildAdapter(page);
  adapter.captureLinkedInVoiceMessage = async () => null;

  const selectors = buildSelectors();
  const messages = await adapter.collectThreadMessagesWithBackfill(page, selectors, 20);

  await context.close();
  await browser.close();

  assert.equal(messages.length, 1);
  const [voice] = messages;
  const [attachment] = voice.attachments;
  assert.equal(attachment.kind, "voice_note");
  assert.equal(attachment.byteSize, undefined, "no byteSize when capture failed");
  assert.match(attachment.guid, /^urn:li:msg_message:/);
});
