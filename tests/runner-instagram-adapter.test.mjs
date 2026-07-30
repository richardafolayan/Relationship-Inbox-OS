import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalInstagramThreadUrl,
  classifyInstagramAuthRequirement,
  findNewVerifiedInstagramOutgoing,
  instagramAuthRequiredFromSignals,
  instagramThreadIdFromUrl,
  InstagramAdapter,
  InstagramParsingError,
  instagramThreadUrlMatches,
  normalizeInstagramMessageSnapshots,
  normalizeInstagramThreadSnapshots,
  parseInstagramSourceTimestamp
} from "../apps/runner/dist/platforms/instagram-adapter.js";
import { assertInstagramManualTextSend } from "../apps/runner/dist/services/send.js";
import {
  shouldCaptureSelectorArtifacts,
  shouldProbeSelectorTestConversation
} from "../apps/runner/dist/services/selector-tests.js";

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
  const authenticatedPage = {
    goto: async () => undefined,
    bringToFront: async () => {
      broughtToFront += 1;
    },
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async () => ({ fieldNames: [], bodyText: "" }),
    url: () => "https://www.instagram.com/direct/inbox/"
  };
  const authenticated = new InstagramAdapter({
    screenshotDir: "/tmp",
    domDumpDir: "/tmp",
    resolveSelectors: async () => selectors,
    sessionManager: { getManagedPage: async () => authenticatedPage },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await authenticated.connectInteractively();
  assert.equal(broughtToFront, 1);

  const loginPage = {
    ...authenticatedPage,
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

test("selector parsing failures are classified without inventing thread identity", async () => {
  let evaluateCalls = 0;
  const page = {
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForFunction: async () => undefined,
    url: () => "https://www.instagram.com/direct/inbox/",
    evaluate: async () => {
      evaluateCalls += 1;
      return evaluateCalls === 1
        ? { fieldNames: [], bodyText: "" }
        : [{ displayName: "Mutable name", preview: "Private preview", unread: true }];
    }
  };
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
    return {
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
    };
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
        displayName: "Safe thread"
      }),
    (error) =>
      error?.kind === "THREAD_NOT_FOUND" &&
      error?.details?.reason === "opened_recipient_mismatch"
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
      direction: "OUT",
      text: "Hi",
      sourceTimestamp: "5m"
    }
  ]);

  assert.equal(messages[0].direction, "IN");
  assert.equal(messages[0].timestamp, "2026-07-30T09:10:11.000Z");
  assert.equal(messages[0].raw.timestampSource, "source");
  assert.equal(messages[1].direction, "OUT");
  assert.equal(messages[1].timestamp, undefined);
  assert.equal(messages[1].raw.timestampSource, "first_seen");
  assert.equal(parseInstagramSourceTimestamp("Yesterday"), undefined);
});

test("unsupported Instagram content becomes safe placeholders", () => {
  const messages = normalizeInstagramMessageSnapshots("thread-2", [
    { direction: "IN", mediaKind: "photo" },
    { direction: "OUT", mediaKind: "video", text: "Caption" },
    { direction: "IN", mediaKind: "voice_message" },
    { direction: "OUT", deleted: true, text: "Message was deleted" }
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
    { direction: "IN", text: "Same text" },
    { direction: "IN", text: "Same text" },
    { nativeId: "native-3", direction: "OUT", text: "Reply" },
    { nativeId: "native-3", direction: "OUT", text: "Reply" }
  ];
  const first = normalizeInstagramMessageSnapshots("thread-3", snapshots);
  const second = normalizeInstagramMessageSnapshots("thread-3", snapshots);

  assert.deepEqual(
    first.map((message) => message.platformMessageKey),
    second.map((message) => message.platformMessageKey)
  );
  assert.equal(first.length, 3);
  assert.notEqual(first[0].platformMessageKey, first[1].platformMessageKey);
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
    { nativeId: "old", direction: "OUT", text: "Approved smoke message" }
  ]);
  const unchanged = normalizeInstagramMessageSnapshots("thread-5", [
    { nativeId: "old", direction: "OUT", text: "Approved smoke message" }
  ]);
  const submitted = normalizeInstagramMessageSnapshots("thread-5", [
    { nativeId: "old", direction: "OUT", text: "Approved smoke message" },
    { nativeId: "new", direction: "OUT", text: "Approved smoke message" }
  ]);
  const wrongDirection = normalizeInstagramMessageSnapshots("thread-5", [
    { nativeId: "old", direction: "OUT", text: "Approved smoke message" },
    { nativeId: "new", direction: "IN", text: "Approved smoke message" }
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
    "instagram:new"
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
    isEnabled: async () => false,
    getAttribute: async () => null
  };
  const page = {
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForSelector: async () => undefined,
    evaluate: async () => {
      evaluateCalls += 1;
      return evaluateCalls === 1 ? { fieldNames: [], bodyText: "" } : [];
    },
    url: () => "https://www.instagram.com/direct/t/safe-thread/",
    locator: (selector) =>
      selector === "header h1"
        ? { first: () => headerLocator }
        : disabledComposer
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
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50
  });

  await assert.rejects(
    () =>
      adapter.sendMessage(
        { platformThreadId: "safe-thread", displayName: "Safe thread" },
        "Approved text"
      ),
    (error) =>
      error?.kind === "THREAD_FETCH_FAILED" &&
      error?.details?.reason === "composer_disabled"
  );
});

