import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "patchright";
import {
  canonicalInstagramThreadUrl,
  classifyInstagramAuthRequirement,
  classifyInstagramThreadCollectionError,
  extractInstagramMessageSnapshotsFromPayload,
  extractInstagramRealtimeTextSend,
  extractInstagramTextSendMutationRequest,
  extractInstagramTextSendMutationResponse,
  extractInstagramThreadSnapshotsFromPayload,
  findNewAcknowledgedInstagramOutgoing,
  InstagramNetworkMessageCapture,
  InstagramNetworkSendCapture,
  InstagramNetworkThreadCapture,
  instagramEmptyInboxText,
  isInstagramExplicitEmptyInbox,
  instagramMessageFallbackKey,
  instagramAuthRequiredFromSignals,
  instagramThreadIdFromUrl,
  InstagramAdapter,
  InstagramParsingError,
  instagramThreadUrlMatches,
  mergeInstagramThreadSnapshotSources,
  normalizeInstagramMessageSnapshots,
  normalizeInstagramThreadSnapshots,
  parseInstagramSourceTimestamp,
  resolveInstagramCollectionStopReason
} from "../apps/runner/dist/platforms/instagram-adapter.js";
import { assertInstagramManualTextSend } from "../apps/runner/dist/services/send.js";
import {
  createSelectorTestService,
  shouldCaptureSelectorArtifacts,
  shouldProbeSelectorTestConversation
} from "../apps/runner/dist/services/selector-tests.js";

function withBrowserRuntime(page) {
  const context = {
    addInitScript: async () => {
      if (page.failInitScript) {
        throw new Error("init script unavailable");
      }
    }
  };
  const evaluate = page.evaluate;
  const runtimePage = {
    ...page,
    context: () => context,
    addScriptTag: async () => undefined,
    evaluate: async (...args) => {
      if (typeof args[0] === "string") {
        page.onRuntimeShim?.();
        return undefined;
      }
      return evaluate(...args);
    }
  };
  runtimePage.$ = async () => ({
    evaluate: runtimePage.evaluate
  });
  return runtimePage;
}

async function bindAtomicComposerOwnership(
  adapter,
  composer,
  headerSelector = "main header h1"
) {
  const binding = await adapter.requireComposerOwnershipBinding(
    composer,
    headerSelector
  );
  return {
    composerConversationContainer: binding.conversationContainer,
    composerDocumentPath: binding.documentPath
  };
}

test("Instagram authentication detection covers current and legacy login forms", () => {
  assert.equal(
    instagramAuthRequiredFromSignals({
      url: "https://www.instagram.com/accounts/login/?next=%2Fdirect%2Finbox%2F"
    }),
    true
  );
  assert.equal(
    instagramAuthRequiredFromSignals({
      url: "https://www.instagram.com/",
      fieldNames: ["email", "pass"]
    }),
    true
  );
  assert.equal(
    instagramAuthRequiredFromSignals({
      url: "https://www.instagram.com/",
      fieldNames: ["username", "password"]
    }),
    true
  );
  assert.equal(
    instagramAuthRequiredFromSignals({
      url: "https://www.instagram.com/direct/inbox/",
      bodyText: "Messages"
    }),
    false
  );
  assert.equal(
    classifyInstagramAuthRequirement({
      url: "https://www.instagram.com/auth_platform/recaptcha/?apc=example"
    }),
    "verification_required"
  );
  assert.equal(
    classifyInstagramAuthRequirement({
      url: "https://www.instagram.com/",
      hasRecaptcha: true
    }),
    "verification_required"
  );
});

test("interactive login waits for an authenticated inbox while background checks fail fast", async () => {
  const selectors = {
    inbox_url: "https://www.instagram.com/direct/inbox/",
    thread_list: "main",
    thread_item: "a[href^='/direct/t/']",
    unread_badge: "[data-unread]",
    message_container: "main",
    message_item: "[data-message]",
    message_text: "[data-text]",
    composer_input: "[contenteditable='true']",
    send_button: "[aria-label='Send']"
  };
  let broughtToFront = 0;
  let authenticatedCookieSyncs = 0;
  const authenticatedPage = withBrowserRuntime({
    goto: async () => undefined,
    bringToFront: async () => {
      broughtToFront += 1;
    },
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async () => ({ fieldNames: [], bodyText: "" }),
    url: () => "https://www.instagram.com/direct/inbox/"
  });
  const authenticated = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => authenticatedPage },
    personKey: "instagram",
    connectTimeoutMs: 50,
    syncPersonalSessionCookies: async () => {
      authenticatedCookieSyncs += 1;
      return true;
    }
  });

  await authenticated.connectInteractively();
  assert.equal(broughtToFront, 1);
  assert.equal(authenticatedCookieSyncs, 0);

  let currentDocumentShimRuns = 0;
  const runtimeProtectedPage = withBrowserRuntime({
    ...authenticatedPage,
    evaluate: authenticatedPage.evaluate,
    failInitScript: true,
    onRuntimeShim: () => {
      currentDocumentShimRuns += 1;
    }
  });
  const runtimeProtected = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => runtimeProtectedPage },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await runtimeProtected.connectInteractively();
  assert.equal(currentDocumentShimRuns, 1);

  const loginPage = {
    ...authenticatedPage,
    getByText: () => ({
      count: async () => 0,
      first: () => ({ waitFor: async () => undefined }),
      isEnabled: async () => false
    }),
    waitForFunction: async () => {
      throw new Error("not ready");
    },
    evaluate: async () => ({ fieldNames: ["email", "pass"], bodyText: "Log in to Instagram" }),
    url: () => "https://www.instagram.com/accounts/login/"
  };
  const unauthenticated = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => loginPage },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await assert.rejects(
    () => unauthenticated.ensureConnected(),
    (error) => error?.kind === "AUTH_REQUIRED"
  );
  await assert.rejects(
    () => unauthenticated.connectInteractively(),
    (error) => error?.kind === "AUTH_REQUIRED"
  );

  let savedProfileUrl = "https://www.instagram.com/accounts/login/";
  let continueClicks = 0;
  const savedProfilePage = {
    ...authenticatedPage,
    url: () => savedProfileUrl,
    getByText: (text) =>
      text === "Continue"
        ? {
            count: async () => 1,
            isEnabled: async () => true,
            click: async () => {
              continueClicks += 1;
              savedProfileUrl = "https://www.instagram.com/direct/inbox/";
            }
          }
        : {
            count: async () => 1,
            first: () => ({ waitFor: async () => undefined })
          }
  };
  const savedProfile = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => savedProfilePage },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await savedProfile.connectInteractively();
  assert.equal(continueClicks, 1);

  let bridgedProfileUrl = "https://www.instagram.com/accounts/login/";
  let cookieSyncs = 0;
  const bridgedProfilePage = {
    ...authenticatedPage,
    url: () => bridgedProfileUrl,
    getByText: () => ({
      count: async () => 0,
      first: () => ({ waitFor: async () => undefined }),
      isEnabled: async () => false
    }),
    evaluate: async () =>
      bridgedProfileUrl.includes("/accounts/login/")
        ? { fieldNames: ["username", "password"], bodyText: "Log in to Instagram" }
        : { fieldNames: [], bodyText: "" }
  };
  const bridgedProfile = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => bridgedProfilePage },
    personKey: "instagram",
    connectTimeoutMs: 50,
    syncPersonalSessionCookies: async () => {
      cookieSyncs += 1;
      bridgedProfileUrl = "https://www.instagram.com/direct/inbox/";
      return true;
    }
  });

  await bridgedProfile.connectInteractively();
  assert.equal(cookieSyncs, 1);

  const verificationPage = {
    ...authenticatedPage,
    evaluate: async () => ({
      fieldNames: [],
      bodyText: "Security check",
      hasRecaptcha: true
    }),
    url: () => "https://www.instagram.com/auth_platform/recaptcha/"
  };
  const verificationRequired = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => verificationPage },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await assert.rejects(
    () => verificationRequired.connectInteractively(),
    (error) =>
      error?.kind === "AUTH_REQUIRED" &&
      error?.details?.reason === "instagram_verification_required"
  );
});

test("Instagram thread URLs yield exact stable identities", () => {
  assert.equal(
    instagramThreadIdFromUrl("https://www.instagram.com/direct/t/123456789/"),
    "123456789"
  );
  assert.equal(instagramThreadIdFromUrl("/direct/t/abc_DEF-12/"), "abc_DEF-12");
  assert.equal(instagramThreadIdFromUrl("https://example.com/direct/t/123/"), null);
  assert.equal(instagramThreadIdFromUrl("https://www.instagram.com/direct/inbox/"), null);
  assert.equal(
    canonicalInstagramThreadUrl("abc_DEF-12"),
    "https://www.instagram.com/direct/t/abc_DEF-12/"
  );
  assert.equal(
    instagramThreadUrlMatches(
      "https://www.instagram.com/direct/t/abc_DEF-12/",
      "abc_DEF-12"
    ),
    true
  );
  assert.equal(
    instagramThreadUrlMatches("https://www.instagram.com/direct/t/wrong/", "abc_DEF-12"),
    false
  );
});

test("thread identity is stable across row order and duplicate rows", () => {
  const first = normalizeInstagramThreadSnapshots([
    {
      href: "/direct/t/one/",
      displayName: "Person One",
      preview: "First",
      unread: false
    },
    {
      href: "/direct/t/two/",
      displayName: "Person Two",
      preview: "Second",
      unread: true
    },
    {
      href: "/direct/t/two/",
      displayName: "Person Two",
      preview: "Second",
      unread: false
    }
  ]);
  const reordered = normalizeInstagramThreadSnapshots([
    { href: "/direct/t/two/", displayName: "Person Two", unread: true },
    { href: "/direct/t/one/", displayName: "Person One", unread: false }
  ]);

  assert.deepEqual(
    first.map((thread) => thread.platformThreadId).sort(),
    reordered.map((thread) => thread.platformThreadId).sort()
  );
  assert.equal(first.length, 2);
  assert.equal(first.find((thread) => thread.platformThreadId === "two")?.unreadCount, 1);
  assert.equal(
    first.find((thread) => thread.platformThreadId === "two")?.recipientVerificationLabel,
    "Person Two"
  );
});

test("network and DOM overlap is deduplicated before the distinct-thread limit", () => {
  const merged = mergeInstagramThreadSnapshotSources({
    networkSnapshots: [
      { stableId: "a", displayName: "A", unread: false },
      { stableId: "b", displayName: "B", unread: false }
    ],
    domSnapshots: [
      { href: "/direct/t/a/", displayName: "A", unread: true },
      { href: "/direct/t/c/", displayName: "C", unread: false },
      { href: "/direct/t/d/", displayName: "D", unread: false }
    ],
    limit: 3
  });

  assert.deepEqual(merged.map((thread) => thread.platformThreadId), ["a", "c", "d"]);
  assert.equal(merged[0].unreadCount, 1);
});

test("live DOM unread threads take priority before the distinct-thread limit", () => {
  const merged = mergeInstagramThreadSnapshotSources({
    networkSnapshots: [
      { stableId: "network-a", displayName: "A" },
      { stableId: "network-b", displayName: "B" },
      { stableId: "network-c", displayName: "C" }
    ],
    domSnapshots: [
      { href: "/direct/t/live-unread/", displayName: "Live unread", unread: true }
    ],
    limit: 3
  });

  assert.deepEqual(
    merged.map((thread) => thread.platformThreadId),
    ["live-unread", "network-a", "network-b"]
  );
  assert.equal(merged[0].unreadCount, 1);
});

test("network unread threads take priority before the distinct-thread limit", () => {
  const merged = mergeInstagramThreadSnapshotSources({
    networkSnapshots: [
      { stableId: "network-unread", displayName: "Unread", unread: true }
    ],
    domSnapshots: [
      { href: "/direct/t/recent-a/", displayName: "A", unread: false },
      { href: "/direct/t/recent-b/", displayName: "B", unread: false },
      { href: "/direct/t/recent-c/", displayName: "C", unread: false }
    ],
    limit: 3
  });

  assert.deepEqual(
    merged.map((thread) => thread.platformThreadId),
    ["network-unread", "recent-a", "recent-b"]
  );
  assert.equal(merged[0].unreadCount, 1);
});

test("network unread evidence overrides a read DOM row before limiting", () => {
  const merged = mergeInstagramThreadSnapshotSources({
    networkSnapshots: [
      { stableId: "shared", displayName: "Network name", unread: true }
    ],
    domSnapshots: [
      { href: "/direct/t/recent/", displayName: "Recent", unread: false },
      { href: "/direct/t/shared/", displayName: "DOM name", unread: false }
    ],
    limit: 1
  });

  assert.deepEqual(merged.map((thread) => thread.platformThreadId), ["shared"]);
  assert.equal(merged[0].unreadCount, 1);
  assert.equal(merged[0].displayName, "DOM name");
});

test("fetchRecentThreads prioritizes unread rows before applying its limit", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(
      `Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    const row = (id, unread = false) => `
      <a data-thread href="/direct/t/${id}/">
        <span title="${id.toUpperCase()}">${id.toUpperCase()}</span>
        ${unread ? "<span data-unread></span>" : ""}
      </a>`;
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>
        ${row("r1")}${row("r2")}${row("r3")}
        ${row("u1", true)}${row("u2", true)}${row("u3", true)}
      </main>`
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "[data-thread]",
      thread_link: "a[href*='/direct/t/']",
      thread_identity: "span[title]",
      unread_badge: "[data-unread]",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  const threads = await adapter.fetchRecentThreads(3);
  assert.deepEqual(
    threads.map((thread) => [thread.platformThreadId, thread.unreadCount]),
    [["u1", 1], ["u2", 1], ["u3", 1]]
  );
});

test("fetchRecentThreads waits for an in-flight network-only unread thread before limiting", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(
      `Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (/\/api\/graphql$/.test(url.pathname)) {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            inbox: {
              threads: [
                {
                  id: "network-unread",
                  thread_title: "Network unread",
                  has_unread: true
                }
              ]
            }
          }
        })
      });
      return;
    }
    const row = (id) => `
      <a data-thread href="/direct/t/${id}/">
        <span title="${id.toUpperCase()}">${id.toUpperCase()}</span>
      </a>`;
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>
        ${row("r1")}${row("r2")}${row("r3")}
        <script>fetch('/api/graphql', { method: 'POST' })</script>
      </main>`
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "[data-thread]",
      thread_link: "a[href*='/direct/t/']",
      thread_identity: "span[title]",
      unread_badge: "[data-unread]",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  const threads = await adapter.fetchRecentThreads(3);
  assert.deepEqual(
    threads.map((thread) => [thread.platformThreadId, thread.unreadCount]),
    [["network-unread", 1], ["r1", 0], ["r2", 0]]
  );
});

test("one collection cycle reuses its authoritative network snapshot across unread and recent views", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(
      `Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  let inboxNavigations = 0;
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (/\/api\/graphql$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            get_slide_mailbox_for_iris_subscription: {
              threads_by_folder: {
                edges: [
                  {
                    node: {
                      __typename: "SlideThread",
                      id: "opaque-wrapper-one",
                      as_ig_direct_thread: {
                        id: "canonical-one",
                        users: [{ username: "Person One" }],
                        has_unread: true
                      }
                    }
                  },
                  {
                    node: {
                      __typename: "SlideThread",
                      id: "opaque-wrapper-two",
                      as_ig_direct_thread: {
                        id: "canonical-two",
                        users: [{ username: "Person Two" }],
                        has_unread: false
                      }
                    }
                  }
                ]
              }
            }
          }
        })
      });
      return;
    }
    inboxNavigations += 1;
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>${
        inboxNavigations === 1
          ? "<script>fetch('/api/graphql', { method: 'POST' })</script>"
          : ""
      }</main>`
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "[data-thread]",
      thread_link: "a[href*='/direct/t/']",
      thread_identity: "span[title]",
      unread_badge: "[data-unread]",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  adapter.collectionBoundary.beginCycle();
  const unread = await adapter.scanUnreadThreads();
  const recent = await adapter.fetchRecentThreads(10);

  assert.deepEqual(unread.map((thread) => thread.platformThreadId), ["canonical-one"]);
  assert.deepEqual(
    recent.map((thread) => thread.platformThreadId),
    ["canonical-one", "canonical-two"]
  );
  assert.equal(inboxNavigations, 1);
});

