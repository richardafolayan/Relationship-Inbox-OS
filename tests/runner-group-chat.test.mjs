import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildChatSendScript } from "../apps/runner/dist/platforms/imessage-send.js";
import {
  formatMessageForPrompt,
  groupChatContext,
  prismaMessageToPrompt
} from "../apps/runner/dist/services/ai.js";

// Pilot R-0086 (#753): group chat build-out. Three layers pinned here:
// the AppleScript group send, per-sender transcript attribution in AI
// prompts, and the group-context prompt block.

// ---------------------------------------------------------------------------
// Group send script.
// ---------------------------------------------------------------------------

test("buildChatSendScript addresses the chat guid, not a buddy", () => {
  const script = buildChatSendScript({
    chatGuid: "iMessage;+;chat812634005967812345",
    text: "Padel is on for Saturday"
  });
  assert.match(script, /chat id "iMessage;\+;chat812634005967812345"/);
  assert.match(script, /send "Padel is on for Saturday" to targetChat/);
  assert.doesNotMatch(script, /buddy/);
});

test("buildChatSendScript escapes quotes and backslashes in text and guid", () => {
  const script = buildChatSendScript({
    chatGuid: 'weird"guid\\x',
    text: 'She said "9pm" \\ maybe'
  });
  assert.match(script, /chat id "weird\\"guid\\\\x"/);
  assert.match(script, /send "She said \\"9pm\\" \\\\ maybe"/);
});

// ---------------------------------------------------------------------------
// Per-sender transcript attribution.
// ---------------------------------------------------------------------------

test("an IN message with a real senderName is attributed to that sender", () => {
  const line = formatMessageForPrompt(
    { direction: "IN", text: "I can host on Friday", timestamp: "2026-07-05T10:00:00Z", senderName: "Tobi" },
    "Games Club"
  );
  assert.match(line, /^Tobi \(2026-07-05T10:00:00Z\): I can host on Friday$/);
});

test("placeholder senderNames fall back to the thread contact label", () => {
  for (const senderName of ["+447700900123", "someone@example.com", "  ", "Ada, Tobi"]) {
    const line = formatMessageForPrompt(
      { direction: "IN", text: "hey", timestamp: "t", senderName },
      "Games Club"
    );
    assert.match(line, /^Games Club \(t\): hey$/, `senderName=${senderName}`);
  }
});

test("1:1 messages without senderName behave exactly as before", () => {
  const inLine = formatMessageForPrompt(
    { direction: "IN", text: "hey", timestamp: "t" },
    "Lanre"
  );
  assert.equal(inLine, "Lanre (t): hey");
  const outLine = formatMessageForPrompt(
    { direction: "OUT", text: "yo", timestamp: "t", senderName: "ShouldNeverShow" },
    "Lanre"
  );
  assert.equal(outLine, "operator (t): yo");
});

test("prismaMessageToPrompt carries senderName through", () => {
  const shaped = prismaMessageToPrompt({
    direction: "IN",
    text: "hello",
    timestamp: new Date("2026-07-05T10:00:00Z"),
    senderName: "Ada"
  });
  assert.equal(shaped.senderName, "Ada");
  const withoutSender = prismaMessageToPrompt({
    direction: "IN",
    text: "hello",
    timestamp: new Date("2026-07-05T10:00:00Z")
  });
  assert.equal(withoutSender.senderName, null);
});

// ---------------------------------------------------------------------------
// Group prompt context.
// ---------------------------------------------------------------------------

test("groupChatContext is empty for 1:1 threads (prompts stay byte-identical)", () => {
  assert.equal(groupChatContext({ isGroup: false, displayName: "Lanre" }), "");
  assert.equal(groupChatContext({}), "");
});

test("groupChatContext names the group and pins the strict rules", () => {
  const block = groupChatContext({ isGroup: true, groupName: "Games Club", displayName: "Ada, Tobi" });
  assert.match(block, /GROUP CHAT \(strict\)/);
  assert.match(block, /GROUP CHAT \(Games Club\)/);
  assert.match(block, /NEVER attribute one participant's words to another/);
  assert.match(block, /"Recipient" here means the whole group/);
  // Falls back to the participant-list displayName when un-named.
  const unnamed = groupChatContext({ isGroup: true, groupName: null, displayName: "Ada, Tobi" });
  assert.match(unnamed, /GROUP CHAT \(Ada, Tobi\)/);
});

// ---------------------------------------------------------------------------
// Wiring: the adapter routes group sends and blocks group attachments; the
// prompts inject the block wherever the recipient context is injected.
// ---------------------------------------------------------------------------

test("adapter routes group sends through the chat-guid path", () => {
  const adapterSource = readFileSync(
    fileURLToPath(new URL("../apps/runner/src/platforms/imessage-adapter.ts", import.meta.url)),
    "utf8"
  );
  assert.doesNotMatch(adapterSource, /GROUP_SEND_UNSUPPORTED/);
  assert.match(adapterSource, /GROUP_ATTACHMENT_UNSUPPORTED/);
  assert.match(adapterSource, /sendToGroupChat\(chat\.guid, thread, text, beforeDispatch\)/);
  assert.match(adapterSource, /sendIMessageToChat\(\{ chatGuid, text, beforeDispatch \}\)/);
});

test("every recipient-context prompt site also injects groupChatContext", () => {
  const aiSource = readFileSync(
    fileURLToPath(new URL("../apps/runner/src/services/ai.ts", import.meta.url)),
    "utf8"
  );
  const nameSites = aiSource.match(/\$\{contactNameContext\(input\.displayName\)\}/g) ?? [];
  const groupSites = aiSource.match(/\$\{groupChatContext\(input\)\}/g) ?? [];
  assert.equal(groupSites.length, nameSites.length, "groupChatContext must travel with contactNameContext");
});
