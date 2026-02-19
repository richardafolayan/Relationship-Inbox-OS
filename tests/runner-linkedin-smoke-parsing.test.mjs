import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  classifyLinkedInSmokeNavigateState,
  classifyLinkedInSmokeUnreadOutcome,
  discoverLinkedInUnreadRows,
  extractLinkedInSmokeFirstThreadRow,
  extractLinkedInSmokeMessages,
  isLinkedInMessagingShellReady
} from "../apps/runner/dist/platforms/linkedin-adapter.js";

async function withPlaywrightPage(t, run) {
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    context = await browser.newContext({
      baseURL: "https://www.linkedin.com"
    });
    const page = await context.newPage();
    await run(page);
  } finally {
    await context?.close();
    await browser?.close();
  }
}

test("LinkedIn smoke discovery ignores spacer rows and parses unread counters", async (t) => {
  await withPlaywrightPage(t, async (page) => {
    const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "smoke-unread.html");
    const fixture = await readFile(fixturePath, "utf8");
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });

    const discovered = await discoverLinkedInUnreadRows(page);
    const row = await extractLinkedInSmokeFirstThreadRow(page);
    const messages = await extractLinkedInSmokeMessages(page, 10);

    assert.equal(discovered.namesCount, 2);
    assert.equal(discovered.clickTargetsCount, 2);
    assert.equal(discovered.primaryClickTargetsCount, 2);

    assert.ok(row);
    assert.equal(row.participantName, "Ada Lovelace");
    assert.equal(row.listTimestamp, "Feb 18");
    assert.equal(row.previewSnippet, "Can we sync tomorrow?");
    assert.equal(row.unreadCount, 6);

    assert.equal(messages.length >= 1, true);
    assert.equal(messages[0].senderName, "Ada Lovelace");
    assert.equal(messages[0].text, "Can we sync tomorrow?");
    assert.equal(messages[0].timestamp, "2026-02-18T16:15:00.000Z");
  });
});

test("LinkedIn smoke discovery uses clickable ancestor fallback when wrapper classes are absent", async (t) => {
  await withPlaywrightPage(t, async (page) => {
    await page.setContent(
      `<!doctype html>
       <html>
         <body>
           <ul class="msg-conversations-container__conversations-list">
             <li></li>
             <li>
               <div tabindex="0" data-row="fallback">
                 <span class="msg-conversation-listitem__participant-names">Fallback Person</span>
                 <time class="msg-conversation-listitem__time-stamp">Now</time>
                 <p class="msg-conversation-card__message-snippet">Fallback snippet</p>
                 <span class="artdeco-notification-badge" aria-label="3 unread messages"></span>
               </div>
             </li>
           </ul>
         </body>
       </html>`,
      { waitUntil: "domcontentloaded" }
    );

    const discovered = await discoverLinkedInUnreadRows(page);
    const row = await extractLinkedInSmokeFirstThreadRow(page);

    assert.equal(discovered.namesCount, 1);
    assert.equal(discovered.primaryClickTargetsCount, 0);
    assert.equal(discovered.clickTargetsCount, 1);
    assert.ok(row);
    assert.equal(row.participantName, "Fallback Person");
    assert.equal(row.unreadCount, 3);
  });
});

test("LinkedIn smoke classifier handles empty, mismatch, and ingest states", () => {
  assert.equal(
    classifyLinkedInSmokeUnreadOutcome({
      emptyStateDetected: true,
      namesCount: 0,
      clickTargetsCount: 0,
      listContainerChildCount: 0,
      unreadCounterValues: []
    }).outcome,
    "EMPTY"
  );

  const mismatch = classifyLinkedInSmokeUnreadOutcome({
    emptyStateDetected: false,
    namesCount: 0,
    clickTargetsCount: 0,
    listContainerChildCount: 2,
    unreadCounterValues: [6]
  });
  assert.equal(mismatch.outcome, "MISMATCH");
  assert.equal(mismatch.reason, "selector_mismatch_thread_rows");

  assert.equal(
    classifyLinkedInSmokeUnreadOutcome({
      emptyStateDetected: false,
      namesCount: 1,
      clickTargetsCount: 1,
      listContainerChildCount: 0,
      unreadCounterValues: []
    }).outcome,
    "INGEST"
  );
});

test("LinkedIn smoke shell readiness accepts messaging thread URL when DOM shell is present", async (t) => {
  await withPlaywrightPage(t, async (page) => {
    const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "smoke-thread-shell.html");
    const fixture = await readFile(fixturePath, "utf8");
    await page.route("**/messaging/thread/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: fixture
      })
    );
    await page.goto("https://www.linkedin.com/messaging/thread/test-thread/?filter=unread", {
      waitUntil: "domcontentloaded"
    });

    const readiness = await isLinkedInMessagingShellReady(page);
    assert.equal(readiness.ok, true);
    assert.equal(readiness.details.url.includes("/messaging/thread/"), true);
  });
});

test("LinkedIn smoke shell readiness returns false without messaging shell signals", async (t) => {
  await withPlaywrightPage(t, async (page) => {
    await page.setContent("<!doctype html><html><body><h1>Plain page</h1></body></html>", {
      waitUntil: "domcontentloaded"
    });
    const readiness = await isLinkedInMessagingShellReady(page);
    assert.equal(readiness.ok, false);
  });
});

test("LinkedIn smoke navigate classifier detects login, checkpoint, and blocked modal states", async (t) => {
  await withPlaywrightPage(t, async (page) => {
    await page.route("**/uas/login**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body><input id='username' /></body></html>"
      })
    );
    await page.goto("https://www.linkedin.com/uas/login", { waitUntil: "domcontentloaded" });
    const loginProbe = (await isLinkedInMessagingShellReady(page)).details;
    const loginState = await classifyLinkedInSmokeNavigateState(page, loginProbe);
    assert.equal(loginState.blocked, true);
    assert.equal(loginState.reason, "login_required");

    await page.route("**/checkpoint/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body>Action required. Verify your identity checkpoint.</body></html>"
      })
    );
    await page.goto("https://www.linkedin.com/checkpoint/challenge", { waitUntil: "domcontentloaded" });
    const checkpointProbe = (await isLinkedInMessagingShellReady(page)).details;
    const checkpointState = await classifyLinkedInSmokeNavigateState(page, checkpointProbe);
    assert.equal(checkpointState.blocked, true);
    assert.equal(checkpointState.reason, "checkpoint_required");

    await page.route("**/messaging/?filter=unread", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body><div id='onetrust-banner-sdk'>Cookie banner</div></body></html>"
      })
    );
    await page.goto("https://www.linkedin.com/messaging/?filter=unread", { waitUntil: "domcontentloaded" });
    const modalProbe = (await isLinkedInMessagingShellReady(page)).details;
    const modalState = await classifyLinkedInSmokeNavigateState(page, modalProbe);
    assert.equal(modalState.blocked, true);
    assert.equal(modalState.reason, "blocked_by_modal");
  });
});