test("Instagram collection stays incomplete unless every collection view proves empty", () => {
  assert.equal(
    resolveInstagramCollectionStopReason({
      collectionCalls: 2,
      observedRows: true,
      explicitlyEmpty: false
    }),
    "instagram_bounded_snapshot"
  );
  assert.equal(
    resolveInstagramCollectionStopReason({
      collectionCalls: 2,
      observedRows: false,
      explicitlyEmpty: true
    }),
    "zero_threads_found"
  );
  assert.equal(
    resolveInstagramCollectionStopReason({
      collectionCalls: 0,
      observedRows: false,
      explicitlyEmpty: true
    }),
    "instagram_bounded_snapshot"
  );
});

test("Instagram exposes its collection boundary through the typed adapter capability", () => {
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  adapter.collectionBoundary.beginCycle();
  assert.deepEqual(adapter.collectionBoundary.getMetrics(), {
    totalFound: 0,
    unreadFound: 0,
    failures: 0,
    completeness: "incomplete",
    nativeStopReason: "instagram_bounded_snapshot"
  });
});

test("same-cycle collection replay is browser-free, limit-aware, and preserves empty proof", async () => {
  let pageRequested = false;
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {
      getManagedPage: async () => {
        pageRequested = true;
        throw new Error("cached collection unexpectedly requested a page");
      }
    },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  adapter.collectionBoundary.beginCycle();
  adapter.cachedCollectionThreads = {
    cycleId: adapter.collectionCycleId,
    explicitlyEmpty: false,
    threads: [
      {
        platformThreadId: "unread-thread",
        displayName: "Unread",
        recipientVerificationLabel: "Unread",
        unreadCount: 1,
        lastMessagePreview: "",
        threadUrl: "https://www.instagram.com/direct/t/unread-thread/"
      },
      {
        platformThreadId: "recent-thread",
        displayName: "Recent",
        recipientVerificationLabel: "Recent",
        unreadCount: 0,
        lastMessagePreview: "",
        threadUrl: "https://www.instagram.com/direct/t/recent-thread/"
      }
    ]
  };

  assert.deepEqual(
    (await adapter.scanUnreadThreads()).map((thread) => thread.platformThreadId),
    ["unread-thread"]
  );
  assert.deepEqual(
    (await adapter.fetchRecentThreads(1)).map((thread) => thread.platformThreadId),
    ["unread-thread"]
  );
  assert.equal(pageRequested, false);
  assert.deepEqual(adapter.collectionBoundary.getMetrics(), {
    totalFound: 2,
    unreadFound: 1,
    failures: 0,
    completeness: "incomplete",
    nativeStopReason: "instagram_bounded_snapshot"
  });

  adapter.collectionBoundary.beginCycle();
  adapter.cachedCollectionThreads = {
    cycleId: adapter.collectionCycleId,
    explicitlyEmpty: true,
    threads: []
  };
  assert.deepEqual(await adapter.scanUnreadThreads(), []);
  assert.deepEqual(await adapter.fetchRecentThreads(10), []);
  assert.deepEqual(adapter.collectionBoundary.getMetrics(), {
    totalFound: 0,
    unreadFound: 0,
    failures: 0,
    completeness: "complete",
    nativeStopReason: "zero_threads_found"
  });
  assert.equal(pageRequested, false);
});

test("same-cycle collection metrics describe the full snapshot beyond per-view limits", async () => {
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {
      getManagedPage: async () => {
        throw new Error("cached collection unexpectedly requested a page");
      }
    },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const threads = Array.from({ length: 95 }, (_, index) => ({
    platformThreadId: `thread-${index}`,
    displayName: `Thread ${index}`,
    recipientVerificationLabel: `Thread ${index}`,
    unreadCount: index % 10 === 0 ? 1 : 0,
    lastMessagePreview: "",
    threadUrl: `https://www.instagram.com/direct/t/thread-${index}/`
  }));

  adapter.collectionBoundary.beginCycle();
  adapter.cachedCollectionThreads = {
    cycleId: adapter.collectionCycleId,
    explicitlyEmpty: false,
    threads
  };

  assert.equal((await adapter.scanUnreadThreads()).length, 8);
  assert.equal((await adapter.fetchRecentThreads(3)).length, 3);
  assert.deepEqual(adapter.collectionBoundary.getMetrics(), {
    totalFound: 95,
    unreadFound: 10,
    failures: 0,
    completeness: "incomplete",
    nativeStopReason: "instagram_bounded_snapshot"
  });
});

test("GraphQL thread payloads use only typed thread IDs and ignore unsupported fallbacks", () => {
  const payload = {
    data: {
      threadDetail: {
        __typename: "XDTDirectThread",
        id: "unrelated-thread-detail",
        thread_title: "Unrelated detail"
      },
      inbox: {
        threads: [
          {
            id: "thread-two-url",
            thread_id: "thread-two-internal",
            thread_fbid: "thread-two-fbid",
            users: [{ username: "Person Two" }],
            unread_count: 2
          },
          {
            thread_id: "thread-one",
            thread_key: "thread-one-key",
            thread_title: "Person One",
            marked_as_unread: true
          },
          {
            id: "not-a-thread",
            title: "Unrelated object"
          },
          {
            id: "message-shaped-untyped",
            thread_key: { thread_fbid: "thread-two-url" }
          },
          {
            __typename: "XDTDirectMessage",
            id: "message-shaped-typed",
            thread_fbid: "thread-two-url",
            items: [
              {
                id: "message-child-shaped-like-thread",
                thread_title: "Nested message metadata"
              }
            ]
          },
          {
            __typename: "XDTDirectThread",
            id: "typed-thread",
            thread_v2_id: "typed-thread-internal",
            participants: [{ full_name: "Typed Person" }],
            has_unread: true
          }
        ]
      },
      duplicate: {
        id: "thread-two-url",
        threadId: "thread-two-internal",
        thread_key: "thread-two-key",
        readState: "UNREAD"
      }
    }
  };

  const first = normalizeInstagramThreadSnapshots(
    extractInstagramThreadSnapshotsFromPayload(payload)
  );
  const reordered = normalizeInstagramThreadSnapshots(
    extractInstagramThreadSnapshotsFromPayload({
      data: {
        duplicate: payload.data.duplicate,
        inbox: { threads: [...payload.data.inbox.threads].reverse() }
      }
    })
  );

  assert.deepEqual(
    first.map((thread) => thread.platformThreadId).sort(),
    ["thread-two-url", "typed-thread"]
  );
  assert.deepEqual(
    first.map((thread) => thread.platformThreadId).sort(),
    reordered.map((thread) => thread.platformThreadId).sort()
  );
  assert.equal(
    first.find((thread) => thread.platformThreadId === "thread-two-url")?.unreadCount,
    1
  );
  assert.equal(first.some((thread) => thread.platformThreadId === "thread-one"), false);
  assert.equal(first.find((thread) => thread.platformThreadId === "typed-thread")?.unreadCount, 1);
});

test("SlideMailbox wrappers expose only the nested direct-thread canonical ID", () => {
  const snapshots = extractInstagramThreadSnapshotsFromPayload({
    data: {
      get_slide_mailbox_for_iris_subscription: {
        __typename: "SlideMailbox",
        threads_by_folder: {
          edges: [
            {
              node: {
                __typename: "SlideThread",
                id: "opaque-slide-wrapper",
                as_ig_direct_thread: {
                  id: "canonical-thread-id",
                  thread_id: "internal-thread-id",
                  thread_fbid: "internal-thread-fbid",
                  thread_key: "internal-thread-key",
                  thread_title: "Verified recipient",
                  usersWithoutViewer: [{ username: "verified-recipient" }],
                  marked_as_unread: true,
                  slide_messages: {
                    edges: [
                      {
                        node: {
                          __typename: "SlideMessage",
                          id: "message-id",
                          message_id: "message-native-id",
                          thread_fbid: "internal-thread-fbid"
                        }
                      }
                    ]
                  }
                }
              }
            }
          ]
        },
        unrelated_edges: [
          {
            node: {
              __typename: "SlideThread",
              as_ig_direct_thread: {
                id: "false-positive-inside-mailbox",
                thread_title: "Wrong collection",
                slide_messages: { edges: [] }
              }
            }
          }
        ]
      },
      unrelated_mailbox: {
        edges: [
          {
            node: {
              __typename: "SlideThread",
              as_ig_direct_thread: {
                id: "false-positive-other-mailbox",
                thread_title: "Wrong mailbox",
                slide_messages: { edges: [] }
              }
            }
          }
        ]
      }
    }
  });

  assert.deepEqual(snapshots, [
    {
      stableId: "canonical-thread-id",
      displayName: "Verified recipient",
      unread: true
    }
  ]);
});

test("SlideThread detail payloads expose exact-thread messages with explicit identity and direction", () => {
  const extracted = extractInstagramMessageSnapshotsFromPayload(
    {
      data: {
        get_slide_thread_nullable: {
          id: "opaque-wrapper",
          as_ig_direct_thread: {
            id: "canonical-thread-id",
            viewer_id: "viewer-id",
            slide_messages: {
              edges: [
                {
                  node: {
                    __typename: "SlideMessage",
                    id: "opaque-message-wrapper-one",
                    message_id: "stable-message-one",
                    offline_threading_id: "offline-message-one",
                    timestamp_ms: "1700000000000",
                    sender: {
                      id: "sender-wrapper-one",
                      name: "Me",
                      user_dict: { id: "viewer-id" }
                    },
                    text_body: "Outgoing text",
                    content: { __typename: "SlideMessageText", text_body: "Outgoing text" }
                  }
                },
                {
                  node: {
                    __typename: "SlideMessage",
                    id: "opaque-message-wrapper-two",
                    message_id: "stable-message-two",
                    timestamp_ms: "1700000001000",
                    sender: {
                      id: "sender-wrapper-two",
                      name: "Recipient",
                      user_dict: { id: "recipient-id" }
                    },
                    text_body: null,
                    content: { __typename: "SlideMessageText", text_body: "Incoming text" }
                  }
                }
              ]
            }
          }
        }
      }
    },
    "canonical-thread-id"
  );

  assert.equal(extracted.matchedThread, true);
  assert.equal(extracted.explicitlyEmpty, false);
  assert.deepEqual(extracted.snapshots, [
    {
      nativeId: "stable-message-one",
      nativeIdStable: true,
      offlineThreadingId: "offline-message-one",
      direction: "OUT",
      text: "Outgoing text",
      senderName: "Me",
      sourceTimestamp: "1700000000000"
    },
    {
      nativeId: "stable-message-two",
      nativeIdStable: true,
      direction: "IN",
      text: "Incoming text",
      senderName: "Recipient",
      sourceTimestamp: "1700000001000"
    }
  ]);
  assert.deepEqual(
    normalizeInstagramMessageSnapshots("canonical-thread-id", extracted.snapshots).map(
      (message) => [message.direction, message.text, message.timestamp]
    ),
    [
      ["OUT", "Outgoing text", "2023-11-14T22:13:20.000Z"],
      ["IN", "Incoming text", "2023-11-14T22:13:21.000Z"]
    ]
  );
  assert.equal(
    normalizeInstagramMessageSnapshots("canonical-thread-id", extracted.snapshots)[0]?.raw
      ?.instagramOfflineThreadingId,
    "offline-message-one"
  );
});

test("SlideThread message extraction fails closed on mismatched, ambiguous, and false-empty payloads", () => {
  const directThread = {
    id: "different-thread-id",
    viewer_id: "viewer-id",
    slide_messages: { edges: [] }
  };
  assert.deepEqual(
    extractInstagramMessageSnapshotsFromPayload(
      { data: { get_slide_thread_nullable: { as_ig_direct_thread: directThread } } },
      "expected-thread-id"
    ),
    { matchedThread: false, explicitlyEmpty: false, snapshots: [] }
  );

  assert.deepEqual(
    extractInstagramMessageSnapshotsFromPayload(
      {
        data: {
          get_slide_thread_nullable: {
            as_ig_direct_thread: {
              ...directThread,
              id: "expected-thread-id"
            }
          }
        }
      },
      "expected-thread-id"
    ),
    { matchedThread: true, explicitlyEmpty: false, snapshots: [] }
  );

  const ambiguous = extractInstagramMessageSnapshotsFromPayload(
    {
      data: {
        get_slide_thread_nullable: {
          as_ig_direct_thread: {
            id: "expected-thread-id",
            viewer_id: "viewer-id",
            slide_messages: {
              edges: [
                {
                  node: {
                    __typename: "SlideMessage",
                    message_id: "stable-message",
                    timestamp_ms: "1700000000000",
                    sender: {},
                    text_body: "Direction unknown"
                  }
                }
              ]
            }
          }
        }
      }
    },
    "expected-thread-id"
  );
  assert.equal(ambiguous.snapshots[0]?.direction, "AMBIGUOUS");
  assert.throws(
    () => normalizeInstagramMessageSnapshots("expected-thread-id", ambiguous.snapshots),
    (error) => error instanceof InstagramParsingError && error.reason === "ambiguous_message_direction"
  );
});

test("SlideThread direction accepts either exact viewer identity and timestamps reject ambiguous epochs", () => {
  const extracted = extractInstagramMessageSnapshotsFromPayload(
    {
      data: {
        get_slide_thread_nullable: {
          as_ig_direct_thread: {
            id: "expected-thread-id",
            viewer_id: "viewer-id",
            slide_messages: {
              edges: [
                {
                  node: {
                    __typename: "SlideMessage",
                    message_id: "stable-message",
                    timestamp_ms: "170000000000",
                    sender: {
                      user_dict: { id: "different-namespace-id" },
                      igid: "viewer-id"
                    },
                    text_body: "Outgoing text"
                  }
                }
              ]
            }
          }
        }
      }
    },
    "expected-thread-id"
  );

  assert.equal(extracted.snapshots[0]?.direction, "OUT");
  assert.equal(parseInstagramSourceTimestamp("17000000000"), undefined);
  assert.equal(parseInstagramSourceTimestamp("170000000000"), undefined);
});

test("GraphQL message records cannot impersonate direct-thread identities", () => {
  const snapshots = extractInstagramThreadSnapshotsFromPayload({
    data: {
      inbox: {
        threads: [
          {
            __typename: "XDTDirectThread",
            id: "real-thread",
            thread_title: "Safe thread",
            messages: [
              {
                __typename: "XDTDirectMessage",
                id: "message-id",
                thread_key: { thread_fbid: "real-thread" }
              }
            ],
            message_container: {
              items: [
                {
                  id: "nested-message-id",
                  thread_title: "Message metadata is not a thread"
                }
              ]
            }
          }
        ]
      }
    }
  });

  assert.deepEqual(snapshots.map((snapshot) => snapshot.stableId), ["real-thread"]);
});

test("thread rows never fall back to mutable text or row position", () => {
  assert.throws(
    () =>
      normalizeInstagramThreadSnapshots([
        { displayName: "Private name", preview: "Private preview", unread: true }
      ]),
    (error) =>
      error instanceof InstagramParsingError &&
      error.reason === "thread_missing_stable_identity"
  );
});

test("thread collection failures are classified without private page content", () => {
  assert.equal(
    classifyInstagramThreadCollectionError(new ReferenceError("__name is not defined")),
    "browser_runtime_shim_missing"
  );
  assert.equal(
    classifyInstagramThreadCollectionError(new Error("Execution context was destroyed")),
    "browser_context_changed"
  );
  assert.equal(
    classifyInstagramThreadCollectionError(new Error("Private conversation text")),
    "thread_collection_failed"
  );
});

test("selector parsing failures are classified without inventing thread identity", async () => {
  let evaluateCalls = 0;
  const page = withBrowserRuntime({
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForSelector: async () => undefined,
    waitForFunction: async () => undefined,
    url: () => "https://www.instagram.com/direct/inbox/",
    evaluate: async () => {
      evaluateCalls += 1;
      return evaluateCalls === 1
        ? { fieldNames: [], bodyText: "" }
        : [{ displayName: "Mutable name", preview: "Private preview", unread: true }];
    }
  });
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "[data-thread]",
      unread_badge: "[data-unread]",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  await assert.rejects(
    () => adapter.scanUnreadThreads(),
    (error) =>
      error?.kind === "SELECTOR_MISMATCH" &&
      error?.details?.reason === "thread_missing_stable_identity"
  );
});

