import test from "node:test";
import assert from "node:assert/strict";
import { classifyAutomatedGuids } from "../apps/runner/dist/scripts/purge-automated-imessage.js";

// chat.db `chat.style` for a group conversation.
const GROUP_STYLE = 43;
// `chat.style` for a 1:1 conversation.
const DM_STYLE = 45;

test("group chats (style 43) with synthetic chatNNN ids are never classified automated", () => {
  const rows = [
    { guid: "g-1", chatIdentifier: "chat123", style: GROUP_STYLE },
    { guid: "g-2", chatIdentifier: "chat123456", style: GROUP_STYLE },
    // Even a group whose identifier happens to look like a short-code is exempt.
    { guid: "g-3", chatIdentifier: "12345", style: GROUP_STYLE }
  ];

  const automated = classifyAutomatedGuids(rows);

  assert.equal(automated.has("g-1"), false);
  assert.equal(automated.has("g-2"), false);
  assert.equal(automated.has("g-3"), false);
  assert.equal(automated.size, 0);
});

test("genuine automated 1:1 senders are still classified", () => {
  const rows = [
    { guid: "a-1", chatIdentifier: "StripeLink", style: DM_STYLE },
    { guid: "a-2", chatIdentifier: "giffgaff", style: DM_STYLE },
    { guid: "a-3", chatIdentifier: "12345", style: DM_STYLE },
    // Null style (unknown) must still be classified for a 1:1-looking sender.
    { guid: "a-4", chatIdentifier: "Anster", style: null }
  ];

  const automated = classifyAutomatedGuids(rows);

  assert.equal(automated.has("a-1"), true);
  assert.equal(automated.has("a-2"), true);
  assert.equal(automated.has("a-3"), true);
  assert.equal(automated.has("a-4"), true);
});

test("real 1:1 people (email, full phone) are never classified", () => {
  const rows = [
    { guid: "p-1", chatIdentifier: "someone@example.com", style: DM_STYLE },
    { guid: "p-2", chatIdentifier: "+447951711949", style: DM_STYLE },
    { guid: "p-3", chatIdentifier: "5551234567", style: DM_STYLE },
    // Defensive: a null identifier must not be classified.
    { guid: "p-4", chatIdentifier: null, style: DM_STYLE }
  ];

  const automated = classifyAutomatedGuids(rows);

  assert.equal(automated.size, 0);
});

test("a mixed batch only flags the automated 1:1s, never the group", () => {
  const rows = [
    { guid: "keep-group", chatIdentifier: "chat42", style: GROUP_STYLE },
    { guid: "keep-person", chatIdentifier: "friend@example.com", style: DM_STYLE },
    { guid: "drop-service", chatIdentifier: "StripeLink", style: DM_STYLE }
  ];

  const automated = classifyAutomatedGuids(rows);

  assert.deepEqual([...automated], ["drop-service"]);
});
