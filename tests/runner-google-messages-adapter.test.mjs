import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GoogleMessagesAdapter,
  googleMessagesDirection,
  googleMessagesReactions,
  googleMessagesSenderName,
  googleMessagesThreadId,
  googleMessagesTimestamp
} from "../apps/runner/dist/platforms/google-messages-adapter.js";

function googlePage({ failAttachmentStage = false } = {}) {
  const calls = { sendClicks: 0, stagedFiles: [], clearedFiles: 0 };
  const locator = (selector) => {
    const target = {
      first: () => target,
      async count() {
        return selector.includes("message") ? 0 : 1;
      },
      async setInputFiles(files) {
        if (Array.isArray(files) && files.length === 0) {
          calls.clearedFiles += 1;
          return;
        }
        if (failAttachmentStage) throw new Error("attachment staging failed");
        calls.stagedFiles.push(...files);
      },
      async fill() {},
      async click() {
        if (selector === "send-button") calls.sendClicks += 1;
      },
      async waitFor() {}
    };
    return target;
  };
  return {
    calls,
    page: {
      async goto() {},
      async waitForSelector() {},
      async evaluate() {
        return { connected: true, signIn: false };
      },
      locator,
      async waitForFunction() {
        return true;
      },
      keyboard: { async type() {} },
      url: () => "https://messages.google.com/web/conversations/thread-1"
    }
  };
}

function googleAdapter(page) {
  return new GoogleMessagesAdapter({
    screenshotDir: "/private/tmp/tovi-google-screenshots",
    domDumpDir: "/private/tmp/tovi-google-dom",
    mediaDir: "/private/tmp/tovi-google-media",
    resolveSelectors: async () => ({
      inbox_url: "https://messages.google.com/web",
      thread_item: "thread-item",
      message_container: "message-container",
      message_item: "message-item",
      composer_input: "composer-input",
      send_button: "send-button",
      unread_badge: "unread-badge"
    }),
    sessionManager: {
      async getManagedPage() {
        return page;
      }
    }
  });
}

test("Google Messages conversation URLs produce stable thread ids", () => {
  assert.equal(
    googleMessagesThreadId("https://messages.google.com/web/conversations/abc%2B123?hl=en"),
    "abc+123"
  );
  assert.equal(googleMessagesThreadId("fallback-id"), "fallback-id");
});

test("Google Messages group sender names come from inbound accessibility labels", () => {
  assert.equal(googleMessagesSenderName("Maya: Are we still meeting?", "IN"), "Maya");
  assert.equal(googleMessagesSenderName("You: Yes", "OUT"), undefined);
});

test("Google Messages reactions preserve emoji and operator direction", () => {
  assert.deepEqual(googleMessagesReactions(["You reacted 👍", "Maya reacted ❤️"]), [
    { emoji: "👍", kind: "reaction", direction: "OUT" },
    { emoji: "❤️", kind: "reaction", direction: "IN" }
  ]);
});

test("Google Messages outgoing bubbles are distinguished from incoming bubbles", () => {
  assert.equal(googleMessagesDirection({ className: "message outgoing" }), "OUT");
  assert.equal(googleMessagesDirection({ ariaLabel: "You: See you soon" }), "OUT");
  assert.equal(googleMessagesDirection({ dataDirection: "incoming" }), "IN");
});

test("Google Messages timestamps normalize safely", () => {
  assert.equal(googleMessagesTimestamp("2026-07-15T10:30:00Z"), "2026-07-15T10:30:00.000Z");
  assert.equal(googleMessagesTimestamp("not a date"), undefined);
  assert.equal(googleMessagesTimestamp(undefined), undefined);
});

test("Google Messages selectors and media assets ship in the Windows package", async () => {
  const selectors = JSON.parse(await readFile(new URL("../packages/core/selectors/google-messages.json", import.meta.url), "utf8"));
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(selectors.inbox_url, /^https:\/\/messages\.google\.com\/web/);
  assert.ok(selectors.thread_item);
  assert.ok(selectors.message_item);
  assert.ok(selectors.composer_input);
  assert.ok(packageJson.build.files.includes("packages/core/selectors/**/*"));
});

test("Google Messages attachment staging failures happen before dispatch authorization", async () => {
  const fake = googlePage({ failAttachmentStage: true });
  let authorizations = 0;
  await assert.rejects(
    googleAdapter(fake.page).sendMessage(
      {
        platformThreadId: "thread-1",
        displayName: "Test Person",
        lastMessagePreview: "",
        threadUrl: "https://messages.google.com/web/conversations/thread-1"
      },
      "",
      [{ absolutePath: "/private/tmp/photo.jpg", displayName: "photo.jpg" }],
      async () => {
        authorizations += 1;
      }
    ),
    /attachment staging failed/
  );

  assert.equal(authorizations, 0);
  assert.equal(fake.calls.sendClicks, 0);
});

test("Google Messages clears staged input when final authorization refuses dispatch", async () => {
  const fake = googlePage();
  await assert.rejects(
    googleAdapter(fake.page).sendMessage(
      {
        platformThreadId: "thread-1",
        displayName: "Test Person",
        lastMessagePreview: "",
        threadUrl: "https://messages.google.com/web/conversations/thread-1"
      },
      "hello",
      [{ absolutePath: "/private/tmp/photo.jpg", displayName: "photo.jpg" }],
      async () => {
        throw new Error("dispatch superseded");
      }
    ),
    /dispatch superseded/
  );

  assert.deepEqual(fake.calls.stagedFiles, ["/private/tmp/photo.jpg"]);
  assert.equal(fake.calls.clearedFiles, 1);
  assert.equal(fake.calls.sendClicks, 0);
});