test("opening Instagram uses the exact thread URL and rejects identity mismatches", async () => {
  const selectors = {
    inbox_url: "https://www.instagram.com/direct/inbox/",
    thread_list: "main",
    thread_item: "a[href^='/direct/t/']",
    unread_badge: "[data-unread]",
    conversation_header: "header h1",
    message_container: "main",
    message_item: "[data-message]",
    message_text: "[data-text]",
    composer_input: "[contenteditable='true']",
    send_button: "[aria-label='Send']"
  };
  const makeAdapter = (page) =>
    new InstagramAdapter({
      screenshotDir: "/tmp",
      domDumpDir: "/tmp",
      resolveSelectors: async () => selectors,
      sessionManager: { getManagedPage: async () => page },
      personKey: "instagram",
      connectTimeoutMs: 50
    });
  const makePage = ({ openedUrl, header = "Safe thread" }) => {
    let navigatedTo = "";
    const headerLocator = {
      getAttribute: async () => header,
      textContent: async () => header
    };
    return withBrowserRuntime({
      goto: async (url) => {
        navigatedTo = url;
      },
      bringToFront: async () => undefined,
      waitForTimeout: async () => undefined,
      waitForSelector: async () => undefined,
      evaluate: async () => ({ fieldNames: [], bodyText: "" }),
      url: () => openedUrl,
      locator: () => ({ first: () => headerLocator }),
      navigatedTo: () => navigatedTo
    });
  };

  const exactPage = makePage({
    openedUrl: "https://www.instagram.com/direct/t/safe-thread/"
  });
  await makeAdapter(exactPage).openThread({
    platformThreadId: "safe-thread",
    displayName: "Safe thread"
  });
  assert.equal(
    exactPage.navigatedTo(),
    "https://www.instagram.com/direct/t/safe-thread/"
  );

  const wrongUrlPage = makePage({
    openedUrl: "https://www.instagram.com/direct/t/wrong-thread/"
  });
  await assert.rejects(
    () =>
      makeAdapter(wrongUrlPage).openThread({
        platformThreadId: "safe-thread",
        displayName: "Safe thread"
      }),
    (error) =>
      error?.kind === "THREAD_NOT_FOUND" &&
      error?.details?.reason === "opened_thread_id_mismatch"
  );

  const wrongRecipientPage = makePage({
    openedUrl: "https://www.instagram.com/direct/t/safe-thread/",
    header: "Different thread"
  });
  await assert.rejects(
    () =>
      makeAdapter(wrongRecipientPage).openThread({
        platformThreadId: "safe-thread",
        displayName: "Safe thread",
        recipientVerificationLabel: "Safe thread"
      }),
    (error) =>
      error?.kind === "THREAD_NOT_FOUND" &&
      error?.details?.reason === "opened_recipient_mismatch"
  );

  const unverifiedRecipientPage = makePage({
    openedUrl: "https://www.instagram.com/direct/t/safe-thread/",
    header: "Joanne"
  });
  await assert.rejects(
    () =>
      makeAdapter(unverifiedRecipientPage).openThread({
        platformThreadId: "safe-thread",
        displayName: "Ann",
        recipientVerificationLabel: "Ann"
      }),
    (error) =>
      error?.kind === "THREAD_NOT_FOUND" &&
      error?.details?.reason === "opened_recipient_mismatch"
  );

  const renamedRecipientPage = makePage({
    openedUrl: "https://www.instagram.com/direct/t/safe-thread/",
    header: "Joanne"
  });
  await makeAdapter(renamedRecipientPage).openThread({
    platformThreadId: "safe-thread",
    displayName: "Ann",
    recipientVerificationLabel: "Joanne"
  });

  const exactIdWithoutHeader = makePage({
    openedUrl: "https://www.instagram.com/direct/t/safe-thread/",
    header: ""
  });
  await makeAdapter(exactIdWithoutHeader).openThread({
    platformThreadId: "safe-thread",
    displayName: "Safe thread"
  });

  const invalidPersistedId = makePage({
    openedUrl: "https://www.instagram.com/direct/t/safe-thread/"
  });
  await assert.rejects(
    () =>
      makeAdapter(invalidPersistedId).openThread({
        platformThreadId: "not/a/stable/id",
        threadUrl: "https://www.instagram.com/direct/t/safe-thread/",
        displayName: "Safe thread"
      }),
    (error) =>
      error?.kind === "THREAD_NOT_FOUND" &&
      error?.details?.reason === "invalid_thread_id"
  );
});

test("opening Instagram accepts any ready conversation selector when another selector rejects", async () => {
  const headerLocator = {
    getAttribute: async () => "Safe thread",
    textContent: async () => "Safe thread"
  };
  const page = withBrowserRuntime({
    goto: async () => undefined,
    bringToFront: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForSelector: async (selector) => {
      if (selector === "main") throw new Error("selector unavailable");
      return undefined;
    },
    evaluate: async () => ({ fieldNames: [], bodyText: "" }),
    url: () => "https://www.instagram.com/direct/t/safe-thread/",
    locator: () => ({ first: () => headerLocator })
  });
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "a[href^='/direct/t/']",
      unread_badge: "[data-unread]",
      conversation_header: "header h1",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await adapter.openThread({
    platformThreadId: "safe-thread",
    displayName: "Operator alias",
    recipientVerificationLabel: "Safe thread"
  });
});

test("exact-thread navigation respects a caller deadline budget", { timeout: 15_000 }, async () => {
  const observedTimeouts = [];
  const headerLocator = {
    getAttribute: async () => "Safe thread",
    textContent: async () => "Safe thread"
  };
  const page = withBrowserRuntime({
    goto: async (_url, options) => {
      observedTimeouts.push(options.timeout);
    },
    waitForTimeout: async () => undefined,
    waitForSelector: async (_selector, options) => {
      observedTimeouts.push(options.timeout);
    },
    evaluate: async () => ({ fieldNames: [], bodyText: "" }),
    url: () => "https://www.instagram.com/direct/t/safe-thread/",
    locator: () => ({ first: () => headerLocator })
  });
  const selectors = {
    inbox_url: "https://www.instagram.com/direct/inbox/",
    thread_list: "main",
    thread_item: "a[href^='/direct/t/']",
    unread_badge: "[data-unread]",
    conversation_header: "header h1",
    message_container: "main",
    message_item: "[data-message]",
    message_text: "[data-text]",
    composer_input: "[contenteditable='true']",
    send_button: "[aria-label='Send']"
  };
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await adapter.openExactThread(
    page,
    selectors,
    {
      platformThreadId: "safe-thread",
      displayName: "Operator alias",
      recipientVerificationLabel: "Safe thread"
    },
    false,
    "before_send",
    Date.now() + 1_000
  );

  assert.ok(observedTimeouts.length >= 4);
  assert.ok(observedTimeouts.every((timeout) => timeout > 0 && timeout <= 1_000));

  adapter.authRequirementForPage = async () => new Promise(() => undefined);
  await assert.rejects(
    () =>
      adapter.openExactThread(
        page,
        selectors,
        {
          platformThreadId: "safe-thread",
          displayName: "Operator alias",
          recipientVerificationLabel: "Safe thread"
        },
        false,
        "before_send",
        Date.now() + 25
    ),
    (error) => error?.reason === "send_verification_timeout"
  );
});

test("recipient evidence captured for thread A cannot reject a later exact open of thread B", async () => {
  const header = {
    getAttribute: async () => "Thread B",
    textContent: async () => "Thread B"
  };
  const page = withBrowserRuntime({
    url: () => "https://www.instagram.com/direct/t/thread-b/",
    locator: () => ({ first: () => header })
  });
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.networkMessageCaptureStatus = () => ({
    expectedThreadId: "thread-a",
    pendingRequests: 0,
    successfulResponses: 1,
    failedRequests: 0,
    matchedThread: true,
    explicitlyEmpty: false,
    recipientVerificationLabel: "Thread A",
    snapshots: []
  });

  await adapter.verifyCurrentThreadIdentity(
    page,
    { conversation_header: "header h1" },
    {
      platformThreadId: "thread-b",
      displayName: "Thread B",
      recipientVerificationLabel: "Thread B"
    },
    "thread-b",
    false,
    "open"
  );
});

test("Instagram landing-pane copy is not evidence that a populated inbox is empty", () => {
  assert.equal(instagramEmptyInboxText("Messages you send and receive will appear here."), false);
  assert.equal(
    instagramEmptyInboxText("No messages selected. Choose a conversation from the list."),
    false
  );
  assert.equal(instagramEmptyInboxText("No conversations"), true);
  assert.equal(instagramEmptyInboxText("No messages"), true);
});

test("Instagram empty-inbox certification requires scoped structural evidence", () => {
  const explicitEmpty = {
    documentRootPresent: true,
    scopedEmptyLabels: ["No conversations"],
    threadItemCount: 0,
    directThreadLinkCount: 0,
    composerCount: 0,
    messageItemCount: 0,
    loadingSignalCount: 0,
    errorSignalCount: 0,
    networkPendingRequests: 0,
    networkFailedRequests: 0
  };

  assert.equal(isInstagramExplicitEmptyInbox(explicitEmpty), true);
  assert.equal(
    isInstagramExplicitEmptyInbox({
      ...explicitEmpty,
      scopedEmptyLabels: ["No messages selected. Choose a conversation from the list."],
      directThreadLinkCount: 3
    }),
    false
  );
  assert.equal(
    isInstagramExplicitEmptyInbox({ ...explicitEmpty, loadingSignalCount: 1 }),
    false
  );
  assert.equal(
    isInstagramExplicitEmptyInbox({ ...explicitEmpty, networkFailedRequests: 1 }),
    false
  );
  assert.equal(
    resolveInstagramCollectionStopReason({
      collectionCalls: 2,
      observedRows: false,
      explicitlyEmpty: false
    }),
    "instagram_bounded_snapshot"
  );
});

test("Instagram cannot certify an empty inbox while another document region contains a live thread", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.setContent(`<!doctype html>
    <main><h2>No messages</h2></main>
    <main><a href="/direct/t/live-thread/">Live thread</a></main>`);

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "[data-stale-thread-selector]",
      message_container: "[data-message-container]",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.navigateToInbox = async () => undefined;
  adapter.waitForCapturedNetworkThreads = async () => undefined;

  await assert.rejects(
    () => adapter.collectThreads(10),
    (error) =>
      error?.kind === "SELECTOR_MISMATCH" &&
      error?.details?.reason === "thread_selector_returned_no_rows"
  );
});

test("Instagram cannot certify an empty inbox after a GraphQL application error", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    if (/\/api\/graphql$/.test(new URL(route.request().url()).pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ errors: [{ message: "inbox query failed" }] })
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main><h2>No messages</h2></main>
        <script>fetch('/api/graphql', { method: 'POST' })</script>`
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "[data-stale-thread-selector]",
      message_container: "[data-message-container]",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.navigateToInbox = async (managedPage) => {
    await managedPage.goto("https://www.instagram.com/direct/inbox/");
    await managedPage.waitForTimeout(100);
  };
  adapter.waitForCapturedNetworkThreads = async () => undefined;

  await assert.rejects(
    () => adapter.collectThreads(10),
    (error) =>
      error?.kind === "SELECTOR_MISMATCH" &&
      error?.details?.reason === "thread_selector_returned_no_rows"
  );
});

test("fetchThreadMessages uses the exact SlideThread network transcript when DOM rows are absent", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (/\/api\/graphql$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            get_slide_thread_nullable: {
              as_ig_direct_thread: {
                id: "safe-thread",
                thread_title: "Safe thread",
                viewer_id: "viewer-id",
                slide_messages: {
                  edges: [
                    {
                      node: {
                        __typename: "SlideMessage",
                        message_id: "network-out",
                        timestamp_ms: "1700000000000",
                        sender: {
                          id: "sender-wrapper",
                          name: "Me",
                          user_dict: { id: "viewer-id" }
                        },
                        text_body: "Network message"
                      }
                    }
                  ]
                }
              }
            }
          }
        })
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <div role="textbox" contenteditable="true"></div>
        </main>
        <script>fetch('/api/graphql', { method: 'POST' })</script>`
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      conversation_header: "header h1",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  const thread = {
    platformThreadId: "safe-thread",
    displayName: "Operator alias"
  };
  const messages = await adapter.fetchThreadMessages(thread, 20);

  assert.deepEqual(
    messages.map((message) => [message.direction, message.text, message.timestamp]),
    [["OUT", "Network message", "2023-11-14T22:13:20.000Z"]]
  );
  assert.equal(thread.recipientVerificationLabel, "Safe thread");
});

test("a loaded composer cannot certify an empty Instagram transcript", async () => {
  const page = withBrowserRuntime({
    evaluate: async () => undefined,
    locator: () => ({
      first: () => ({
        getAttribute: async () => null,
        textContent: async () => ""
      })
    })
  });
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.openExactThread = async () => "safe-thread";
  adapter.waitForNetworkMessageCapture = async () => false;
  adapter.snapshotMessages = async () => [];

  await assert.rejects(
    () =>
      adapter.fetchThreadMessages(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        20
      ),
    (error) =>
      error?.kind === "THREAD_FETCH_FAILED" &&
      error?.details?.reason === "message_selector_returned_no_rows"
  );
});

test("message normalization preserves direction, exact timestamps and first-seen fallback", () => {
  const messages = normalizeInstagramMessageSnapshots("thread-1", [
    {
      nativeId: "native-in",
      direction: "IN",
      text: "Hello",
      sourceTimestamp: "2026-07-30T09:10:11.000Z"
    },
    {
      nativeId: "native-out",
      nativeIdStable: true,
      direction: "OUT",
      text: "Hi",
      sourceTimestamp: "5m"
    }
  ]);

  assert.equal(messages[0].direction, "IN");
  assert.equal(messages[0].timestamp, "2026-07-30T09:10:11.000Z");
  assert.equal(messages[0].raw.timestampSource, "source");
  assert.equal(messages[0].raw.messageIdentityVersion, "instagram_stable_v2");
  assert.deepEqual(messages[0].platformMessageKeyMigration, {
    scheme: "instagram_occurrence_v1",
    candidateKey: instagramMessageFallbackKey("thread-1", "IN", "Hello", undefined, 0)
  });
  assert.equal(messages[1].direction, "OUT");
  assert.equal(messages[1].timestamp, undefined);
  assert.equal(messages[1].raw.timestampSource, "first_seen");
  assert.equal(parseInstagramSourceTimestamp("Yesterday"), undefined);
});

test("message snapshot extraction accepts the configured data-id identity variant", async () => {
  const selectors = {
    message_container: "main",
    message_item: "[data-message]",
    message_text: "[data-text]",
    message_id: "[data-message-id], [data-id]",
    message_direction_in: "[data-direction='incoming']"
  };
  const textNode = {
    textContent: "Hello from Instagram",
    matches: () => false,
    querySelector: () => null
  };
  const messageNode = {
    className: "",
    textContent: "Hello from Instagram",
    tagName: "DIV",
    getAttribute: (name) =>
      ({
        "data-id": "ig-message-42",
        "data-direction": "incoming"
      })[name] ?? null,
    matches: (selector) =>
      selector
        .split(",")
        .map((part) => part.trim())
        .some(
          (part) =>
            part === "[data-message]" ||
            part === "[data-id]" ||
            part === "[data-direction='incoming']"
        ),
    querySelector: (selector) => (selector === "[data-text]" ? textNode : null),
    getBoundingClientRect: () => ({ left: 0, width: 300 })
  };
  const container = {
    querySelectorAll: (selector) => (selector === "[data-message]" ? [messageNode] : []),
    getBoundingClientRect: () => ({ left: 0, width: 600 })
  };
  const body = {
    querySelector: (selector) => (selector === "main" ? container : null)
  };
  const documentRoot = {
    evaluate: async (callback, argument) =>
      typeof callback === "string" ? undefined : callback(body, argument)
  };
  const page = { $: async () => documentRoot };
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  const snapshots = await adapter.snapshotMessages(page, selectors);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].nativeId, "ig-message-42");
  assert.equal(snapshots[0].nativeIdStable, true);
  assert.doesNotThrow(() => normalizeInstagramMessageSnapshots("thread-1", snapshots));
});