function sendTestHarness({ observeSubmittedBubble }) {
  let currentUrl = "about:blank";
  let submitted = false;
  let typed = "";
  let messageSnapshots = 0;
  const headerLocator = {
    getAttribute: async () => "Safe thread",
    textContent: async () => "Safe thread"
  };
  const composer = {
    count: async () => 1,
    isEnabled: async () => true,
    getAttribute: async () => null,
    click: async () => undefined
  };
  const sendButton = {
    count: async () => 1,
    isEnabled: async () => true,
    getAttribute: async () => null,
    click: async () => {
      submitted = true;
    }
  };
  const page = {
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
      return submitted && observeSubmittedBubble
        ? [{ nativeId: "new-out", direction: "OUT", text: typed }]
        : [];
    },
    url: () => currentUrl,
    locator: (selector) => {
      if (selector === "header h1") return { first: () => headerLocator };
      if (selector === "[contenteditable='true']") return composer;
      if (selector === "[aria-label='Send']") return sendButton;
      throw new Error(`Unexpected locator ${selector}`);
    },
    keyboard: {
      type: async (unit) => {
        typed += unit;
      }
    },
    mouse: {
      move: async () => undefined
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
    sessionManager: { getManagedPage: async () => page },
    personKey: "instagram",
    connectTimeoutMs: 50,
    sendVerificationTimeoutMs: 5
  });
  return { adapter, wasSubmitted: () => submitted };
}

test("Instagram adapter reports success only after an exact new outgoing bubble", async () => {
  const harness = sendTestHarness({ observeSubmittedBubble: true });
  const receipt = await harness.adapter.sendMessage(
    { platformThreadId: "safe-thread", displayName: "Safe thread" },
    "x"
  );

  assert.equal(harness.wasSubmitted(), true);
  assert.equal(receipt.verifiedBy, "bubble_detected");
  assert.equal(receipt.platformMessageKey, "instagram:new-out");
});

test("Instagram adapter fails when submission produces no outgoing bubble", async () => {
  const harness = sendTestHarness({ observeSubmittedBubble: false });

  await assert.rejects(
    () =>
      harness.adapter.sendMessage(
        { platformThreadId: "safe-thread", displayName: "Safe thread" },
        "x"
      ),
    (error) =>
      error?.kind === "THREAD_FETCH_FAILED" &&
      error?.details?.reason === "submitted_message_not_observed"
  );
  assert.equal(harness.wasSubmitted(), true);
});

test("Instagram selector diagnostics never capture content-bearing artifacts", () => {
  assert.equal(shouldCaptureSelectorArtifacts("INSTAGRAM"), false);
  assert.equal(shouldProbeSelectorTestConversation("INSTAGRAM"), false);
  assert.equal(shouldCaptureSelectorArtifacts("LINKEDIN"), true);
  assert.equal(shouldProbeSelectorTestConversation("LINKEDIN"), true);
});
