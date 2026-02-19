import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
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
    message_container: ".msg-s-message-list",
    message_item: ".msg-s-event-listitem",
    message_text: ".msg-s-event-listitem__body",
    composer_input: ".composer-input",
    send_button: ".send-button"
  };
}

async function createFixture(options = {}) {
  const fixtureName = options.fixtureName ?? "streaming-virtualized.html";
  const selectorOverrides = options.selectorOverrides ?? {};
  const urlHash = options.urlHash ?? "";
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
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-stream-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-stream-dom-"));
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", fixtureName);
  const html = await readFile(fixturePath, "utf8");
  const inboxUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}${urlHash ? (urlHash.startsWith("#") ? urlHash : `#${urlHash}`) : ""}`;

  const adapter = new LinkedInAdapter({
    screenshotDir,
    domDumpDir,
    resolveSelectors: async () => ({
      ...selectorsForInbox(inboxUrl),
      ...selectorOverrides
    }),
    sessionManager: {
      getManagedPage: async () => page
    },
    personKey: "default",
    scanMaxThreads: 60,
    scanStableIterations: 3,
    scanScrollWaitMs: 60,
    messageBackfillAttempts: 1
  });

  return {
    skipped: false,
    adapter,
    page,
    context,
    browser,
    inboxUrl,
    screenshotDir,
    domDumpDir
  };
}

test("LinkedIn streaming scan progresses through virtualized rows without reload/goto churn", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const originalGoto = fixture.page.goto.bind(fixture.page);
  const originalReload = fixture.page.reload.bind(fixture.page);
  let gotoCalls = 0;
  let reloadCalls = 0;

  fixture.page.goto = async (...args) => {
    gotoCalls += 1;
    return originalGoto(...args);
  };
  fixture.page.reload = async (...args) => {
    reloadCalls += 1;
    return originalReload(...args);
  };

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const names = collected.map((entry) => entry.thread.displayName);
  assert.equal(gotoCalls, 1);
  assert.equal(reloadCalls, 0);
  assert.equal(names.includes("Sponsored Row"), false);
  assert.equal(names.includes("Golf Seven"), true);
  assert.equal(names.includes("India Nine"), true);
  assert.equal(
    collected.some((entry) => entry.thread.unreadCount === 0 && entry.thread.needsReplyFromList === true),
    true
  );
  assert.equal(new Set(collected.map((entry) => entry.rowKey)).size, collected.length);
  assert.equal(["end_of_list_reached", "end_of_list_no_progress", "max_threads", "no_scroll_container"].includes(metrics.stopReason), true);
});

test("LinkedIn streaming resolver handles div-based list root and non-UL scroll container", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-div-scroll.html",
    selectorOverrides: {
      thread_list: "#list-root",
      thread_item: ".msg-conversation-listitem"
    }
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-div-scroll-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const names = collected.map((entry) => entry.thread.displayName);
  assert.equal(names.includes("Sponsored Row"), false);
  assert.equal(names.includes("India Nine"), true);
  assert.equal(names.includes("Golf Seven"), true);
  assert.equal(["end_of_list_reached", "end_of_list_no_progress", "max_threads", "no_scroll_container"].includes(metrics.stopReason), true);
});

test("LinkedIn streaming resolver accepts UL+LI+div list layout and opens rows via div click target", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-div-listitem-link.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  await fixture.page.goto(fixture.inboxUrl, { waitUntil: "domcontentloaded" });
  const shellResolution = await fixture.adapter.resolveMessagingShell(fixture.page);
  assert.equal(Boolean(shellResolution), true);
  const listRootResolution = await fixture.adapter.resolveConversationListRoot(fixture.page, shellResolution.handle);
  assert.equal(Boolean(listRootResolution), true);
  const listRootTag = await listRootResolution.handle.evaluate((node) => node.tagName.toLowerCase());
  assert.equal(listRootTag, "ul");

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-ul-li-div-layout-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const names = collected.map((entry) => entry.thread.displayName);
  assert.equal(names.includes("Sponsored Row"), false);
  assert.equal(names.includes("Row One"), true);
  assert.equal(metrics.stopReason === "list_root_not_found", false);
  assert.equal(metrics.openedRows >= 1, true);

  const clickMetrics = await fixture.page.evaluate(() => window.__streamingFixtureMetrics);
  assert.equal(clickMetrics.divClickCount >= 1, true);
  assert.equal(clickMetrics.liDirectClickCount, 0);
});

test("waitForThreadListReadyOrClassified does not return ready on list visibility alone", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-delayed-hydration.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  await fixture.page.goto(fixture.inboxUrl, { waitUntil: "domcontentloaded" });
  await assert.rejects(
    fixture.adapter.waitForThreadListReadyOrClassified(fixture.page, selectorsForInbox(fixture.inboxUrl), 450),
    /Timed out waiting for LinkedIn thread list container to become ready/
  );

  const readiness = await fixture.adapter.waitForThreadListReadyOrClassified(
    fixture.page,
    selectorsForInbox(fixture.inboxUrl),
    2_500
  );
  assert.equal(readiness.ready, true);
  assert.equal(readiness.empty, false);
});

test("LinkedIn streaming scan waits for delayed list hydration and proceeds without list_root_not_found", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-delayed-hydration.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-delayed-hydration-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  assert.equal(metrics.stopReason === "list_root_not_found", false);
  assert.equal(collected.some((entry) => entry.thread.displayName === "Delayed One"), true);
});

test("LinkedIn streaming scan classifies list hydration timeout and emits artifacts", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-hydration-timeout.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  let caught;
  try {
    await fixture.adapter.scanInboxThreadsStream({
      requestId: "stream-hydration-timeout-test",
      onThreadCandidate: async () => {}
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.name, "AdapterFailure");
  assert.equal(caught?.details?.reason, "list_hydration_timeout");
  assert.equal(typeof caught?.details?.diagnosticsJsonPath, "string");
  const diagnostics = JSON.parse(await readFile(caught.details.diagnosticsJsonPath, "utf8"));
  assert.equal(diagnostics.reason, "list_hydration_timeout");
  assert.equal(typeof diagnostics.rowSignalCounts?.["li.msg-conversation-listitem"], "number");
});

test("LinkedIn streaming scan waits for post-click message hydration and skips non-bubble events", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-thread-open-race.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-thread-hydration-race-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const raceThread = collected.find((entry) => entry.thread.displayName === "Race Target");
  assert.equal(Boolean(raceThread), true);
  const messageTexts = (raceThread?.messages ?? []).map((message) => message.text);
  assert.equal(messageTexts.includes("NEW thread message"), true);
  assert.equal(messageTexts.includes("OLD thread message"), false);
  assert.equal(messageTexts.includes("system divider"), false);
});

test("LinkedIn streaming scan completes gracefully when list root is not scrollable", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-no-scroll.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-no-scroll-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const names = collected.map((entry) => entry.thread.displayName);
  assert.equal(metrics.stopReason, "no_scroll_container");
  assert.equal(metrics.scrollIterations, 0);
  assert.equal(names.includes("No Scroll One"), true);
  assert.equal(collected.some((entry) => entry.thread.needsReplyFromList === true), true);
});

test("LinkedIn streaming scan classifies blocked modal failures and emits resolver artifacts", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-blocked-modal.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  let caught;
  try {
    await fixture.adapter.scanInboxThreadsStream({
      requestId: "stream-blocked-modal-test",
      onThreadCandidate: async () => {}
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.name, "AdapterFailure");
  assert.equal(caught?.details?.reason, "blocked_by_modal");
  assert.equal(typeof caught?.details?.diagnosticsJsonPath, "string");
  const diagnostics = JSON.parse(await readFile(caught.details.diagnosticsJsonPath, "utf8"));
  assert.equal(diagnostics.reason, "blocked_by_modal");
  const screenshotFiles = await readdir(fixture.screenshotDir);
  const domFiles = await readdir(fixture.domDumpDir);
  assert.equal(screenshotFiles.some((entry) => entry.endsWith(".png")), true);
  assert.equal(domFiles.some((entry) => entry.endsWith(".html")), true);
  assert.equal(domFiles.some((entry) => entry.includes("linkedin-streaming-resolver")), true);
});

test("LinkedIn streaming scan treats token-matched already-active row as hydrated success without activation mismatch", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-already-active.html",
    urlHash: "#/messaging/thread/active-one/"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-already-active-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  assert.equal(collected.some((entry) => entry.thread.displayName === "Already Active"), true);
  assert.equal(metrics.failures, 0);
});

test("LinkedIn streaming scan does not trust stale active class when token mismatches", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-stale-active-token-mismatch.html",
    urlHash: "#/messaging/thread/live-two/"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-stale-active-token-mismatch-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const staleEntry = collected.find((entry) => entry.thread.displayName === "Stale Active");
  const fixtureMetrics = await fixture.page.evaluate(() => window.__staleActiveFixtureMetrics ?? null);
  if (!staleEntry || (fixtureMetrics?.staleRowClickCount ?? 0) < 1) {
    console.error("stale test debug:", {
      collected: collected.map((c) => c.thread.displayName),
      staleRowClickCount: fixtureMetrics?.staleRowClickCount
    });
  }
  assert.equal(Boolean(staleEntry), true);
  assert.equal(staleEntry?.thread.platformThreadId, "stale-one");
  assert.equal((fixtureMetrics?.staleRowClickCount ?? 0) >= 1, true);
});

test("LinkedIn streaming resolver falls back to configured selector globally when shell-scoped heuristic misses", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-shell-scope-mismatch.html",
    selectorOverrides: {
      thread_list: "#real-thread-list",
      thread_item: "#real-thread-list li.msg-conversation-listitem"
    }
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-shell-scope-mismatch-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const names = collected.map((entry) => entry.thread.displayName);
  assert.equal(metrics.stopReason === "list_root_not_found", false);
  assert.equal(names.includes("Global Fallback"), true);
});

test("LinkedIn streaming scan reveals list from narrow layout back control only when list is absent and message pane exists", async (t) => {
  const fixture = await createFixture({
    fixtureName: "streaming-narrow-layout-back.html"
  });
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const collected = [];
  const metrics = await fixture.adapter.scanInboxThreadsStream({
    requestId: "stream-narrow-layout-back-test",
    onThreadCandidate: async (input) => {
      collected.push(input);
    }
  });

  const names = collected.map((entry) => entry.thread.displayName);
  assert.equal(names.includes("Narrow One"), true);
  const fixtureMetrics = await fixture.page.evaluate(() => window.__narrowFixtureMetrics ?? null);
  assert.equal((fixtureMetrics?.backClicks ?? 0) >= 1, true);
  assert.equal(metrics.stopReason === "list_root_not_found", false);
});
