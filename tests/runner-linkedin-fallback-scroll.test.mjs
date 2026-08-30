import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "patchright";
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
  const screenshotDir = await mkdtemp(join(tmpdir(), "linkedin-fallback-scroll-screens-"));
  const domDumpDir = await mkdtemp(join(tmpdir(), "linkedin-fallback-scroll-dom-"));
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
    scanMaxThreads: 80,
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

test("LinkedIn direct fallback deep-scrolls beyond first viewport and exhausts with deep-scroll stop reason", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });

  const result = await fixture.adapter.scanInboxThreadsDirectFallback({
    requestId: "fallback-scroll-test",
    disableDeepScroll: false,
    maxThreads: 80,
    maxOpens: 80
  });

  const names = result.threads.map((thread) => thread.displayName);
  assert.equal(names.includes("Hotel Eight"), true);
  assert.equal(names.includes("India Nine"), true);
  assert.equal(result.threadsScanned > 3, true);
  assert.equal(result.stopReason === "fallback_direct_complete", false);
});

test("LinkedIn fallback refuses to certify freshness without a real scroll container", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });
  await fixture.page.setContent(`
    <ul class="msg-conversations-container__conversations-list">
      <li class="msg-conversation-listitem">One visible row</li>
    </ul>
  `);

  const outcome = await fixture.adapter.deepScrollThreadList(
    fixture.page,
    selectorsForInbox("about:blank"),
    { bottomKey: "one", visibleSetHash: "one" }
  );

  assert.deepEqual(outcome, {
    didScroll: false,
    reachedBottom: false,
    moved: false,
    stopReason: "no_scroll_container"
  });
});

test("LinkedIn fallback treats a missing list after snapshot as incomplete", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });
  await fixture.page.setContent("<main>LinkedIn rerendered the list away</main>");

  const outcome = await fixture.adapter.deepScrollThreadList(
    fixture.page,
    selectorsForInbox("about:blank"),
    { bottomKey: "one", visibleSetHash: "one" }
  );

  assert.deepEqual(outcome, {
    didScroll: false,
    reachedBottom: false,
    moved: false,
    stopReason: "no_scroll_container"
  });
});

test("LinkedIn fallback propagates a scroll execution failure instead of reporting the end", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });
  fixture.adapter.runTracedPageAction = ({ run }) => run();
  const fakeTarget = {
    count: async () => 1,
    evaluate: async () => {
      throw new Error("execution context was destroyed");
    }
  };
  const fakePage = {
    locator: () => ({ first: () => fakeTarget })
  };

  await assert.rejects(
    () =>
      fixture.adapter.deepScrollThreadList(
        fakePage,
        selectorsForInbox("about:blank"),
        { bottomKey: "one", visibleSetHash: "one" }
      ),
    /execution context was destroyed/i
  );
});

test("LinkedIn fallback propagates a list locator failure instead of certifying completeness", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });
  const fakePage = {
    locator: () => ({
      first: () => ({
        count: async () => {
          throw new Error("execution context was destroyed while locating the thread list");
        }
      })
    })
  };

  await assert.rejects(
    () =>
      fixture.adapter.deepScrollThreadList(
        fakePage,
        selectorsForInbox("about:blank"),
        { bottomKey: "one", visibleSetHash: "one" }
      ),
    /execution context was destroyed while locating the thread list/i
  );
});