test("shipped Instagram selectors exclude sidebar rows and preserve message boundaries", async () => {
  const selectors = JSON.parse(
    readFileSync(new URL("../packages/core/selectors/instagram.json", import.meta.url), "utf8")
  );
  const selectorParts = (selector) => selector.split(",").map((part) => part.trim());
  const node = ({
    tagName = "DIV",
    text = "",
    attributes = {},
    matched = [],
    descendants = {},
    closest = null,
    left = 0,
    width = 280,
    parentElement = null
  } = {}) => ({
    tagName,
    className: "",
    textContent: text,
    getAttribute: (name) => attributes[name] ?? null,
    matches: (selector) => selectorParts(selector).some((part) => matched.includes(part)),
    querySelector: (selector) =>
      Object.entries(descendants).find(([candidate]) => selectorParts(selector).includes(candidate))?.[1] ?? null,
    querySelectorAll: (selector) =>
      Object.entries(descendants)
        .filter(([candidate]) => selectorParts(selector).includes(candidate))
        .map(([, descendant]) => descendant),
    closest: () => closest,
    parentElement,
    getBoundingClientRect: () => ({ left, width })
  });

  const sidebarAvatar = node({
    tagName: "IMG",
    attributes: { alt: "Joanne's profile picture" }
  });
  const sidebar = node({
    text: "Joanne Latest preview",
    matched: ["div[role='row']"],
    descendants: {
      "div[dir='auto']": node({ text: "Joanne Latest preview" }),
      "img[alt]:not([alt=''])": sidebarAvatar
    },
    left: 0
  });
  const inbound = node({
    text: "Hello",
    attributes: { "data-message-id": "message-in", "data-direction": "incoming" },
    matched: ["div[role='row']", "[data-message-id]", "[data-direction='incoming']"],
    descendants: {
      "div[dir='auto']": node({ text: "Hello" }),
      "img[alt]:not([alt=''])": node({
        tagName: "IMG",
        attributes: { alt: "Joanne's profile picture" }
      })
    },
    left: 260
  });
  const outbound = node({
    text: "Hi",
    attributes: { "data-direction": "outgoing" },
    matched: ["div[role='listitem']", "[data-direction='outgoing']"],
    descendants: {
      "div[dir='auto']": node({ text: "Hi" }),
      "time[datetime]": node({ attributes: { datetime: "2026-08-24T10:00:00.000Z" } })
    },
    left: 700
  });
  const linkedProfile = node({
    text: "Profile-linked avatar",
    attributes: { "data-id": "message-profile", "data-direction": "incoming" },
    matched: ["div[role='row']", "[data-id]", "[data-direction='incoming']"],
    descendants: {
      "div[dir='auto']": node({ text: "Profile-linked avatar" }),
      "img[alt]:not([alt=''])": node({
        tagName: "IMG",
        attributes: { alt: "Joanne" },
        closest: node({ tagName: "A", attributes: { href: "/joanne/" } })
      })
    },
    left: 260
  });
  const photo = node({
    tagName: "IMG",
    attributes: { alt: "Photo" },
    closest: node({ tagName: "A", attributes: { href: "/p/post-1/" } })
  });
  const media = node({
    attributes: { "data-id": "message-photo", "data-direction": "incoming" },
    matched: ["div[role='row']", "[data-id]", "[data-direction='incoming']"],
    descendants: { "img[alt]:not([alt=''])": photo },
    left: 260
  });
  const reel = node({
    tagName: "IMG",
    attributes: { alt: "Reel preview" },
    closest: node({ tagName: "A", attributes: { href: "/reel/reel-1/" } })
  });
  const reelMedia = node({
    attributes: { "data-id": "message-reel", "data-direction": "incoming" },
    matched: ["div[role='row']", "[data-id]", "[data-direction='incoming']"],
    descendants: { "img[alt]:not([alt=''])": reel },
    left: 260
  });
  const voice = node({
    attributes: { "data-id": "message-voice", "data-direction": "incoming" },
    matched: ["div[role='row']", "[data-id]", "[data-direction='incoming']"],
    descendants: {
      "img[alt]:not([alt=''])": node({
        tagName: "IMG",
        attributes: { alt: "Joanne's profile picture" }
      }),
      audio: node({ tagName: "AUDIO", attributes: { "aria-label": "Voice message" } })
    },
    left: 260
  });
  const conversationRows = [inbound, outbound, linkedProfile, voice, media, reelMedia];
  const rows = [sidebar, ...conversationRows];
  const container = node({ left: 200, width: 800 });
  container.querySelectorAll = (selector) => selector === selectors.message_item ? rows : [];
  const conversationPane = node({ left: 400, width: 600, parentElement: container });
  conversationPane.querySelector = (selector) =>
    selector === selectors.message_item ? conversationRows[0] : null;
  conversationPane.querySelectorAll = (selector) =>
    selector === selectors.message_item ? conversationRows : [];
  const composer = node({ parentElement: conversationPane });
  const body = node();
  body.querySelector = (selector) => {
    if (selector === selectors.message_container) return container;
    if (selector === selectors.composer_input) return composer;
    return null;
  };
  const documentRoot = {
    evaluate: async (callback, argument) =>
      typeof callback === "string" ? undefined : callback(body, argument)
  };
  const page = { $: async () => documentRoot };
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  const snapshots = await adapter.snapshotMessages(page, selectors);

  assert.deepEqual(
    snapshots.map(({ nativeId, direction, text, mediaKind }) => ({ nativeId, direction, text, mediaKind })),
    [
      { nativeId: "message-in", direction: "IN", text: "Hello", mediaKind: undefined },
      { nativeId: undefined, direction: "OUT", text: "Hi", mediaKind: undefined },
      {
        nativeId: "message-profile",
        direction: "IN",
        text: "Profile-linked avatar",
        mediaKind: undefined
      },
      { nativeId: "message-voice", direction: "IN", text: "", mediaKind: "voice_message" },
      { nativeId: "message-photo", direction: "IN", text: "", mediaKind: "photo" },
      { nativeId: "message-reel", direction: "IN", text: "", mediaKind: "photo" }
    ]
  );
});

test("unsupported Instagram content becomes safe placeholders", () => {
  const messages = normalizeInstagramMessageSnapshots("thread-2", [
    { nativeId: "photo", nativeIdStable: true, direction: "IN", mediaKind: "photo" },
    { nativeId: "video", nativeIdStable: true, direction: "OUT", mediaKind: "video", text: "Caption" },
    { nativeId: "voice", nativeIdStable: true, direction: "IN", mediaKind: "voice_message" },
    { nativeId: "deleted", nativeIdStable: true, direction: "OUT", deleted: true, text: "Message was deleted" }
  ]);

  assert.deepEqual(
    messages.map((message) => message.text),
    [
      "[Instagram photo]",
      "Caption",
      "[Instagram voice message]",
      "[Deleted Instagram message]"
    ]
  );
  assert.equal(messages[1].attachments[0]?.type, "video");
  assert.ok(messages.every((message) => message.attachments[0]?.manualReview));
});

test("message keys are stable across rescans and deduplicate native ids", () => {
  const snapshots = [
    { nativeId: "native-1", nativeIdStable: true, direction: "IN", text: "Same text" },
    { nativeId: "native-2", nativeIdStable: true, direction: "IN", text: "Same text" },
    { nativeId: "native-3", nativeIdStable: true, direction: "OUT", text: "Reply" },
    { nativeId: "native-3", nativeIdStable: true, direction: "OUT", text: "Reply" },
    { nativeId: "native-4", nativeIdStable: true, direction: "OUT", text: "Reply" }
  ];
  const first = normalizeInstagramMessageSnapshots("thread-3", snapshots);
  const second = normalizeInstagramMessageSnapshots("thread-3", snapshots);

  assert.deepEqual(
    first.map((message) => message.platformMessageKey),
    second.map((message) => message.platformMessageKey)
  );
  assert.equal(first.length, 4);
  assert.notEqual(first[0].platformMessageKey, first[1].platformMessageKey);
  assert.deepEqual(
    first.map((message) => message.platformMessageKeyMigration?.candidateKey),
    [
      instagramMessageFallbackKey("thread-3", "IN", "Same text", undefined, 0),
      instagramMessageFallbackKey("thread-3", "IN", "Same text", undefined, 1),
      instagramMessageFallbackKey("thread-3", "OUT", "Reply", undefined, 0),
      instagramMessageFallbackKey("thread-3", "OUT", "Reply", undefined, 1)
    ]
  );
});

test("stable native message ids remain authoritative across sliding history windows", () => {
  const january = normalizeInstagramMessageSnapshots("thread-window", [
    {
      nativeId: "message-january",
      nativeIdStable: true,
      direction: "OUT",
      text: "Thanks"
    }
  ]);
  const august = normalizeInstagramMessageSnapshots("thread-window", [
    {
      nativeId: "message-august",
      nativeIdStable: true,
      direction: "OUT",
      text: "Thanks"
    }
  ]);
  const combined = normalizeInstagramMessageSnapshots("thread-window", [
    {
      nativeId: "message-january",
      nativeIdStable: true,
      direction: "OUT",
      text: "Thanks"
    },
    {
      nativeId: "message-august",
      nativeIdStable: true,
      direction: "OUT",
      text: "Thanks"
    }
  ]);

  assert.notEqual(january[0].platformMessageKey, august[0].platformMessageKey);
  assert.equal(combined[0].platformMessageKey, january[0].platformMessageKey);
  assert.equal(combined[1].platformMessageKey, august[0].platformMessageKey);
});

test("exact source timestamps distinguish repeated text across sliding history windows", () => {
  const january = normalizeInstagramMessageSnapshots("thread-window", [
    {
      direction: "OUT",
      text: "Thanks",
      sourceTimestamp: "2026-01-03T10:00:00.000Z"
    }
  ]);
  const august = normalizeInstagramMessageSnapshots("thread-window", [
    {
      direction: "OUT",
      text: "Thanks",
      sourceTimestamp: "2026-08-19T10:00:00.000Z"
    }
  ]);
  const combined = normalizeInstagramMessageSnapshots("thread-window", [
    {
      direction: "OUT",
      text: "Thanks",
      sourceTimestamp: "2026-01-03T10:00:00.000Z"
    },
    {
      direction: "OUT",
      text: "Thanks",
      sourceTimestamp: "2026-08-19T10:00:00.000Z"
    }
  ]);

  assert.notEqual(january[0].platformMessageKey, august[0].platformMessageKey);
  assert.equal(combined[0].platformMessageKey, january[0].platformMessageKey);
  assert.equal(combined[1].platformMessageKey, august[0].platformMessageKey);
});

test("indistinguishable repeated messages fail closed instead of shifting persisted identity", () => {
  assert.throws(
    () =>
      normalizeInstagramMessageSnapshots("thread-window", [
        { direction: "IN", text: "Same" },
        { direction: "IN", text: "Same" }
      ]),
    (error) =>
      error instanceof InstagramParsingError &&
      error.reason === "ambiguous_message_identity"
  );
});

test("volatile Instagram message metadata cannot impersonate a new outgoing message", () => {
  const before = normalizeInstagramMessageSnapshots("thread-volatile", [
    {
      nativeId: "mount-a",
      direction: "OUT",
      text: "Reply",
      sourceTimestamp: "2026-08-24T08:00:00.000Z"
    }
  ]);
  const after = normalizeInstagramMessageSnapshots("thread-volatile", [
    {
      nativeId: "mount-b",
      direction: "OUT",
      text: "Reply",
      senderName: "Me",
      sourceTimestamp: "2026-08-24T08:00:00.000Z"
    }
  ]);

  assert.equal(before[0].platformMessageKey, after[0].platformMessageKey);
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      before,
      after,
      "Reply",
      Date.parse("2026-08-24T08:00:01.000Z")
    ),
    null
  );
});

test("exact-layout receipt fallback keys are deterministic and occurrence-scoped", () => {
  const key = instagramMessageFallbackKey("thread-layout", "OUT", "Reply", undefined, 1);
  assert.equal(
    key,
    instagramMessageFallbackKey("thread-layout", "OUT", "Reply", undefined, 1)
  );
  assert.notEqual(
    key,
    instagramMessageFallbackKey("thread-layout", "OUT", "Reply", undefined, 0)
  );
});

test("fallback message keys stay attached to the same message when row order changes", () => {
  const snapshots = [
    { nativeId: "first", nativeIdStable: true, direction: "IN", text: "First", senderName: "Ann" },
    { nativeId: "second", nativeIdStable: true, direction: "OUT", text: "Second", senderName: "Me" },
    { nativeId: "third", nativeIdStable: true, direction: "IN", text: "Third", senderName: "Ann" }
  ];
  const first = normalizeInstagramMessageSnapshots("thread-order", snapshots);
  const reversed = normalizeInstagramMessageSnapshots("thread-order", [...snapshots].reverse());
  const keysByText = (messages) =>
    Object.fromEntries(messages.map((message) => [message.text, message.platformMessageKey]));

  assert.deepEqual(keysByText(first), keysByText(reversed));
});

test("ambiguous Instagram direction fails instead of defaulting incoming", () => {
  assert.throws(
    () =>
      normalizeInstagramMessageSnapshots("thread-4", [
        { direction: "AMBIGUOUS", text: "Unknown direction" }
      ]),
    (error) =>
      error instanceof InstagramParsingError &&
      error.reason === "ambiguous_message_direction"
  );
});

test("Instagram rejects scheduled and attachment sends", () => {
  assert.doesNotThrow(() =>
    assertInstagramManualTextSend({ platform: "INSTAGRAM", attachmentCount: 0 })
  );
  assert.throws(
    () => assertInstagramManualTextSend({ platform: "INSTAGRAM", scheduled: true }),
    /user-triggered sends only/
  );
  assert.throws(
    () =>
      assertInstagramManualTextSend({
        platform: "INSTAGRAM",
        source: "focus_auto_ack"
      }),
    /user-triggered sends only/
  );
  assert.throws(
    () => assertInstagramManualTextSend({ platform: "INSTAGRAM", attachmentCount: 1 }),
    /text messages only/
  );
  assert.doesNotThrow(() =>
    assertInstagramManualTextSend({ platform: "LINKEDIN", scheduled: true, attachmentCount: 1 })
  );
});

test("send verification requires a new stable outgoing platform acknowledgement after dispatch", () => {
  const dispatchedAt = Date.parse("2026-08-24T08:00:00.000Z");
  const before = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "old",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T07:59:00.000Z"
    }
  ]);
  const unchanged = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "old",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T07:59:00.000Z"
    }
  ]);
  const submitted = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "old",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T07:59:00.000Z"
    },
    {
      nativeId: "new",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T08:00:01.000Z"
    }
  ]);
  const wrongDirection = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "old",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T07:59:00.000Z"
    },
    {
      nativeId: "new",
      nativeIdStable: true,
      direction: "IN",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T08:00:01.000Z"
    }
  ]);
  const stale = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "new",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T07:59:00.000Z"
    }
  ]);
  const immediatelyBeforeDispatch = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "pre-click",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T07:59:59.999Z"
    }
  ]);
  const farFuture = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "future",
      nativeIdStable: true,
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-25T08:00:00.000Z"
    }
  ]);

  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      before,
      unchanged,
      "Approved smoke message",
      dispatchedAt
    ),
    null
  );
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      before,
      wrongDirection,
      "Approved smoke message",
      dispatchedAt
    ),
    null
  );
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      [],
      stale,
      "Approved smoke message",
      dispatchedAt
    ),
    null
  );
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      [],
      immediatelyBeforeDispatch,
      "Approved smoke message",
      dispatchedAt
    ),
    null
  );
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      [],
      farFuture,
      "Approved smoke message",
      dispatchedAt,
      Date.parse("2026-08-24T08:00:05.000Z")
    ),
    null
  );
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      before,
      submitted,
      "Approved smoke message",
      dispatchedAt
    )
      ?.platformMessageKey,
    submitted[1].platformMessageKey
  );

  const expectedCausalMessage = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "causal-message",
      nativeIdStable: true,
      offlineThreadingId: "offline-causal",
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T08:00:01.000Z"
    }
  ])[0];
  const concurrentIdenticalMessage = normalizeInstagramMessageSnapshots("thread-5", [
    {
      nativeId: "concurrent-message",
      nativeIdStable: true,
      offlineThreadingId: "offline-other-device",
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: "2026-08-24T08:00:01.000Z"
    }
  ]);
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      [],
      concurrentIdenticalMessage,
      "Approved smoke message",
      dispatchedAt,
      Date.parse("2026-08-24T08:00:05.000Z"),
      0,
      expectedCausalMessage.platformMessageKey,
      "offline-causal"
    ),
    null
  );
});

