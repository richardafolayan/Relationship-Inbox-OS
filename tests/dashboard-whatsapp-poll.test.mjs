import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getWhatsAppPoll } from "../apps/dashboard/lib/whatsapp-poll.ts";

const baseMessage = (over = {}) => ({
  id: "m1",
  platformMessageKey: "wa-m1",
  direction: "IN",
  timestamp: "2026-07-07T10:00:00.000Z",
  text: "",
  senderName: null,
  sentVia: null,
  raw: null,
  attachments: [],
  ...over
});

test("getWhatsAppPoll reads structured poll metadata", () => {
  const poll = getWhatsAppPoll(baseMessage({
    raw: {
      whatsapp: {
        poll: {
          question: "Dinner?",
          options: [{ name: "Pizza" }, { name: "Sushi" }],
          allowMultipleAnswers: false
        }
      }
    }
  }));

  assert.deepEqual(poll, {
    question: "Dinner?",
    options: [{ name: "Pizza" }, { name: "Sushi" }],
    allowMultipleAnswers: false
  });
});

test("getWhatsAppPoll falls back to old flattened poll text", () => {
  const poll = getWhatsAppPoll(baseMessage({
    text: "📊 Poll (multi-select): Pick days\n• Tuesday\n• Wednesday",
    attachments: [{ type: "poll", manualReview: false, kind: "poll" }]
  }));

  assert.deepEqual(poll, {
    question: "Pick days",
    options: [{ name: "Tuesday" }, { name: "Wednesday" }],
    allowMultipleAnswers: true
  });
});

test("poll question and options use an isolated, valid themed surface", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/components/thread/whatsapp-poll.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /border-hairline bg-paper p-3 text-ink/);
  assert.match(source, /border-hairline bg-paper-2 text-ink/);
  assert.doesNotMatch(source, /bg-paper\/60/);
});

// --- #818 (R-0100): per-option vote tallies ---

const vote = (over = {}) => ({
  voterId: "447111222333@c.us",
  voterName: "Cynthia",
  isMe: false,
  selectedOptions: ["Yes"],
  votedAt: "2026-07-11T07:50:00.000Z",
  ...over
});

test("aggregatePollVotes folds votes per option in poll order", async () => {
  const { aggregatePollVotes } = await import("../apps/dashboard/lib/whatsapp-poll.ts");
  const tallies = aggregatePollVotes(
    ["Yes", "No"],
    [
      vote(),
      vote({ voterId: "me@c.us", voterName: null, isMe: true, selectedOptions: ["Yes", "No"] })
    ]
  );
  assert.deepEqual(tallies, [
    { name: "Yes", count: 2, voters: ["Cynthia", "You"] },
    { name: "No", count: 1, voters: ["You"] }
  ]);
});

test("aggregatePollVotes: retracted votes count nowhere, unknown options ignored, JID fallback", async () => {
  const { aggregatePollVotes } = await import("../apps/dashboard/lib/whatsapp-poll.ts");
  const tallies = aggregatePollVotes(
    ["Yes", "No"],
    [
      vote({ selectedOptions: [] }), // retracted
      vote({ voterName: null, selectedOptions: ["Maybe"] }), // option not in poll
      vote({ voterId: "447999888777@c.us", voterName: null, selectedOptions: ["No"] })
    ]
  );
  assert.deepEqual(tallies, [
    { name: "Yes", count: 0, voters: [] },
    { name: "No", count: 1, voters: ["447999888777@c.us"] }
  ]);
});
