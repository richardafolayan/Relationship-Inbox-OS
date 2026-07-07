import test from "node:test";
import assert from "node:assert/strict";
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