test("exact Instagram transport identifiers survive server clock offset", () => {
  const dispatchedAt = Date.parse("2026-08-24T08:00:00.000Z");
  const serverTimestamp = "2026-08-24T07:57:00.000Z";
  const after = normalizeInstagramMessageSnapshots("thread-clock-offset", [
    {
      nativeId: "acknowledged-message",
      nativeIdStable: true,
      offlineThreadingId: "offline-current-dispatch",
      direction: "OUT",
      text: "Approved smoke message",
      sourceTimestamp: serverTimestamp
    }
  ]);

  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      [],
      after,
      "Approved smoke message",
      dispatchedAt,
      Date.parse("2026-08-24T08:00:05.000Z"),
      0,
      after[0].platformMessageKey,
      "offline-current-dispatch",
      String(Date.parse(serverTimestamp))
    )?.platformMessageKey,
    after[0].platformMessageKey
  );
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      [],
      after,
      "Approved smoke message",
      dispatchedAt,
      Date.parse("2026-08-24T08:00:05.000Z"),
      0,
      after[0].platformMessageKey,
      "offline-different-dispatch"
    ),
    null
  );
  assert.equal(
    findNewAcknowledgedInstagramOutgoing(
      [],
      after,
      "Approved smoke message",
      dispatchedAt,
      Date.parse("2026-08-24T08:00:05.000Z"),
      0,
      after[0].platformMessageKey,
      "offline-current-dispatch",
      String(Date.parse(serverTimestamp) + 60_000)
    ),
    null
  );
});

test("Instagram refuses to send through a disabled composer", async () => {
  let evaluateCalls = 0;
  const headerLocator = {
    getAttribute: async () => "Safe thread",
    textContent: async () => "Safe thread"
  };
  const disabledComposer = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => false,
    getAttribute: async () => null
  };
  const page = withBrowserRuntime({
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForSelector: async () => undefined,
    evaluate: async () => {
      evaluateCalls += 1;
      return evaluateCalls === 1 ? { fieldNames: [], bodyText: "" } : [];
    },
    getByText: () => ({ count: async () => 0 }),
    url: () => "https://www.instagram.com/direct/t/safe-thread/",
    locator: (selector) =>
      selector === "header h1"
        ? { first: () => headerLocator }
        : disabledComposer
  });
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "a[href^='/direct/t/']",
      unread_badge: "[data-unread]",
      conversation_header: "header h1",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.waitForNetworkMessageCapture = async () => true;
  adapter.networkMessageCaptureStatus = () => ({
    expectedThreadId: "safe-thread",
    pendingRequests: 0,
    successfulResponses: 1,
    failedRequests: 0,
    matchedThread: true,
    explicitlyEmpty: false,
    recipientVerificationLabel: "Safe thread",
    snapshots: []
  });

  await assert.rejects(
    () =>
      adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "Approved text"
      ),
    (error) =>
      error?.kind === "THREAD_FETCH_FAILED" &&
      error?.details?.reason === "composer_disabled"
  );
});

test("Instagram atomic composer actions validate and mutate in one browser task", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <form style="display:flex;align-items:center;gap:8px">
            <div id="composer" role="textbox" contenteditable="true" style="width:300px;height:40px"></div>
            <button id="send" type="button" aria-label="Send">Send</button>
            <button id="unrelated" type="submit" aria-label="Upload">Upload</button>
          </form>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.submitted = 0;
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const sendButton = await page.locator("#send").elementHandle();
  const unrelated = await page.locator("#unrelated").elementHandle();
  const selectors = { conversation_header: "main header h1" };
  const thread = {
    platformThreadId: "safe-thread",
    displayName: "Safe thread",
    recipientVerificationLabel: "Safe thread"
  };
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);

  const resolvedSend = await adapter.requireComposerSendButton(page, composer, "#send");
  assert.equal(await resolvedSend.button.getAttribute("id"), "send");
  await assert.rejects(
    () => adapter.requireComposerSendButton(page, composer, "#unrelated"),
    (error) => error?.reason === "send_button_not_unique"
  );

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "focus",
      expectedText: ""
    }),
    { ok: true }
  );
  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "type",
      expectedText: "",
      unit: "h"
    }),
    { ok: true }
  );
  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "type",
      expectedText: "h",
      unit: "i"
    }),
    { ok: true }
  );
  assert.equal(await composer.textContent(), "hi");

  await page.evaluate(() => history.pushState({}, "", "/direct/t/wrong-thread/"));
  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "type",
      expectedText: "hi",
      unit: "!"
    }),
    { ok: false, reason: "thread_changed_before_send" }
  );
  assert.equal(await composer.textContent(), "hi");

  await page.evaluate(() => history.pushState({}, "", "/direct/t/safe-thread/"));
  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton: unrelated,
      sendOwner: resolvedSend.owner,
      sendConversationContainer: resolvedSend.conversationContainer,
      sendComposerPath: resolvedSend.composerPath,
      sendPath: resolvedSend.sendPath,
      sendOwnerDocumentPath: resolvedSend.ownerDocumentPath,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "hi"
    }),
    { ok: false, reason: "send_button_not_owned" }
  );
  await sendButton.evaluate((button) => button.setAttribute("aria-disabled", "true"));
  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton,
      sendOwner: resolvedSend.owner,
      sendConversationContainer: resolvedSend.conversationContainer,
      sendComposerPath: resolvedSend.composerPath,
      sendPath: resolvedSend.sendPath,
      sendOwnerDocumentPath: resolvedSend.ownerDocumentPath,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "hi"
    }),
    { ok: false, reason: "send_button_disabled" }
  );
  assert.equal(await page.evaluate(() => window.submitted), 0);
  await sendButton.evaluate((button) => button.setAttribute("aria-disabled", "false"));
  const successfulSend = await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton,
      sendOwner: resolvedSend.owner,
      sendConversationContainer: resolvedSend.conversationContainer,
      sendComposerPath: resolvedSend.composerPath,
      sendPath: resolvedSend.sendPath,
      sendOwnerDocumentPath: resolvedSend.ownerDocumentPath,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "hi"
    });
  assert.equal(successfulSend.ok, true);
  assert.equal(typeof successfulSend.clickedAtMs, "number");
  assert.equal(await page.evaluate(() => window.submitted), 1);
});

test("Instagram atomic typing revalidates recipient ownership after focus handlers run", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <form style="display:flex;align-items:center;gap:8px">
            <div id="composer" role="textbox" contenteditable="true" style="width:300px;height:40px"></div>
            <button id="send" type="button" aria-label="Send">Send</button>
          </form>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.inputObserved = [];
    document.querySelector("#composer")?.addEventListener("input", (event) => {
      window.inputObserved.push(event.currentTarget?.textContent ?? "");
    });
    document.querySelector("#composer")?.addEventListener("focus", () => {
      const header = document.querySelector("header h1");
      if (header) header.textContent = "Wrong person";
    }, { once: true });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      selectors: { conversation_header: "main header h1" },
      thread: {
        platformThreadId: "safe-thread",
        displayName: "Safe thread",
        recipientVerificationLabel: "Safe thread"
      },
      platformThreadId: "safe-thread",
      action: "type",
      expectedText: "",
      unit: "private text"
    }),
    { ok: false, reason: "recipient_changed_before_send" }
  );
  assert.equal(await composer.textContent(), "");
  assert.deepEqual(await page.evaluate(() => window.inputObserved), []);
});

test("Instagram atomic send rejects a bound Send moved to another composer", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <form id="original" style="display:flex;align-items:center;gap:8px">
            <div id="composer" role="textbox" contenteditable="true" style="width:300px;height:40px">Approved text</div>
            <button id="send" type="button" aria-label="Send">Send</button>
          </form>
          <form id="other" style="display:flex;align-items:center;gap:8px;margin-top:80px">
            <div role="textbox" contenteditable="true" style="width:300px;height:40px"></div>
          </form>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.submitted = 0;
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);
  const sendBinding = await adapter.requireComposerSendButton(page, composer, "#send");
  const sendButton = sendBinding.button;
  await sendButton.evaluate((button) => {
    document.querySelector("#other")?.append(button);
  });

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton,
      sendOwner: sendBinding.owner,
      sendConversationContainer: sendBinding.conversationContainer,
      sendComposerPath: sendBinding.composerPath,
      sendPath: sendBinding.sendPath,
      sendOwnerDocumentPath: sendBinding.ownerDocumentPath,
      selectors: { conversation_header: "main header h1" },
      thread: {
        platformThreadId: "safe-thread",
        displayName: "Safe thread",
        recipientVerificationLabel: "Safe thread"
      },
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "Approved text"
    }),
    { ok: false, reason: "send_button_not_owned" }
  );
  assert.equal(await page.evaluate(() => window.submitted), 0);
});

test("Instagram atomic send rejects coordinate-preserving reparenting without forms", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <div id="original-owner">
            <div id="composer" role="textbox" contenteditable="true" style="position:fixed;left:100px;top:100px;width:300px;height:40px">Approved text</div>
            <button id="send" type="button" aria-label="Send" style="position:fixed;left:420px;top:100px;width:80px;height:40px">Send</button>
          </div>
          <div id="other-owner">
            <div role="textbox" contenteditable="true" style="position:fixed;left:100px;top:300px;width:300px;height:40px"></div>
          </div>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.submitted = 0;
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);
  const sendBinding = await adapter.requireComposerSendButton(page, composer, "#send");
  const sendButton = sendBinding.button;
  await sendButton.evaluate((button) => {
    document.querySelector("#other-owner")?.append(button);
  });

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton,
      sendOwner: sendBinding.owner,
      sendConversationContainer: sendBinding.conversationContainer,
      sendComposerPath: sendBinding.composerPath,
      sendPath: sendBinding.sendPath,
      sendOwnerDocumentPath: sendBinding.ownerDocumentPath,
      selectors: { conversation_header: "main header h1" },
      thread: {
        platformThreadId: "safe-thread",
        displayName: "Safe thread",
        recipientVerificationLabel: "Safe thread"
      },
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "Approved text"
    }),
    { ok: false, reason: "send_button_not_owned" }
  );
  assert.equal(await page.evaluate(() => window.submitted), 0);
});

test("Instagram atomic send rejects reparenting within the same shared owner", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <div id="shared-owner">
            <div id="composer-slot">
              <div id="composer" role="textbox" contenteditable="true" style="position:fixed;left:100px;top:100px;width:300px;height:40px">Approved text</div>
            </div>
            <div id="send-slot">
              <button id="send" type="button" aria-label="Send" style="position:fixed;left:420px;top:100px;width:80px;height:40px">Send</button>
            </div>
            <div id="other-composer-slot">
              <div role="textbox" contenteditable="true" style="position:fixed;left:100px;top:300px;width:300px;height:40px"></div>
            </div>
          </div>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.submitted = 0;
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);
  const sendBinding = await adapter.requireComposerSendButton(page, composer, "#send");
  const sendButton = sendBinding.button;
  assert.equal(await sendBinding.owner.getAttribute("id"), "shared-owner");
  await sendButton.evaluate((button) => {
    document.querySelector("#other-composer-slot")?.append(button);
  });

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton,
      sendOwner: sendBinding.owner,
      sendConversationContainer: sendBinding.conversationContainer,
      sendComposerPath: sendBinding.composerPath,
      sendPath: sendBinding.sendPath,
      sendOwnerDocumentPath: sendBinding.ownerDocumentPath,
      selectors: { conversation_header: "main header h1" },
      thread: {
        platformThreadId: "safe-thread",
        displayName: "Safe thread",
        recipientVerificationLabel: "Safe thread"
      },
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "Approved text"
    }),
    { ok: false, reason: "send_button_not_owned" }
  );
  assert.equal(await page.evaluate(() => window.submitted), 0);
});

test("Instagram atomic send rejects a bound wrapper moved within the same branch", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <div id="shared-owner">
            <div id="composer-branch">
              <div id="composer" role="textbox" contenteditable="true" style="position:fixed;left:100px;top:100px;width:300px;height:40px">Approved text</div>
            </div>
            <div id="send-branch">
              <div id="send-parent">
                <button id="send" type="button" aria-label="Send" style="position:fixed;left:420px;top:100px;width:80px;height:40px">Send</button>
              </div>
              <div id="other-composer-slot">
                <div role="textbox" contenteditable="true" style="position:fixed;left:100px;top:300px;width:300px;height:40px"></div>
              </div>
            </div>
          </div>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.submitted = 0;
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);
  const sendBinding = await adapter.requireComposerSendButton(page, composer, "#send");
  assert.equal(await sendBinding.owner.getAttribute("id"), "shared-owner");
  assert.equal(await sendBinding.sendPath[0].getAttribute("id"), "send-parent");
  await page.locator("#send-parent").evaluate((wrapper) => {
    document.querySelector("#other-composer-slot")?.append(wrapper);
  });

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton: sendBinding.button,
      sendOwner: sendBinding.owner,
      sendConversationContainer: sendBinding.conversationContainer,
      sendComposerPath: sendBinding.composerPath,
      sendPath: sendBinding.sendPath,
      sendOwnerDocumentPath: sendBinding.ownerDocumentPath,
      selectors: { conversation_header: "main header h1" },
      thread: {
        platformThreadId: "safe-thread",
        displayName: "Safe thread",
        recipientVerificationLabel: "Safe thread"
      },
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "Approved text"
    }),
    { ok: false, reason: "send_button_not_owned" }
  );
  assert.equal(await page.evaluate(() => window.submitted), 0);
});

test("Instagram atomic send rejects its complete owner moved within the conversation", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(
      `Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <div id="original-slot">
            <div id="shared-owner">
              <div id="composer-branch">
                <div id="composer" role="textbox" contenteditable="true" style="position:fixed;left:100px;top:100px;width:300px;height:40px">Approved text</div>
              </div>
              <div id="send-branch">
                <div id="send-parent">
                  <button id="send" type="button" aria-label="Send" style="position:fixed;left:420px;top:100px;width:80px;height:40px">Send</button>
                </div>
              </div>
            </div>
          </div>
          <div id="other-slot">
            <div role="textbox" contenteditable="true" style="position:fixed;left:100px;top:300px;width:300px;height:40px"></div>
          </div>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.submitted = 0;
    window.wrongSubtreeClicks = 0;
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
    document.querySelector("#other-slot")?.addEventListener("click", () => {
      window.wrongSubtreeClicks += 1;
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);
  const sendBinding = await adapter.requireComposerSendButton(page, composer, "#send");
  assert.equal(await sendBinding.owner.getAttribute("id"), "shared-owner");
  await page.locator("#shared-owner").evaluate((owner) => {
    document.querySelector("#other-slot")?.append(owner);
  });

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      ...composerOwnership,
      sendButton: sendBinding.button,
      sendOwner: sendBinding.owner,
      sendConversationContainer: sendBinding.conversationContainer,
      sendComposerPath: sendBinding.composerPath,
      sendPath: sendBinding.sendPath,
      sendOwnerDocumentPath: sendBinding.ownerDocumentPath,
      selectors: { conversation_header: "main header h1" },
      thread: {
        platformThreadId: "safe-thread",
        displayName: "Safe thread",
        recipientVerificationLabel: "Safe thread"
      },
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "Approved text"
    }),
    { ok: false, reason: "composer_owner_changed_before_send" }
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      submitted: window.submitted,
      wrongSubtreeClicks: window.wrongSubtreeClicks
    })),
    { submitted: 0, wrongSubtreeClicks: 0 }
  );
});

test("Instagram sendMessage rejects composer ownership moved during its first pointer approach", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(
      `Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main>
          <header><h1>Safe thread</h1></header>
          <div id="original-slot">
            <div id="composer-owner">
              <div id="composer" role="textbox" contenteditable="true" style="position:fixed;left:100px;top:160px;width:300px;height:40px"></div>
              <button id="send" type="button" aria-label="Send" style="position:fixed;left:420px;top:160px;width:80px;height:40px">Send</button>
            </div>
          </div>
          <div id="other-slot"></div>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.moved = 0;
    window.submitted = 0;
    window.wrongClicks = 0;
    window.addEventListener(
      "mousemove",
      () => {
        const owner = document.querySelector("#composer-owner");
        const otherSlot = document.querySelector("#other-slot");
        if (owner && otherSlot && window.moved === 0) {
          window.moved = 1;
          otherSlot.append(owner);
        }
      },
      { once: true }
    );
    document.querySelector("#other-slot")?.addEventListener("click", (event) => {
      if (event.target?.closest?.("#send")) {
        window.wrongClicks += 1;
      }
    });
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
  });

  const selectors = {
    inbox_url: "https://www.instagram.com/direct/inbox/",
    thread_list: "main",
    thread_item: "[data-thread]",
    conversation_header: "header h1",
    message_container: "main",
    message_item: "[data-message]",
    message_text: "[data-text]",
    composer_input: "#composer",
    send_button: "#send"
  };
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50,
    sendVerificationTimeoutMs: 50
  });
  adapter.openExactThread = async () => "safe-thread";
  adapter.waitForNetworkMessageCapture = async () => true;
  adapter.networkMessageCaptureStatus = () => ({
    expectedThreadId: "safe-thread",
    pendingRequests: 0,
    successfulResponses: 1,
    failedRequests: 0,
    matchedThread: true,
    explicitlyEmpty: false,
    recipientVerificationLabel: "Safe thread",
    snapshots: []
  });

  await assert.rejects(
    () =>
      adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "composer_owner_changed_before_send"
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      moved: window.moved,
      wrongClicks: window.wrongClicks,
      submitted: window.submitted,
      ownerParent: document.querySelector("#composer-owner")?.parentElement?.id
    })),
    { moved: 1, wrongClicks: 0, submitted: 0, ownerParent: "other-slot" }
  );
});

