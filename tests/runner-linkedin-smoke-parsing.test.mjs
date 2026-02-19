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
  getConversationRowCandidates,
  isLinkedInMessagingShellReady,
  waitUnreadRowsOrEmptyState
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

test("LinkedIn smoke row candidates ignore spacer li and accept div/a/button link targets", async (t) => {
  await withPlaywrightPage(t, async (page) => {
    const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "smoke-thread-shell.html");
    const fixture = await readFile(fixturePath, "utf8");
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });

    const discovery = await getConversationRowCandidates(page);
    assert.equal(discovery.directLiCount, 4);
    assert.equal(discovery.candidates.length, 3);
    assert.equal(discovery.liWithParticipantAndLinkCount, 3);
    assert.equal(discovery.candidates[0].participantName, "Anchor Person");
    assert.equal(discovery.candidates[1].participantName, "Button Person");
    assert.equal(discovery.candidates[2].participantName, "Thread Route Person");
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
    assert.equal(readiness.details.visibleFilterPills, true);
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

    await page.route("**/messaging/modal", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body:
          "<!doctype html><html><body><div role='dialog' aria-modal='true' style='width:320px;height:320px'>Visible modal body text</div></body></html>"
      })
    );
    await page.goto("https://www.linkedin.com/messaging/modal", { waitUntil: "domcontentloaded" });
    const modalProbe = (await isLinkedInMessagingShellReady(page)).details;
    const modalState = await classifyLinkedInSmokeNavigateState(page, modalProbe);
    assert.equal(modalState.blocked, true);
    assert.equal(modalState.reason, "blocked_by_modal");
    assert.equal((modalState.modalTextSnippet ?? "").includes("Visible modal body text"), true);

    await page.setContent("<!doctype html><html><body><div id='artdeco-modal-outlet'></div></body></html>", {
      waitUntil: "domcontentloaded"
    });
    const scaffoldingProbe = (await isLinkedInMessagingShellReady(page)).details;
    const scaffoldingState = await classifyLinkedInSmokeNavigateState(page, scaffoldingProbe);
    assert.equal(scaffoldingState.blocked, false);
  });
});

test("LinkedIn unread wait ignores center 'No messages...yet!' state", async (t) => {
  await withPlaywrightPage(t, async (page) => {
    const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "smoke-thread-shell.html");
    const fixture = await readFile(fixturePath, "utf8");
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });
    const rowsReady = await waitUnreadRowsOrEmptyState(page, 1200);
    assert.equal(rowsReady.state, "ROWS_READY");

    await page.setContent(
      `<!doctype html><html><body>
        <button data-test-messaging-inbox-filters__filter-pill="UNREAD" aria-pressed="true">Unread</button>
        <section class="msg-conversations-container">
          <input aria-label="Search messages" placeholder="Search messages" />
          <ul class="msg-conversations-container__conversations-list"><li></li></ul>
        </section>
        <section><h2>No messages...yet!</h2><button>New message</button></section>
      </body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    const timedOut = await waitUnreadRowsOrEmptyState(page, 700);
    assert.equal(timedOut.state, "TIMEOUT");
  });
});
