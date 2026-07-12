import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "patchright";
import { LinkedInAdapter } from "../apps/runner/dist/platforms/linkedin-adapter.js";
import {
  hasLinkedInVoice,
  linkedInVoicePath
} from "../apps/runner/dist/services/linkedin-voice-store.js";

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

test("LinkedIn voice-message direct-URL path skips the click when an `<a download>` link is in the DOM", async (t) => {
  // The Lite/Tailwind messaging UI exposes the audio URL directly via
  // `<a class="download-attachment" href="...messaging-audio-analyzed...">`.
  // captureLinkedInVoiceMessage should detect that, fetch the bytes via
  // page.context().request.get (which carries session cookies), and
  // never reach the click-trigger fallback. We assert end-to-end by
  // standing up a tiny HTTP server, rewriting the fixture's href to
  // point at it, and verifying the resulting voice-message file lands
  // on disk under the URN-hashed path.
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // Mock LinkedIn DMS: serve a tiny m4a-ish blob for /messaging-audio-analyzed/*.
  const audioBytes = Buffer.from([
    0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70,
    0x4d, 0x34, 0x41, 0x20, 0xde, 0xad, 0xbe, 0xef
  ]);
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.url && /messaging-audio-analyzed/.test(req.url)) {
      requestCount += 1;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(audioBytes);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  // Clear any cached file from a prior run — captureLinkedInVoiceMessage
  // short-circuits when hasLinkedInVoice(urn) is true, so a stale file
  // would mask the direct-fetch path under test.
  const fixtureUrn = "urn:li:msg_message:(urn:li:fsd_profile:REDACTED,2-REDACTED)";
  await unlink(linkedInVoicePath(fixtureUrn)).catch(() => undefined);

  const context = await browser.newContext();
  const page = await context.newPage();
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "voice-message-lite-ui.html");
  let fixture = await readFile(fixturePath, "utf8");
  // Repoint the fixture's signed CDN URL at the local mock server.
  fixture = fixture.replace(
    /https:\/\/www\.linkedin\.com\/dms\/prv\/vid[^"]+/,
    `http://127.0.0.1:${port}/dms/prv/vid/v2/MOCK/messaging-audio-analyzed/0/MOCK?m=MOCK`
  );
  await page.setContent(fixture, { waitUntil: "domcontentloaded" });

  const adapter = buildAdapter(page);
  const selectors = buildSelectors();
  const messages = await adapter.collectThreadMessagesWithBackfill(page, selectors, 20);

  await context.close();
  await browser.close();
  server.close();

  assert.equal(messages.length, 1, "lite-ui fixture has exactly one voice message");
  const [voice] = messages;
  const [attachment] = voice.attachments;
  assert.equal(attachment.kind, "voice_note");
  assert.equal(attachment.byteSize, audioBytes.length, "byteSize reflects the mock server's response");
  // If the click fallback had fired, it would have tried (and failed)
  // to reach the real linkedin.com CDN — the mock only sees one hit,
  // which means the Lite-UI direct fetch served the request.
  assert.equal(requestCount, 1, "direct fetch hit the mock server exactly once");

  // Bytes landed on disk under the URN-hashed filename so the resolver
  // will find them via hasLinkedInVoice(urn) at transcription time.
  // Clean up after the assertion so the test doesn't pollute the
  // worktree's real data/linkedin-voice-messages/ across runs.
  assert.equal(hasLinkedInVoice(attachment.guid), true);
  const writtenPath = linkedInVoicePath(attachment.guid);
  const onDisk = await readFile(writtenPath);
  assert.equal(onDisk.length, audioBytes.length);
  assert.deepEqual(onDisk, audioBytes);
  await unlink(writtenPath).catch(() => undefined);
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