test("Instagram atomic composer actions bind recipient evidence to the active composer pane", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  await page.route("https://www.instagram.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main hidden>
          <header><h1>Safe thread</h1></header>
        </main>
        <main>
          <header><h1>Wrong person</h1></header>
          <form style="display:flex;align-items:center;gap:8px">
            <div id="composer" role="textbox" contenteditable="true" style="width:300px;height:40px"></div>
            <button id="send" type="button" aria-label="Send">Send</button>
          </form>
        </main>`
    });
  });
  await page.goto("https://www.instagram.com/direct/t/safe-thread/");
  await page.evaluate(() => {
    window.submitted = 0;
    document.querySelector("#send")?.addEventListener("click", () => {
      window.submitted += 1;
    });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  const composer = await page.locator("#composer").elementHandle();
  const sendButton = await page.locator("#send").elementHandle();
  const composerOwnership = await bindAtomicComposerOwnership(adapter, composer);
  const input = {
    composer,
    ...composerOwnership,
    selectors: { conversation_header: "main header h1" },
    thread: {
      platformThreadId: "safe-thread",
      displayName: "Safe thread",
      recipientVerificationLabel: "Safe thread"
    },
    platformThreadId: "safe-thread"
  };

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      ...input,
      action: "type",
      expectedText: "",
      unit: "x"
    }),
    { ok: false, reason: "recipient_changed_before_send" }
  );
  assert.equal(await composer.textContent(), "");

  await composer.evaluate((element) => {
    element.textContent = "x";
  });
  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      ...input,
      sendButton,
      action: "send",
      expectedText: "x"
    }),
    { ok: false, reason: "recipient_changed_before_send" }
  );
  assert.equal(await page.evaluate(() => window.submitted), 0);
});

function sendTestHarness({
  observeSubmittedBubble,
  observeExactLayoutBubble = false,
  networkAcknowledgement = "none",
  preNetworkSnapshots = [],
  switchThreadBeforeClick = false,
  switchThreadDuringComposerHandle = false,
  switchThreadAfterComposerBound = false,
  switchThreadDuringComposerApproach = false,
  switchThreadAtTypeInvocation = false,
  switchThreadAfterFirstTypedUnit = false,
  switchThreadDuringHeaderReadAt = null,
  switchThreadDuringClick = false,
  switchThreadAtSendInvocation = false,
  reorderSendCandidateAfterGeometry = false,
  unrelatedNearbySubmit = false,
  dropTypedUnit = false,
  failAfterClick = false,
  submitOnTypedNewline = false,
  headerLabel = "Safe thread",
  sendButtonBox = { x: 850, y: 900, width: 80, height: 40 }
}) {
  let currentUrl = "about:blank";
  let originalNavigations = 0;
  let verificationNavigations = 0;
  let verificationPageClosed = 0;
  let submitted = false;
  let typed = "";
  const typedUnits = [];
  const composerMutations = [];
  let messageSnapshots = 0;
  let networkCaptureGeneration = 0;
  let sendCaptureGeneration = 0;
  let composerTextReads = 0;
  let headerReads = 0;
  const headerLocator = {
    getAttribute: async () => {
      headerReads += 1;
      if (headerReads === switchThreadDuringHeaderReadAt) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      return headerLabel;
    },
    textContent: async () => headerLabel
  };
  const composer = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    getAttribute: async () => null,
    click: async () => {
      composerMutations.push("click");
    },
    first: () => composer,
    boundingBox: async () => ({ x: 100, y: 900, width: 700, height: 40 }),
    inputValue: async () => {
      composerTextReads += 1;
      if (switchThreadAfterComposerBound && composerTextReads === 1) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      return typed;
    },
    textContent: async () => typed,
    fill: async (value) => {
      composerMutations.push("fill");
      typed = value;
    },
    type: async (unit) => {
      if (switchThreadAtTypeInvocation) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      composerMutations.push("type");
      typedUnits.push(unit);
      if (submitOnTypedNewline && unit === "\n") {
        submitted = true;
        typed = "";
        return;
      }
      if (dropTypedUnit && typed.length === 0) return;
      typed += unit;
      if (switchThreadAfterFirstTypedUnit && typedUnits.length === 1) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
    },
    evaluate: async (_callback, input) => {
      const action = input?.action;
      headerReads += 1;
      if (headerReads === switchThreadDuringHeaderReadAt) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      if (action === "type" && switchThreadAtTypeInvocation) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      if (action === "send" && switchThreadAtSendInvocation) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      if (currentUrl !== "https://www.instagram.com/direct/t/safe-thread/") {
        return { ok: false, reason: "thread_changed_before_send" };
      }
      if (headerLabel !== "Safe thread") {
        return { ok: false, reason: "recipient_changed_before_send" };
      }
      if (action === "focus") {
        composerMutations.push("click");
        return { ok: true };
      }
      if (action === "type") {
        if (dropTypedUnit && typed.length === 0) {
          return { ok: false, reason: "composer_text_mismatch_before_send" };
        }
        composerMutations.push("type");
        typedUnits.push(input.unit);
        typed += input.unit;
        if (switchThreadAfterFirstTypedUnit && typedUnits.length === 1) {
          currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
        }
        return { ok: true };
      }
      if (action === "send") {
        if (typed !== input.expectedText) {
          return { ok: false, reason: "composer_text_mismatch_before_send" };
        }
        if (input.sendButton?.unrelatedNearbySubmit) {
          return { ok: false, reason: "send_button_not_owned" };
        }
        if (switchThreadDuringClick) {
          currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
          throw new Error("Execution context was destroyed");
        }
        const clickedAtMs = Date.now();
        submitted = true;
        return { ok: true, clickedAtMs };
      }
      throw new Error(`Unexpected atomic action ${action}`);
    },
    evaluateHandle: async () => ({
      getProperties: async () =>
        new Map([
          ["conversationContainer", boundInitialConversationContainer],
          [
            "documentPath",
            pathProperty([
              boundInitialComposerParent,
              boundInitialOwner,
              boundInitialSlot,
              boundInitialConversationContainer,
              boundInitialBody,
              boundInitialHtml
            ])
          ]
        ]),
      dispose: async () => undefined
    }),
    elementHandle: async () => {
      if (switchThreadDuringComposerHandle) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      return composer;
    }
  };
  const bindingDisposals = [];
  const boundElement = (name) => {
    const handle = {
      asElement: () => handle,
      dispose: async () => {
        bindingDisposals.push(name);
      }
    };
    return handle;
  };
  const boundSendOwner = boundElement("owner");
  const boundConversationContainer = boundElement("conversation-container");
  const boundOriginalSlot = boundElement("original-slot");
  const boundBody = boundElement("body");
  const boundHtml = boundElement("html");
  const boundComposerBranch = boundElement("composer-branch");
  const boundSendBranch = boundElement("send-branch");
  const boundSendParent = boundElement("send-parent");
  const boundInitialComposerParent = boundElement("initial-composer-parent");
  const boundInitialOwner = boundElement("initial-owner");
  const boundInitialSlot = boundElement("initial-slot");
  const boundInitialConversationContainer = boundElement(
    "initial-conversation-container"
  );
  const boundInitialBody = boundElement("initial-body");
  const boundInitialHtml = boundElement("initial-html");
  const pathProperty = (elements) => ({
    getProperties: async () =>
      new Map(elements.map((element, index) => [String(index), element])),
    dispose: async () => undefined
  });
  const boundSendButton = {
    unrelatedNearbySubmit,
    boundingBox: async () =>
      reorderSendCandidateAfterGeometry
        ? { x: 4_000, y: 900, width: 80, height: 40 }
        : sendButtonBox,
    click: async () => {
      if (switchThreadAtSendInvocation) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
        submitted = true;
        return;
      }
      if (switchThreadDuringClick) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
        throw new Error("Element is not attached to the DOM");
      }
      submitted = true;
    },
    evaluate: async () => ({
      exactSend: !unrelatedNearbySubmit,
      sameForm: false
    }),
    evaluateHandle: async () => ({
      getProperties: async () =>
        new Map([
          ["owner", boundSendOwner],
          ["conversationContainer", boundConversationContainer],
          ["composerPath", pathProperty([boundComposerBranch])],
          ["sendPath", pathProperty([boundSendParent, boundSendBranch])],
          [
            "ownerDocumentPath",
            pathProperty([
              boundOriginalSlot,
              boundConversationContainer,
              boundBody,
              boundHtml
            ])
          ]
        ]),
      dispose: async () => undefined
    }),
    dispose: async () => {
      bindingDisposals.push("button");
    }
  };
  const sendButton = {
    count: async () => {
      if (switchThreadBeforeClick) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      return 1;
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    getAttribute: async () => null,
    boundingBox: async () => sendButtonBox,
    click: async () => {
      if (switchThreadDuringClick) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
        submitted = true;
        return;
      }
      submitted = true;
    },
    elementHandle: async () => boundSendButton
  };
  const messageContainer = {
    first: () => messageContainer,
    boundingBox: async () => ({ x: 0, y: 100, width: 1_000, height: 800 })
  };
  const page = withBrowserRuntime({
    goto: async (url) => {
      originalNavigations += 1;
      currentUrl = url;
    },
    waitForTimeout: async () => undefined,
    waitForSelector: async () => undefined,
    evaluate: async () => {
      if (messageSnapshots === 0) {
        messageSnapshots += 1;
        return { fieldNames: [], bodyText: "" };
      }
      messageSnapshots += 1;
      if (submitted && failAfterClick) {
        throw new Error("Execution context was destroyed");
      }
      return submitted && observeSubmittedBubble
        ? [{ nativeId: "new-out", nativeIdStable: true, direction: "OUT", text: typed }]
        : [];
    },
    getByText: () => ({
      count: async () => (submitted && observeExactLayoutBubble ? 1 : 0),
      isVisible: async () => true,
      boundingBox: async () => ({ x: 700, y: 700, width: 200, height: 40 })
    }),
    url: () => currentUrl,
    locator: (selector) => {
      if (selector === "header h1") return { first: () => headerLocator };
      if (selector === "main") return messageContainer;
      if (selector === "[contenteditable='true']") return composer;
      if (selector === "[aria-label='Send']") return sendButton;
      throw new Error(`Unexpected locator ${selector}`);
    },
    keyboard: {
      type: async (unit) => {
        typedUnits.push(unit);
        if (submitOnTypedNewline && unit === "\n") {
          submitted = true;
          typed = "";
          return;
        }
        if (dropTypedUnit && typed.length === 0) return;
        typed += unit;
      }
    },
    mouse: {
      move: async () => {
        if (switchThreadDuringComposerApproach) {
          currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
        }
      }
    }
  });
  const verificationPage = {
    ...page,
    goto: async (url) => {
      verificationNavigations += 1;
      currentUrl = url;
    },
    close: async () => {
      verificationPageClosed += 1;
    }
  };
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "a[href^='/direct/t/']",
      unread_badge: "[data-unread]",
      conversation_header: "header h1",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: {
      getManagedPage: async () => page,
      revealWindow: async () => undefined
    },
    personKey: "instagram",
    connectTimeoutMs: 50,
    sendVerificationTimeoutMs: 1_000
  });
  adapter.beginNetworkMessageCapture = () => {
    networkCaptureGeneration += 1;
  };
  adapter.beginNetworkSendCapture = () => {
    sendCaptureGeneration += 1;
    return sendCaptureGeneration;
  };
  adapter.commitNetworkSendClick = () => true;
  adapter.waitForNetworkSendCapture = async () => true;
  adapter.networkSendCaptureStatus = () => ({
    generation: sendCaptureGeneration,
    expectedThreadId: "safe-thread",
    clickCommitted: true,
    observedRequests: 1,
    unverifiableRequests: 0,
    matchingRequests: 1,
    pendingRequests: 0,
    failedRequests: 0,
    outboundTransportBound: true,
    offlineThreadingId: "offline-test-send",
    acknowledgedMessageId: "new-network-out",
    acknowledgedTimestampMs: new Date().toISOString()
  });
  adapter.createSendVerificationPage = async () => verificationPage;
  adapter.waitForNetworkMessageCapture = async () => {
    if (submitted && failAfterClick && networkCaptureGeneration > 1) {
      throw new Error("Network capture unavailable after submit");
    }
    return true;
  };
  adapter.networkMessageCaptureStatus = () => {
    const snapshots = [...preNetworkSnapshots];
    if (submitted && networkCaptureGeneration > 1 && networkAcknowledgement !== "none") {
      snapshots.push({
        nativeId: "new-network-out",
        nativeIdStable: true,
        offlineThreadingId: "offline-test-send",
        direction: "OUT",
        text: typed,
        sourceTimestamp:
          networkAcknowledgement === "stale"
            ? new Date(Date.now() - 60_000).toISOString()
            : new Date().toISOString()
      });
    }
    return {
      expectedThreadId: "safe-thread",
      pendingRequests: 0,
      successfulResponses: 1,
      failedRequests: 0,
      matchedThread: true,
      explicitlyEmpty: false,
      recipientVerificationLabel: headerLabel,
      snapshots
    };
  };
  return {
    adapter,
    wasSubmitted: () => submitted,
    typedUnits: () => [...typedUnits],
    composerMutations: () => [...composerMutations],
    bindingDisposals: () => [...bindingDisposals],
    originalNavigations: () => originalNavigations,
    verificationNavigations: () => verificationNavigations,
    verificationPageClosed: () => verificationPageClosed
  };
}

test("Instagram send binds an intercepted Relay mutation to authoritative two-page readback", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await browser.newContext();
  const originalPage = await context.newPage();
  let mutationCount = 0;
  let serverSent = false;
  let sentAtMs = 0;
  const preexistingAtMs = Date.now() - 10_000;
  const offlineThreadingId = "1788512400000000001";
  t.after(async () => {
    await context.close();
    await browser.close();
  });

  const threadPayload = () => ({
    data: {
      get_slide_thread_nullable: {
        as_ig_direct_thread: {
          id: "safe-thread",
          thread_title: "Safe thread",
          viewer_id: "viewer-id",
          slide_messages: {
            edges: [
              {
                node: {
                  __typename: "SlideMessage",
                  message_id: "preexisting-identical",
                  offline_threading_id: "offline-preexisting",
                  timestamp_ms: String(preexistingAtMs),
                  sender: {
                    igid: "viewer-id",
                    user_dict: { id: "viewer-id" }
                  },
                  text_body: "x"
                }
              },
              ...(serverSent
                ? [
                  {
                    node: {
                      __typename: "SlideMessage",
                      message_id: "concurrent-identical",
                      offline_threading_id: "offline-other-device",
                      timestamp_ms: String(sentAtMs),
                      sender: {
                        igid: "viewer-id",
                        user_dict: { id: "viewer-id" }
                      },
                      text_body: "x"
                    }
                  },
                  {
                    node: {
                      __typename: "SlideMessage",
                      message_id: "server-message-1",
                      offline_threading_id: offlineThreadingId,
                      timestamp_ms: String(sentAtMs),
                      sender: {
                        igid: "viewer-id",
                        user_dict: { id: "viewer-id" }
                      },
                      text_body: "x"
                    }
                  }
                ]
                : [])
            ]
          }
        }
      }
    }
  });
  const sendBody = instagramTextSendRequestBody({
    offline_threading_id: offlineThreadingId,
    text: { sensitive_string_value: "x" }
  });
  const detailBody = new URLSearchParams({
    fb_api_req_friendly_name: "IGDThreadDetailQuery",
    doc_id: "thread-detail-fixture",
    variables: JSON.stringify({ thread_id: "safe-thread" })
  }).toString();
  const html = `<!doctype html>
    <style>
      main { display: block; width: 1000px; height: 800px; }
      header { height: 80px; }
      .composer-row { display: flex; align-items: center; width: 900px; height: 60px; }
      [contenteditable='true'] { display: block; width: 700px; height: 40px; }
      button { display: block; width: 80px; height: 40px; }
    </style>
    <main>
      <header><h1 title="Safe thread">Safe thread</h1></header>
      <div class="composer-row">
        <div id="composer" role="textbox" contenteditable="true"></div>
        <button id="send" type="button" aria-label="Send">Send</button>
      </div>
    </main>
    <script>
      fetch("/api/graphql/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: ${JSON.stringify(detailBody)}
      });
      document.querySelector("#send").addEventListener("click", () => {
        fetch("/api/graphql/", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: ${JSON.stringify(sendBody)}
        });
      });
    </script>`;

  await context.route("https://www.instagram.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/^\/direct\/t\/safe-thread\/?$/.test(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
      return;
    }
    if (/\/api\/graphql\/?$/.test(url.pathname)) {
      const fields = new URLSearchParams(request.postData() ?? "");
      if (fields.get("fb_api_req_friendly_name") === "IGDirectTextSendMutation") {
        mutationCount += 1;
        sentAtMs = Date.now();
        serverSent = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              xig_direct_text_send_with_slide_messaging_response: {
                message_id: "server-message-1",
                timestamp_ms: String(sentAtMs),
                id: "relay-node-id"
              }
            }
          })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(threadPayload())
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" });
  });

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({
      inbox_url: "https://www.instagram.com/direct/inbox/",
      thread_list: "main",
      thread_item: "a[href^='/direct/t/']",
      unread_badge: "[data-unread]",
      conversation_header: "header h1",
      message_container: "main",
      message_item: "[data-message]",
      message_text: "[data-text]",
      composer_input: "[contenteditable='true']",
      send_button: "[aria-label='Send']"
    }),
    sessionManager: {
      getManagedPage: async () => originalPage,
      revealWindow: async () => undefined
    },
    personKey: "instagram",
    connectTimeoutMs: 50,
    sendVerificationTimeoutMs: 15_000
  });

  const receipt = await adapter.sendMessage(
    {
      platformThreadId: "safe-thread",
      displayName: "Safe thread",
      recipientVerificationLabel: "Safe thread"
    },
    "x"
  );
  assert.equal(mutationCount, 1);
  assert.equal(receipt.verifiedBy, "platform_acknowledged");
  assert.equal(
    receipt.platformMessageKey,
    normalizeInstagramMessageSnapshots("safe-thread", [
      {
        nativeId: "server-message-1",
        nativeIdStable: true,
        offlineThreadingId,
        direction: "OUT",
        text: "x",
        sourceTimestamp: String(sentAtMs)
      }
    ])[0].platformMessageKey
  );
  assert.equal(context.pages().length, 1);
});

test("Instagram send capture fails closed on an aborted Relay mutation", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    await browser.close();
  });
  const body = instagramTextSendRequestBody({
    offline_threading_id: "offline-aborted",
    text: { sensitive_string_value: "approved" }
  });
  await context.route("https://www.instagram.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (/^\/send-capture-fixture\/?$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><script>
          window.sendFixture = () => fetch("/api/graphql/", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: ${JSON.stringify(body)}
          }).catch(() => null);
        </script>`
      });
      return;
    }
    if (/\/api\/graphql\/?$/.test(url.pathname)) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ status: 404, body: "" });
  });
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  await adapter.getPage();
  await page.goto("https://www.instagram.com/send-capture-fixture");
  await page.setContent("<!doctype html>");
  await page.evaluate((requestBody) => {
    window.sendFixture = () =>
      fetch("/api/graphql/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: requestBody
      }).catch(() => null);
  }, body);
  const generation = adapter.beginNetworkSendCapture(page, "safe-thread", "approved");
  const clickedAtMs = Date.now();
  await page.evaluate(() => window.sendFixture());
  assert.equal(adapter.commitNetworkSendClick(page, generation, clickedAtMs), true);
  assert.equal(await adapter.waitForNetworkSendCapture(page, 1_000), false);
  const capture = adapter.networkSendCaptureStatus(page);
  assert.equal(capture.observedRequests, 1);
  assert.equal(capture.unverifiableRequests, 1);
  assert.equal(capture.matchingRequests, 0);
  assert.equal(capture.outboundTransportBound, false);
  assert.equal(capture.acknowledgedMessageId, null);
});

