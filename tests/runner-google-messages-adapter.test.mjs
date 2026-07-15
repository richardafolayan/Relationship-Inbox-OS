import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  googleMessagesDirection,
  googleMessagesReactions,
  googleMessagesSenderName,
  googleMessagesThreadId,
  googleMessagesTimestamp
} from "../apps/runner/dist/platforms/google-messages-adapter.js";

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