test("LinkedIn fallback follows real list growth across a filtered-row gap", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });
  await fixture.page.setContent(`
    <ul class="msg-conversations-container__conversations-list" style="height: 80px; overflow-y: auto; margin: 0; padding: 0">
      <li class="msg-conversation-listitem" data-urn="urn:li:msg_conversation:first" style="height: 50px">
        <h3>First Unread</h3>
        <p class="msg-conversation-card__message-snippet">Can you reply?</p>
        <div class="msg-conversation-card__unread-count"><span class="notification-badge__count">1</span></div>
      </li>
      <li class="msg-conversation-listitem" data-urn="urn:li:msg_conversation:replied" style="height: 50px">
        <h3>Already Replied</h3>
        <p class="msg-conversation-card__message-snippet">You: sorted</p>
      </li>
    </ul>
    <script>
      const list = document.querySelector("ul");
      let phase = 0;
      let loading = false;
      list.addEventListener("scroll", () => {
        if (loading || phase >= 2) return;
        loading = true;
        setTimeout(() => {
          if (phase === 0) {
            for (let index = 0; index < 3; index += 1) {
              const row = document.createElement("li");
              row.className = "msg-conversation-listitem";
              row.dataset.urn = "urn:li:msg_conversation:filtered-" + index;
              row.style.height = "50px";
              row.innerHTML = '<h3>Filtered ' + index + '</h3><p class="msg-conversation-card__message-snippet">You: replied</p>';
              list.append(row);
            }
          } else {
            const row = document.createElement("li");
            row.className = "msg-conversation-listitem";
            row.dataset.urn = "urn:li:msg_conversation:later-unread";
            row.style.height = "50px";
            row.innerHTML = '<h3>Later Unread</h3><p class="msg-conversation-card__message-snippet">Please reply</p><div class="msg-conversation-card__unread-count"><span class="notification-badge__count">1</span></div>';
            list.append(row);
          }
          phase += 1;
          loading = false;
        }, 0);
      });
    </script>
  `);

  const selectors = selectorsForInbox("about:blank");
  const before = await fixture.adapter.captureThreadRowsSnapshot(fixture.page, selectors);
  const first = await fixture.adapter.deepScrollThreadList(fixture.page, selectors, before);
  assert.equal(first.moved, true);
  assert.equal(first.reachedBottom, false);

  const middle = await fixture.adapter.captureThreadRowsSnapshot(fixture.page, selectors);
  assert.deepEqual(middle.rows.map((row) => row.displayName), ["First Unread"]);
  const second = await fixture.adapter.deepScrollThreadList(fixture.page, selectors, middle);
  assert.equal(second.moved, true);
  const after = await fixture.adapter.captureThreadRowsSnapshot(fixture.page, selectors);
  assert.equal(after.rows.some((row) => row.displayName === "Later Unread"), true);
});

test("LinkedIn fallback observes delayed virtualized changes even when candidate rows and geometry stay constant", async (t) => {
  const fixture = await createFixture();
  if (fixture.skipped) {
    t.skip(fixture.reason);
    return;
  }

  t.after(async () => {
    await fixture.context.close();
    await fixture.browser.close();
  });
  await fixture.page.setContent(`
    <ul class="msg-conversations-container__conversations-list" style="height: 80px; overflow-y: auto; margin: 0; padding: 0">
      <li class="msg-conversation-listitem" data-urn="urn:li:msg_conversation:first" style="height: 50px">
        <h3>First Unread</h3>
        <p class="msg-conversation-card__message-snippet">Can you reply?</p>
        <div class="msg-conversation-card__unread-count"><span class="notification-badge__count">1</span></div>
      </li>
      <li class="msg-conversation-listitem" data-urn="urn:li:msg_conversation:virtual-slot" style="height: 50px">
        <h3>Filtered A</h3>
        <p class="msg-conversation-card__message-snippet">You: already replied</p>
      </li>
    </ul>
  `);

  const selectors = selectorsForInbox("about:blank");
  await fixture.page.evaluate(() => {
    const list = document.querySelector("ul");
    list.scrollTop = list.scrollHeight;
  });
  const before = await fixture.adapter.captureThreadRowsSnapshot(fixture.page, selectors);
  await fixture.page.evaluate(() => {
    const list = document.querySelector("ul");
    let scheduled = false;
    list.addEventListener("scroll", () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        const slot = list.children[1];
        slot.innerHTML =
          '<h3>Filtered B</h3><p class="msg-conversation-card__message-snippet">You: still replied</p>';
      }, 350);
    });
  });
  const outcome = await fixture.adapter.deepScrollThreadList(fixture.page, selectors, before);
  const after = await fixture.adapter.captureThreadRowsSnapshot(fixture.page, selectors);

  assert.equal(outcome.moved, true);
  assert.equal(outcome.reachedBottom, false);
  assert.equal(after.visibleSetHash, before.visibleSetHash);
  assert.notEqual(after.listWindowHash, before.listWindowHash);
});