test("Instagram adapter reports success only after a fresh stable network acknowledgement", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: true,
    networkAcknowledgement: "fresh"
  });
  const receipt = await harness.adapter.sendMessage(
    {
      platformThreadId: "safe-thread",
      displayName: "Safe thread",
      recipientVerificationLabel: "Safe thread"
    },
    "x"
  );

  assert.equal(harness.wasSubmitted(), true);
  assert.equal(harness.originalNavigations(), 1);
  assert.equal(harness.verificationNavigations() > 0, true);
  assert.equal(harness.verificationPageClosed(), 1);
  assert.equal(receipt.verifiedBy, "platform_acknowledged");
  assert.equal(
    receipt.platformMessageKey,
    normalizeInstagramMessageSnapshots("safe-thread", [
      {
        nativeId: "new-network-out",
        nativeIdStable: true,
        direction: "OUT",
        text: "x",
        sourceTimestamp: new Date().toISOString()
      }
    ])[0].platformMessageKey
  );
  assert.deepEqual(
    harness.bindingDisposals().sort(),
    [
      "body",
      "button",
      "composer-branch",
      "conversation-container",
      "html",
      "initial-body",
      "initial-composer-parent",
      "initial-conversation-container",
      "initial-html",
      "initial-owner",
      "initial-slot",
      "original-slot",
      "owner",
      "send-branch",
      "send-parent"
    ].sort()
  );
});

test("Instagram refuses a physical send without a platform-authoritative recipient label", async () => {
  const harness = sendTestHarness({ observeSubmittedBubble: true });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        { platformThreadId: "safe-thread", displayName: "User-edited name" },
        "x"
      ),
    (error) => error?.details?.reason === "recipient_unverified_before_send"
  );
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram refuses a stale recipient label before mutating the external composer", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: true,
    headerLabel: "Different recipient"
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "recipient_changed_before_send"
  );
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram adapter fails when submission produces no outgoing bubble", async () => {
  const harness = sendTestHarness({ observeSubmittedBubble: false });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) =>
      error?.kind === "THREAD_FETCH_FAILED" &&
      error?.details?.reason === "delivery_uncertain_after_submit"
  );
  assert.equal(harness.wasSubmitted(), true);
});

test("Instagram treats an optimistic DOM bubble without a stable platform acknowledgement as uncertain", async () => {
  const harness = sendTestHarness({ observeSubmittedBubble: true });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "delivery_uncertain_after_submit"
  );
  assert.equal(harness.wasSubmitted(), true);
});

test("Instagram rejects a new stable message whose platform timestamp predates dispatch", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: true,
    networkAcknowledgement: "stale"
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "delivery_uncertain_after_submit"
  );
  assert.equal(harness.wasSubmitted(), true);
});

test("partial pre-send history cannot turn an old identical DOM message into acknowledgement", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: true,
    preNetworkSnapshots: [
      {
        nativeId: "known-different-message",
        nativeIdStable: true,
        direction: "OUT",
        text: "Different",
        sourceTimestamp: "2026-08-24T07:00:00.000Z"
      }
    ]
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "delivery_uncertain_after_submit"
  );
  assert.equal(harness.wasSubmitted(), true);
});

test("Instagram rejects multiline text before typing can trigger an Enter-key send", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    submitOnTypedNewline: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "first line\nsecond line"
      ),
    (error) =>
      error?.kind === "THREAD_FETCH_FAILED" &&
      error?.details?.reason === "multiline_message_not_supported"
  );
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram treats an exact new outgoing layout bubble without server evidence as uncertain", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    observeExactLayoutBubble: true
  });
  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "delivery_uncertain_after_submit"
  );

  assert.equal(harness.wasSubmitted(), true);
});

test("Instagram revalidates the exact thread after typing and before clicking Send", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadBeforeClick: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.equal(harness.wasSubmitted(), false);
  assert.deepEqual(
    harness.bindingDisposals().sort(),
    [
      "body",
      "button",
      "composer-branch",
      "conversation-container",
      "html",
      "initial-body",
      "initial-composer-parent",
      "initial-conversation-container",
      "initial-html",
      "initial-owner",
      "initial-slot",
      "original-slot",
      "owner",
      "send-branch",
      "send-parent"
    ].sort()
  );
});

test("Instagram does not mutate a composer when navigation occurs while binding it", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadDuringComposerHandle: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved private text"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.composerMutations(), []);
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram revalidates after binding and before the first composer mutation", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadAfterComposerBound: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved private text"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.composerMutations(), []);
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram revalidates after the composer pointer approach before clicking", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadDuringComposerApproach: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved private text"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.composerMutations(), []);
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram catches navigation during the composer recipient-header check", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadDuringHeaderReadAt: 4
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved private text"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.composerMutations(), []);
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram stops bound typing when the active thread changes", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadAfterFirstTypedUnit: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "private"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.typedUnits(), ["p"]);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram cannot type after the route changes at the mutation boundary", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadAtTypeInvocation: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "private"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.typedUnits(), []);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram catches navigation during a mid-typing recipient-header check", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadDuringHeaderReadAt: 7
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "private"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.typedUnits(), ["p"]);
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram never treats a lone distant submit as the composer Send button", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    sendButtonBox: { x: 850, y: 0, width: 80, height: 40 }
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "send_button_not_unique"
  );
  assert.equal(harness.wasSubmitted(), false);
  assert.deepEqual(
    harness.bindingDisposals().sort(),
    [
      "body",
      "button",
      "composer-branch",
      "conversation-container",
      "html",
      "initial-body",
      "initial-composer-parent",
      "initial-conversation-container",
      "initial-html",
      "initial-owner",
      "initial-slot",
      "original-slot",
      "owner",
      "send-branch",
      "send-parent"
    ].sort()
  );
});

test("Instagram rejects a same-row Send control far from the composer", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    sendButtonBox: { x: 4_000, y: 900, width: 80, height: 40 }
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "send_button_not_unique"
  );
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram rejects a nearby unrelated submit beside the composer", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    unrelatedNearbySubmit: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "send_button_not_unique"
  );
  assert.equal(harness.wasSubmitted(), false);
  assert.deepEqual(
    harness.bindingDisposals().sort(),
    [
      "button",
      "initial-body",
      "initial-composer-parent",
      "initial-conversation-container",
      "initial-html",
      "initial-owner",
      "initial-slot"
    ].sort()
  );
});

test("Instagram measures and clicks the same bound Send handle", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    reorderSendCandidateAfterGeometry: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "send_button_not_unique"
  );
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram refuses to click Send when the composer lost approved text", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    dropTypedUnit: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "composer_text_mismatch_before_send"
  );
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram binds Send to the verified document instead of re-resolving after navigation", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadDuringClick: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "delivery_uncertain_after_submit"
  );
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram cannot submit after the route changes at the click boundary", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadAtSendInvocation: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.equal(harness.wasSubmitted(), false);
});

test("Instagram catches navigation during the final recipient-header check", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    switchThreadDuringHeaderReadAt: 7
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "x"
      ),
    (error) => error?.details?.reason === "thread_changed_before_send"
  );
  assert.deepEqual(harness.typedUnits(), ["x"]);
  assert.equal(harness.wasSubmitted(), false);
});

test("every Instagram failure after the Send click is delivery uncertain", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    failAfterClick: true
  });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        {
          platformThreadId: "safe-thread",
          displayName: "Safe thread",
          recipientVerificationLabel: "Safe thread"
        },
        "approved"
      ),
    (error) => error?.details?.reason === "delivery_uncertain_after_submit"
  );
  assert.equal(harness.wasSubmitted(), true);
});

test("Instagram thread snapshots reject conflicting URL and record identities", () => {
  assert.throws(
    () =>
      normalizeInstagramThreadSnapshots([
        {
          href: "https://www.instagram.com/direct/t/thread-b/",
          stableId: "thread-a",
          displayName: "Safe thread"
        }
      ]),
    (error) =>
      error instanceof InstagramParsingError &&
      error.reason === "thread_identity_mismatch"
  );
});

function instagramTextSendRequestBody(overrides = {}) {
  return new URLSearchParams({
    fb_api_req_friendly_name: "IGDirectTextSendMutation",
    doc_id: "26911679871773184",
    variables: JSON.stringify({
      ig_thread_igid: "safe-thread",
      offline_threading_id: "offline-1",
      recipient_igids: null,
      text: { sensitive_string_value: "approved" },
      ...overrides
    })
  }).toString();
}

test("Instagram text-send mutation parsing requires the exact current Relay contract", () => {
  const request = extractInstagramTextSendMutationRequest({
    url: "https://www.instagram.com/api/graphql/",
    method: "POST",
    postData: instagramTextSendRequestBody(),
    expectedThreadId: "safe-thread",
    expectedText: "approved"
  });
  assert.deepEqual(request, { offlineThreadingId: "offline-1" });

  assert.equal(
    extractInstagramTextSendMutationRequest({
      url: "https://www.instagram.com/api/graphql/",
      method: "POST",
      postData: instagramTextSendRequestBody({ ig_thread_igid: "wrong-thread" }),
      expectedThreadId: "safe-thread",
      expectedText: "approved"
    }),
    null
  );
  const wrongOperation = new URLSearchParams(instagramTextSendRequestBody());
  wrongOperation.set("fb_api_req_friendly_name", "IGDirectReactionSendMutation");
  assert.equal(
    extractInstagramTextSendMutationRequest({
      url: "https://www.instagram.com/api/graphql/",
      method: "POST",
      postData: wrongOperation.toString(),
      expectedThreadId: "safe-thread",
      expectedText: "approved"
    }),
    null
  );

  assert.deepEqual(
    extractInstagramTextSendMutationResponse({
      data: {
        xig_direct_text_send_with_slide_messaging_response: {
          message_id: "server-message-1",
          timestamp_ms: "1788512400000",
          id: "relay-node-id"
        }
      }
    }),
    { messageId: "server-message-1", timestampMs: "1788512400000" }
  );
  assert.equal(
    extractInstagramTextSendMutationResponse({
      data: {
        xig_direct_text_send_with_slide_messaging_response: {
          timestamp_ms: "1788512400000",
          id: "relay-node-id"
        }
      }
    }),
    null
  );
});

