import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "patchright";
import {
  canonicalInstagramThreadUrl,
  classifyInstagramAuthRequirement,
  classifyInstagramThreadCollectionError,
  extractInstagramThreadSnapshotsFromPayload,
  findNewVerifiedInstagramOutgoing,
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
  assert.equal(findNewVerifiedInstagramOutgoing(before, after, "Reply"), null);
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

test("send verification requires a new exact outgoing bubble", () => {
  const before = normalizeInstagramMessageSnapshots("thread-5", [
    { nativeId: "old", nativeIdStable: true, direction: "OUT", text: "Approved smoke message" }
  ]);
  const unchanged = normalizeInstagramMessageSnapshots("thread-5", [
    { nativeId: "old", nativeIdStable: true, direction: "OUT", text: "Approved smoke message" }
  ]);
  const submitted = normalizeInstagramMessageSnapshots("thread-5", [
    { nativeId: "old", nativeIdStable: true, direction: "OUT", text: "Approved smoke message" },
    { nativeId: "new", nativeIdStable: true, direction: "OUT", text: "Approved smoke message" }
  ]);
  const wrongDirection = normalizeInstagramMessageSnapshots("thread-5", [
    { nativeId: "old", nativeIdStable: true, direction: "OUT", text: "Approved smoke message" },
    { nativeId: "new", nativeIdStable: true, direction: "IN", text: "Approved smoke message" }
  ]);

  assert.equal(
    findNewVerifiedInstagramOutgoing(before, unchanged, "Approved smoke message"),
    null
  );
  assert.equal(
    findNewVerifiedInstagramOutgoing(before, wrongDirection, "Approved smoke message"),
    null
  );
  assert.equal(
    findNewVerifiedInstagramOutgoing(before, submitted, "Approved smoke message")
      ?.platformMessageKey,
    submitted[1].platformMessageKey
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

  const resolvedSend = await adapter.requireComposerSendButton(page, composer, "#send");
  assert.equal(await resolvedSend.getAttribute("id"), "send");
  await assert.rejects(
    () => adapter.requireComposerSendButton(page, composer, "#unrelated"),
    (error) => error?.reason === "send_button_not_unique"
  );

  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
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
      sendButton: unrelated,
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
      sendButton,
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
  assert.deepEqual(
    await adapter.runAtomicComposerAction({
      composer,
      sendButton,
      selectors,
      thread,
      platformThreadId: "safe-thread",
      action: "send",
      expectedText: "hi"
    }),
    { ok: true }
  );
  assert.equal(await page.evaluate(() => window.submitted), 1);
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
  const input = {
    composer,
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
  let submitted = false;
  let typed = "";
  const typedUnits = [];
  const composerMutations = [];
  let messageSnapshots = 0;
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
        submitted = true;
        return { ok: true };
      }
      throw new Error(`Unexpected atomic action ${action}`);
    },
    elementHandle: async () => {
      if (switchThreadDuringComposerHandle) {
        currentUrl = "https://www.instagram.com/direct/t/wrong-thread/";
      }
      return composer;
    }
  };
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
    })
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
    sendVerificationTimeoutMs: 5
  });
  return {
    adapter,
    wasSubmitted: () => submitted,
    typedUnits: () => [...typedUnits],
    composerMutations: () => [...composerMutations]
  };
}

test("Instagram adapter reports success only after an exact new outgoing bubble", async () => {
  const harness = sendTestHarness({ observeSubmittedBubble: true });
  const receipt = await harness.adapter.sendMessage(
    {
      platformThreadId: "safe-thread",
      displayName: "Safe thread",
      recipientVerificationLabel: "Safe thread"
    },
    "x"
  );

  assert.equal(harness.wasSubmitted(), true);
  assert.equal(receipt.verifiedBy, "bubble_detected");
  assert.equal(
    receipt.platformMessageKey,
    normalizeInstagramMessageSnapshots("safe-thread", [
      { nativeId: "new-out", nativeIdStable: true, direction: "OUT", text: "x" }
    ])[0].platformMessageKey
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

test("Instagram adapter verifies an exact new outgoing layout bubble", async () => {
  const harness = sendTestHarness({
    observeSubmittedBubble: false,
    observeExactLayoutBubble: true
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
  assert.equal(receipt.verifiedBy, "bubble_detected");
  assert.equal(receipt.raw?.verification, "exact_outgoing_layout_bubble");
  assert.equal(
    receipt.platformMessageKey,
    instagramMessageFallbackKey("safe-thread", "OUT", "x", undefined, 0)
  );
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
    switchThreadDuringHeaderReadAt: 6
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
    switchThreadDuringHeaderReadAt: 6
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