test("Instagram send capture excludes pre-click requests and fails closed on duplicates", () => {
  const capture = new InstagramNetworkSendCapture();
  const generation = capture.begin("safe-thread", "approved");
  const preClick = capture.stageRequest({
    generation,
    url: "https://www.instagram.com/api/graphql/",
    method: "POST",
    postData: instagramTextSendRequestBody({ offline_threading_id: "before-click" }),
    requestStartedAtMs: 999
  });
  const postClick = capture.stageRequest({
    generation,
    url: "https://www.instagram.com/api/graphql/",
    method: "POST",
    postData: instagramTextSendRequestBody({ offline_threading_id: "after-click" }),
    requestStartedAtMs: 1_001
  });
  assert.ok(preClick);
  assert.ok(postClick);
  capture.settleRequest(preClick, true, {
    data: {
      xig_direct_text_send_with_slide_messaging_response: {
        message_id: "unrelated-before-click"
      }
    }
  });
  capture.settleRequest(postClick, true, {
    data: {
      xig_direct_text_send_with_slide_messaging_response: {
        message_id: "server-message-1"
      }
    }
  });
  assert.equal(capture.commitClick(generation, 1_000), true);
  assert.deepEqual(capture.status(), {
    generation,
    expectedThreadId: "safe-thread",
    clickCommitted: true,
    observedRequests: 2,
    unverifiableRequests: 0,
    matchingRequests: 1,
    pendingRequests: 0,
    failedRequests: 0,
    outboundTransportBound: true,
    offlineThreadingId: "after-click",
    acknowledgedMessageId: "server-message-1"
  });

  const duplicate = capture.stageRequest({
    generation,
    url: "https://www.instagram.com/api/graphql/",
    method: "POST",
    postData: instagramTextSendRequestBody({ offline_threading_id: "duplicate" }),
    requestStartedAtMs: 1_002
  });
  assert.ok(duplicate);
  capture.settleRequest(duplicate, true, {
    data: {
      xig_direct_text_send_with_slide_messaging_response: {
        message_id: "server-message-2"
      }
    }
  });
  assert.equal(capture.status().matchingRequests, 2);
  assert.equal(capture.status().acknowledgedMessageId, null);
});

test("Instagram send capture waits through a quiet window and rejects a late duplicate", async () => {
  const capture = new InstagramNetworkSendCapture();
  const generation = capture.begin("safe-thread", "approved");
  const first = capture.stageRequest({
    generation,
    url: "https://www.instagram.com/api/graphql/",
    method: "POST",
    postData: instagramTextSendRequestBody({ offline_threading_id: "first" }),
    requestStartedAtMs: 1_001
  });
  assert.ok(first);
  capture.settleRequest(first, true, {
    data: {
      xig_direct_text_send_with_slide_messaging_response: {
        message_id: "server-message-1"
      }
    }
  });
  assert.equal(capture.commitClick(generation, 1_000), true);

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: { getManagedPage: async () => ({}) },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.networkSendCaptureStatus = () => capture.status();
  const page = {
    waitForTimeout: async (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs))
  };
  setTimeout(() => {
    const duplicate = capture.stageRequest({
      generation,
      url: "https://www.instagram.com/api/graphql/",
      method: "POST",
      postData: instagramTextSendRequestBody({ offline_threading_id: "late-duplicate" }),
      requestStartedAtMs: 1_002
    });
    assert.ok(duplicate);
    capture.settleRequest(duplicate, true, {
      data: {
        xig_direct_text_send_with_slide_messaging_response: {
          message_id: "server-message-2"
        }
      }
    });
  }, 50);

  assert.equal(await adapter.waitForNetworkSendCapture(page, 700), false);
  assert.equal(capture.status().matchingRequests, 2);
});

test("Instagram send capture rejects a mixed unverifiable exact request", async () => {
  const capture = new InstagramNetworkSendCapture();
  const generation = capture.begin("safe-thread", "approved");
  const unknown = capture.stageRequest({
    generation,
    url: "https://www.instagram.com/api/graphql/",
    method: "POST",
    postData: instagramTextSendRequestBody({ offline_threading_id: "unknown" }),
    requestStartedAtMs: 0
  });
  const timed = capture.stageRequest({
    generation,
    url: "https://www.instagram.com/api/graphql/",
    method: "POST",
    postData: instagramTextSendRequestBody({ offline_threading_id: "timed" }),
    requestStartedAtMs: 1_001
  });
  assert.ok(unknown);
  assert.ok(timed);
  capture.settleRequest(timed, true, {
    data: {
      xig_direct_text_send_with_slide_messaging_response: {
        message_id: "server-message-1"
      }
    }
  });
  assert.equal(capture.commitClick(generation, 1_000), true);
  assert.equal(capture.status().matchingRequests, 1);
  assert.equal(capture.status().unverifiableRequests, 1);
  assert.equal(capture.status().outboundTransportBound, true);

  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: { getManagedPage: async () => ({}) },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.networkSendCaptureStatus = () => capture.status();
  const page = {
    waitForTimeout: async (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs))
  };
  assert.equal(await adapter.waitForNetworkSendCapture(page, 350), false);
});

test("Instagram realtime send parsing binds the exact offline token in an embedded DGW payload", () => {
  const payload = JSON.stringify({
    action: "send_item",
    client_context: "offline-realtime-1",
    commands: null,
    device_id: "device",
    item_type: "text",
    mentioned_user_ids: null,
    mentions: null,
    mutation_token: "offline-realtime-1",
    reply_to_message_id: null,
    text: "approved",
    thread_id: "safe-thread"
  });
  const frame = Buffer.concat([
    Buffer.from([0x19, 0x02, 0x00, 0x7f]),
    Buffer.from(payload),
    Buffer.from([0x00, 0x04])
  ]);
  assert.deepEqual(
    extractInstagramRealtimeTextSend({
      frame,
      expectedThreadId: "safe-thread",
      expectedText: "approved"
    }),
    { offlineThreadingId: "offline-realtime-1" }
  );
  assert.equal(
    extractInstagramRealtimeTextSend({
      frame,
      expectedThreadId: "wrong-thread",
      expectedText: "approved"
    }),
    null
  );

  const capture = new InstagramNetworkSendCapture();
  const generation = capture.begin("safe-thread", "approved");
  assert.ok(
    capture.stageRealtimeFrame({
      generation,
      frame,
      frameSentAtMs: 1_001
    })
  );
  assert.equal(capture.commitClick(generation, 1_000), true);
  assert.deepEqual(capture.status(), {
    generation,
    expectedThreadId: "safe-thread",
    clickCommitted: true,
    observedRequests: 1,
    unverifiableRequests: 0,
    matchingRequests: 1,
    pendingRequests: 0,
    failedRequests: 0,
    outboundTransportBound: true,
    offlineThreadingId: "offline-realtime-1",
    acknowledgedMessageId: null
  });
});

test("Instagram realtime capture stays page-keyed across interleaved WebSocket sends", () => {
  const eventTarget = () => {
    const listeners = new Map();
    return {
      on(event, listener) {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
      },
      emit(event, payload) {
        for (const listener of listeners.get(event) ?? []) {
          listener(payload);
        }
      }
    };
  };
  const originalPage = eventTarget();
  const decoyPage = eventTarget();
  const originalSocket = eventTarget();
  const decoySocket = eventTarget();
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: {},
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.ensureNetworkThreadCapture(originalPage);
  adapter.ensureNetworkThreadCapture(decoyPage);
  originalPage.emit("websocket", originalSocket);
  decoyPage.emit("websocket", decoySocket);
  const frame = (offlineThreadingId) =>
    JSON.stringify({
      action: "send_item",
      client_context: offlineThreadingId,
      commands: null,
      device_id: "device",
      item_type: "text",
      mentioned_user_ids: null,
      mentions: null,
      mutation_token: offlineThreadingId,
      reply_to_message_id: null,
      text: "approved",
      thread_id: "safe-thread"
    });
  const generation = adapter.beginNetworkSendCapture(
    originalPage,
    "safe-thread",
    "approved"
  );
  const clickedAtMs = Date.now();
  decoySocket.emit("framesent", { payload: frame("offline-decoy") });
  originalSocket.emit("framesent", { payload: frame("offline-original") });
  assert.equal(
    adapter.commitNetworkSendClick(originalPage, generation, clickedAtMs),
    true
  );
  assert.deepEqual(adapter.networkSendCaptureStatus(originalPage), {
    generation,
    expectedThreadId: "safe-thread",
    clickCommitted: true,
    observedRequests: 1,
    unverifiableRequests: 0,
    matchingRequests: 1,
    pendingRequests: 0,
    failedRequests: 0,
    outboundTransportBound: true,
    offlineThreadingId: "offline-original",
    acknowledgedMessageId: null
  });
});

test("Instagram GraphQL capture isolates generations without promoting later partial responses", () => {
  const capture = new InstagramNetworkThreadCapture();
  const firstGeneration = capture.begin();
  capture.accept(firstGeneration, [
    { stableId: "old-1" },
    { stableId: "old-2" }
  ]);

  const secondGeneration = capture.begin();
  capture.accept(firstGeneration, [{ stableId: "stale-late" }]);
  assert.deepEqual(capture.current(10), []);

  capture.accept(secondGeneration, [
    { stableId: "current-1" },
    { stableId: "current-2" }
  ]);
  capture.accept(secondGeneration, [{ stableId: "newest" }]);

  assert.deepEqual(
    capture.current(2).map((snapshot) => snapshot.stableId),
    ["current-1", "current-2"]
  );
});

test("Instagram message capture merges stable ids and lets later responses replace the same message", () => {
  const capture = new InstagramNetworkMessageCapture();
  const generation = capture.begin("safe-thread");
  const firstRequest = capture.startRequest(generation);
  const laterRequest = capture.startRequest(generation);

  capture.accept(
    generation,
    {
      matchedThread: true,
      explicitlyEmpty: false,
      recipientVerificationLabel: "Safe thread",
      snapshots: [
        {
          nativeId: "shared",
          nativeIdStable: true,
          direction: "OUT",
          text: "Original",
          sourceTimestamp: "1700000001000"
        },
        {
          nativeId: "recent-only",
          nativeIdStable: true,
          direction: "IN",
          text: "Recent",
          sourceTimestamp: "1700000002000"
        }
      ]
    },
    firstRequest
  );
  capture.accept(
    generation,
    {
      matchedThread: true,
      explicitlyEmpty: false,
      recipientVerificationLabel: "Safe thread",
      snapshots: [
        {
          nativeId: "older-only",
          nativeIdStable: true,
          direction: "IN",
          text: "Older",
          sourceTimestamp: "1700000000000"
        },
        {
          nativeId: "shared",
          nativeIdStable: true,
          direction: "OUT",
          text: "Edited",
          sourceTimestamp: "1700000001000"
        }
      ]
    },
    laterRequest
  );
  capture.finishRequest(generation, true);
  capture.finishRequest(generation, true);

  const status = capture.status();
  assert.equal(status.matchedThread, true);
  assert.equal(status.explicitlyEmpty, false);
  assert.equal(status.failedRequests, 0);
  assert.deepEqual(
    status.snapshots.map((snapshot) => [snapshot.nativeId, snapshot.text]),
    [
      ["older-only", "Older"],
      ["shared", "Edited"],
      ["recent-only", "Recent"]
    ]
  );
});

test("Instagram message capture never promotes an empty page to an authoritative empty transcript", () => {
  const capture = new InstagramNetworkMessageCapture();
  const generation = capture.begin("safe-thread");
  const request = capture.startRequest(generation);
  capture.accept(
    generation,
    {
      matchedThread: true,
      explicitlyEmpty: true,
      recipientVerificationLabel: "Safe thread",
      snapshots: []
    },
    request
  );
  capture.finishRequest(generation, true);

  assert.deepEqual(capture.status().snapshots, []);
  assert.equal(capture.status().explicitlyEmpty, false);
});

test("Instagram message capture readiness rejects a matched response when any request failed", async () => {
  const adapter = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => ({}),
    sessionManager: { getManagedPage: async () => ({}) },
    personKey: "instagram",
    connectTimeoutMs: 50
  });
  adapter.networkMessageCaptureStatus = () => ({
    expectedThreadId: "safe-thread",
    pendingRequests: 0,
    successfulResponses: 1,
    failedRequests: 1,
    matchedThread: true,
    explicitlyEmpty: false,
    recipientVerificationLabel: "Safe thread",
    snapshots: []
  });

  const ready = await adapter.waitForNetworkMessageCapture(
    { waitForTimeout: async () => new Promise((resolve) => setTimeout(resolve, 1)) },
    5
  );
  assert.equal(ready, false);
});

test("Instagram GraphQL capture preserves request order when responses complete out of order", () => {
  const capture = new InstagramNetworkThreadCapture();
  const generation = capture.begin();
  const currentInboxOrder = capture.reserveRequestOrder(generation);
  const olderPageOrder = capture.reserveRequestOrder(generation);

  capture.accept(generation, [{ stableId: "older-page" }], olderPageOrder ?? undefined);
  capture.accept(
    generation,
    [{ stableId: "recent-a" }, { stableId: "recent-b" }],
    currentInboxOrder ?? undefined
  );

  assert.deepEqual(
    capture.current(2).map((snapshot) => snapshot.stableId),
    ["recent-a", "recent-b"]
  );
});

test("Instagram GraphQL capture promotes an overlapping current-page thread when its response finishes last", () => {
  const capture = new InstagramNetworkThreadCapture();
  const generation = capture.begin();
  const currentInboxOrder = capture.reserveRequestOrder(generation);
  const olderPageOrder = capture.reserveRequestOrder(generation);

  capture.accept(
    generation,
    [{ stableId: "shared", displayName: "Older result", unread: false }],
    olderPageOrder ?? undefined
  );
  capture.accept(
    generation,
    [
      { stableId: "shared", displayName: "Current result", unread: true },
      { stableId: "current-only" }
    ],
    currentInboxOrder ?? undefined
  );

  assert.deepEqual(capture.current(1), [
    { stableId: "shared", displayName: "Current result", unread: true }
  ]);
});

test("Instagram GraphQL capture cannot let a later older-page response erase current unread evidence", () => {
  const capture = new InstagramNetworkThreadCapture();
  const generation = capture.begin();
  const currentInboxOrder = capture.reserveRequestOrder(generation);
  const olderPageOrder = capture.reserveRequestOrder(generation);

  capture.accept(
    generation,
    [{ stableId: "shared", displayName: "Current result", unread: true }],
    currentInboxOrder ?? undefined
  );
  capture.accept(
    generation,
    [{ stableId: "shared", displayName: "Older result", unread: false }],
    olderPageOrder ?? undefined
  );

  assert.deepEqual(capture.current(1), [
    { stableId: "shared", displayName: "Current result", unread: true }
  ]);
});

test("Instagram GraphQL capture exposes pending and failed network evidence per generation", () => {
  const capture = new InstagramNetworkThreadCapture();
  const firstGeneration = capture.begin();
  const firstOrder = capture.startRequest(firstGeneration);
  assert.equal(firstOrder, 0);
  assert.deepEqual(capture.status(), {
    pendingRequests: 1,
    successfulResponses: 0,
    failedRequests: 0
  });
  capture.finishRequest(firstGeneration, false);
  assert.deepEqual(capture.status(), {
    pendingRequests: 0,
    successfulResponses: 0,
    failedRequests: 1
  });

  const secondGeneration = capture.begin();
  const secondOrder = capture.startRequest(secondGeneration);
  capture.accept(
    secondGeneration,
    [{ stableId: "safe-thread" }],
    secondOrder ?? undefined
  );
  capture.finishRequest(secondGeneration, true);
  assert.deepEqual(capture.status(), {
    pendingRequests: 0,
    successfulResponses: 1,
    failedRequests: 0
  });
});

test("Instagram selector diagnostics never capture content-bearing artifacts", () => {
  assert.equal(shouldCaptureSelectorArtifacts("INSTAGRAM"), false);
  assert.equal(shouldProbeSelectorTestConversation("INSTAGRAM"), false);
  assert.equal(shouldCaptureSelectorArtifacts("LINKEDIN"), true);
  assert.equal(shouldProbeSelectorTestConversation("LINKEDIN"), true);
});

test("Instagram selector diagnostics fail explicitly instead of reporting false selector counts", async () => {
  const service = createSelectorTestService({
    resolveSelectors: async () => {
      throw new Error("Instagram diagnostics must not evaluate DOM selectors");
    },
    sessionManager: {},
    screenshotDir: "/tmp",
    domDumpDir: "/tmp"
  });

  await assert.rejects(
    () => service.run({ platform: "INSTAGRAM" }),
    (error) =>
      error?.statusCode === 409 &&
      error?.payload?.reason === "instagram_selector_diagnostics_unavailable"
  );
});
